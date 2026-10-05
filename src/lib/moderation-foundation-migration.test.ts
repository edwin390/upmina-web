import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Guardas estáticas de la foundation inmutable. La consulta de rol original NO bloquea
// admin_roles; 9K-2 añade ese límite y tests SQL ejecutables por separado.

const MIGRATION_PATH = resolve(
  __dirname,
  "../../supabase/migrations/20261007120000_moderation_foundation.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("migración 20261007120000_moderation_foundation.sql — alcance", () => {
  it("no toca ninguna tabla existente (community_posts, admin_roles, cosplay_*, etc.)", () => {
    expect(code).not.toMatch(
      /alter table public\.(community_posts|community_post_media|community_post_likes|admin_roles|cosplay_\w+|media_assets|profiles)\b/i,
    );
  });

  it("no borra ninguna tabla ni función existente", () => {
    expect(code).not.toMatch(/drop table/i);
    expect(code).not.toMatch(/drop function/i);
  });

  it("no contiene secretos ni JWT", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(sql).not.toMatch(/service_role_key|sk_live|BEGIN (RSA|PRIVATE)/i);
  });
});

describe("community_post_reports — modelo del reporte", () => {
  it("crea la tabla con las columnas mínimas del modelo (reporter/contenido/razón/detalle/fecha/estado)", () => {
    expect(code).toMatch(/create table public\.community_post_reports/);
    expect(code).toMatch(/reporter_user_id\s+uuid not null/);
    expect(code).toMatch(/post_id\s+uuid not null/);
    expect(code).toMatch(/reason\s+text not null/);
    expect(code).toMatch(/detail\s+text/);
    expect(code).toMatch(/status\s+text not null default 'open'/);
  });

  it("sin FK a community_posts/auth.users (debe sobrevivir al borrado duro del post o la cuenta)", () => {
    const tableBlock = code.slice(
      code.indexOf("create table public.community_post_reports"),
      code.indexOf("comment on table public.community_post_reports"),
    );
    expect(tableBlock).not.toMatch(/references/i);
  });

  it("reason es una lista cerrada", () => {
    expect(code).toMatch(
      /check \(reason in \('spam', 'harassment', 'hate_speech', 'sexual_content', 'other'\)\)/,
    );
  });

  it("status tiene un ciclo de vida cerrado: open/reviewing/resolved/dismissed", () => {
    expect(code).toMatch(
      /check \(status in \('open', 'reviewing', 'resolved', 'dismissed'\)\)/,
    );
  });

  it("RLS activado y FORZADO, sin policies, solo SELECT para service_role (mutación exclusiva vía RPC)", () => {
    expect(code).toMatch(
      /alter table public\.community_post_reports enable row level security/,
    );
    expect(code).toMatch(
      /alter table public\.community_post_reports force row level security/,
    );
    expect(code).not.toMatch(/create policy[\s\S]*community_post_reports/i);
    expect(code).toMatch(
      /grant select on table public\.community_post_reports to service_role/,
    );
  });
});

describe("moderation_audit_log — auditoría append-only e inmutable", () => {
  it("crea la tabla genérica (target_type/target_id, no solo reportes) con actor/action/metadata/timestamp", () => {
    expect(code).toMatch(/create table public\.moderation_audit_log/);
    expect(code).toMatch(/actor_user_id\s+uuid not null/);
    expect(code).toMatch(/target_type\s+text not null/);
    expect(code).toMatch(/target_id\s+uuid not null/);
    expect(code).toMatch(/action\s+text not null/);
    expect(code).toMatch(/metadata\s+jsonb not null default '\{\}'::jsonb/);
  });

  it("inmutable: triggers bloquean UPDATE/DELETE/TRUNCATE (mismo patrón que cosplay_admin_audit_log)", () => {
    expect(code).toMatch(/moderation_audit_log_no_update_delete/);
    expect(code).toMatch(/moderation_audit_log_no_truncate/);
    expect(code).toMatch(/raise exception 'moderation_audit_log_immutable'/);
  });

  it("ningún rol de API la toca directamente, ni siquiera service_role (solo las RPC definer)", () => {
    expect(code).toMatch(
      /revoke all privileges on table public\.moderation_audit_log from service_role/,
    );
  });
});

describe("community_post_report_create — cualquier usuario autenticado reporta", () => {
  it("valida reason/post existente/longitud de detail antes de insertar", () => {
    expect(code).toMatch(/raise exception 'invalid_reason'/);
    expect(code).toMatch(/raise exception 'post_not_found'/);
    expect(code).toMatch(/raise exception 'detail_too_long'/);
  });

  it("SOLO service_role puede ejecutarla (nunca anon/authenticated) — la autorización real es requireAuthenticated en TypeScript", () => {
    expect(code).toMatch(
      /revoke execute on function public\.community_post_report_create\(uuid, uuid, text, text\)\s+from anon/,
    );
    expect(code).toMatch(
      /revoke execute on function public\.community_post_report_create\(uuid, uuid, text, text\)\s+from authenticated/,
    );
    expect(code).toMatch(
      /grant execute on function public\.community_post_report_create\(uuid, uuid, text, text\)\s+to service_role/,
    );
  });
});

describe("community_post_report_set_status — solo admin/moderator/developer", () => {
  it("re-verifica el rol del actor contra admin_roles sin lock de autoridad en 9K-1", () => {
    expect(code).toMatch(
      /if not exists \(\s*select 1 from public\.admin_roles\s*where user_id = p_actor_user_id and role in \('admin', 'moderator', 'developer'\)/,
    );
    expect(code).toMatch(/raise exception 'actor_not_moderator'/);
  });

  it("valida el status objetivo contra el ciclo de vida cerrado", () => {
    expect(code).toMatch(/raise exception 'invalid_status'/);
  });

  it("bloquea la fila (for update) antes de mutarla y falla si no existe", () => {
    expect(code).toMatch(
      /for update;\s*\n\s*if not found then\s*\n\s*raise exception 'report_not_found'/,
    );
  });

  it("audita CADA transición en moderation_audit_log con from_status/to_status", () => {
    expect(code).toMatch(
      /insert into public\.moderation_audit_log[\s\S]*'report_status_changed'[\s\S]*from_status[\s\S]*to_status/,
    );
  });

  it("SOLO service_role puede ejecutarla", () => {
    expect(code).toMatch(
      /grant execute on function public\.community_post_report_set_status\(uuid, uuid, text, text\)\s+to service_role/,
    );
  });
});
