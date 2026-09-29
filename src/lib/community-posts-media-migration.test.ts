import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo enfoque que community-username-foundation-migration.test.ts: sin Postgres real en este
// entorno de test, se verifica ESTÁTICAMENTE el contenido de la migración 9J-1C. No sustituye
// aplicarla en Supabase y comprobar RLS/grants/constraints con datos reales (ya hecho por separado
// contra Upmina Testing).

const MIGRATION_PATH = resolve(
  __dirname,
  "../../supabase/migrations/20261004120000_community_posts_media.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("migración 20261004120000_community_posts_media.sql — alcance de tablas", () => {
  it("crea exactamente community_posts y community_post_media (ninguna otra tabla)", () => {
    const created = [...code.matchAll(/create table\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect(created.sort()).toEqual(["community_post_media", "community_posts"]);
  });

  it("no borra ni recrea ninguna tabla existente (cosplay_*, profiles, admin_*, media_assets)", () => {
    expect(code).not.toMatch(/drop table/i);
  });

  it("el único ALTER TABLE sobre una tabla PREEXISTENTE es media_assets (domain), nada más", () => {
    const created = new Set(
      [...code.matchAll(/create table\s+public\.(\w+)/gi)].map((m) => m[1]),
    );
    const altered = [...code.matchAll(/alter table\s+public\.(\w+)/gi)].map((m) => m[1]);
    // ALTER TABLE también aparece para las dos tablas NUEVAS (enable/force row level security) —
    // eso no cuenta como "tocar una tabla preexistente", así que se excluyen aquí.
    const alteredPreexisting = new Set(altered.filter((name) => !created.has(name)));
    expect(alteredPreexisting).toEqual(new Set(["media_assets"]));
  });

  it("no toca cosplay_posts, cosplay_post_images, profiles, admin_roles ni social_*", () => {
    expect(code).not.toMatch(
      /alter table public\.(cosplay_\w+|profiles|admin_\w+|social_\w+)/i,
    );
  });

  it("no contiene secretos ni JWT", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(sql).not.toMatch(/service_role_key|sk_live|BEGIN (RSA|PRIVATE)/i);
  });
});

describe("community_posts — esquema y seguridad", () => {
  it("author_user_id referencia auth.users con ON DELETE CASCADE", () => {
    expect(code).toMatch(
      /author_user_id\s+uuid not null references auth\.users\(id\) on delete cascade/,
    );
  });

  it("status está restringido a published/hidden y version >= 1", () => {
    expect(code).toMatch(
      /community_posts_status_check check \(status in \('published', 'hidden'\)\)/,
    );
    expect(code).toMatch(/community_posts_version_check check \(version >= 1\)/);
  });

  it("text es nullable con longitud 1-2000 y no-solo-espacios cuando no es NULL", () => {
    expect(code).toMatch(
      /community_posts_text_length check \(text is null or char_length\(text\) between 1 and 2000\)/,
    );
    expect(code).toMatch(
      /community_posts_text_not_blank check \(text is null or btrim\(text\) <> ''\)/,
    );
  });

  it("RLS habilitado y FORZADO, sin ninguna policy, grants solo para service_role", () => {
    expect(code).toMatch(/alter table public\.community_posts enable row level security/);
    expect(code).toMatch(/alter table public\.community_posts force row level security/);
    expect(code).not.toMatch(/create policy.*community_posts/is);
    expect(code).toMatch(
      /grant select, insert, update, delete on table public\.community_posts to service_role/,
    );
    expect(code).toMatch(
      /revoke all on table public\.community_posts from (public|anon|authenticated)/,
    );
  });

  it("ninguna policy en TODA la migración (ni community_post_media)", () => {
    expect(code).not.toMatch(/create policy/i);
  });
});

describe("community_post_media — esquema y seguridad", () => {
  it("post_id ON DELETE CASCADE, asset_id ON DELETE RESTRICT y UNIQUE", () => {
    expect(code).toMatch(
      /post_id\s+uuid not null references public\.community_posts\(id\) on delete cascade/,
    );
    expect(code).toMatch(
      /asset_id\s+uuid not null references public\.media_assets\(id\) on delete restrict/,
    );
    expect(code).toMatch(/community_post_media_asset_unique unique \(asset_id\)/);
  });

  it("UNIQUE(post_id, position) es DEFERRABLE INITIALLY IMMEDIATE (soporta reordenar en la misma transacción)", () => {
    expect(code).toMatch(
      /community_post_media_position_unique\s*\n?\s*unique \(post_id, position\) deferrable initially immediate/,
    );
  });

  it("sin columnas editoriales (alt_es/caption_es/is_cover) — a diferencia de cosplay_post_images", () => {
    // Se busca la DEFINICIÓN de columna real (nombre + tipo), no menciones en prosa dentro de un
    // comentario explicativo (este archivo SÍ menciona "alt/caption/is_cover" en un COMMENT ON
    // para explicar la diferencia con Cosplay — eso no es una columna).
    expect(code).not.toMatch(/\balt_es\s+text\b/);
    expect(code).not.toMatch(/\bcaption_es\s+text\b/);
    expect(code).not.toMatch(/\bis_cover\s+boolean\b/);
  });

  it("RLS habilitado y FORZADO, grants solo para service_role", () => {
    expect(code).toMatch(
      /alter table public\.community_post_media enable row level security/,
    );
    expect(code).toMatch(
      /alter table public\.community_post_media force row level security/,
    );
    expect(code).toMatch(
      /grant select, insert, update, delete on table public\.community_post_media to service_role/,
    );
  });
});

describe("media_assets.domain — ensanchado a cosplay + community", () => {
  it("elimina el CHECK antiguo (solo cosplay) y añade uno nuevo con el mismo nombre", () => {
    expect(code).toMatch(/drop constraint media_assets_domain_check/);
    expect(code).toMatch(
      /add constraint media_assets_domain_check\s*\n?\s*check \(domain in \('cosplay', 'community'\)\)/,
    );
  });

  it("no toca media_assets.kind ni .mime (siguen cerrados a image/image-webp, sin vídeo)", () => {
    expect(code).not.toMatch(/media_assets_kind_check/);
    expect(code).not.toMatch(/media_assets_mime_check/);
  });

  it("no toca RLS ni grants de media_assets (ya establecidos en 9I-1/9I-2)", () => {
    // Ventana acotada (no /s global): el archivo SÍ menciona "media_assets" y "row level
    // security"/"grant" en secciones separadas (community_posts/community_post_media, que SÍ son
    // nuevas) — lo que no debe existir es una sentencia real de RLS/GRANT sobre media_assets.
    expect(code).not.toMatch(
      /alter table public\.media_assets (enable|force) row level security/,
    );
    expect(code).not.toMatch(/grant .* on table public\.media_assets/);
    expect(code).not.toMatch(/revoke .* on table public\.media_assets/);
  });
});

describe("RPC SECURITY DEFINER — las 4 funciones esperadas, solo service_role puede ejecutarlas", () => {
  const RPCS = [
    "community_post_save",
    "community_post_reorder_media",
    "community_post_detach_media",
    "community_post_delete",
  ];

  it("crea exactamente estas 4 funciones (ninguna otra)", () => {
    const created = [...code.matchAll(/create or replace function public\.(\w+)/gi)].map(
      (m) => m[1],
    );
    expect(created.sort()).toEqual([...RPCS].sort());
  });

  it("todas son SECURITY DEFINER con search_path fijo (pg_catalog, public)", () => {
    for (const name of RPCS) {
      const fnBlock = code.slice(
        code.indexOf(`create or replace function public.${name}`),
      );
      const nextFn = fnBlock.indexOf("create or replace function", 1);
      const scoped = nextFn === -1 ? fnBlock : fnBlock.slice(0, nextFn);
      expect(scoped, name).toMatch(/security definer/);
      expect(scoped, name).toMatch(/set search_path = pg_catalog, public/);
    }
  });

  it("cada RPC revoca EXECUTE de public/anon/authenticated y solo lo concede a service_role", () => {
    for (const name of RPCS) {
      const pattern = new RegExp(
        `revoke execute on function public\\.${name}\\([^)]*\\)\\s+from anon`,
      );
      const grantPattern = new RegExp(
        `grant execute on function public\\.${name}\\([^)]*\\)\\s+to service_role`,
      );
      expect(code, name).toMatch(pattern);
      expect(code, name).toMatch(grantPattern);
    }
  });

  it("community_post_save y community_post_reorder_media/_detach_media exigen author_user_id = p_actor_user_id (nunca admin_roles)", () => {
    // "admin_roles" SÍ aparece en prosa (comentarios `--` y `comment on function`, documentando a
    // propósito que estas RPC NO consultan esa tabla) — lo que no debe existir es una consulta SQL
    // real contra ella.
    expect(code).not.toMatch(/from public\.admin_roles/);
    expect(code).not.toMatch(/exists \([^)]*admin_roles/is);
    const occurrences = (code.match(/v_author <> p_actor_user_id/g) ?? []).length;
    // Las 4 RPC que mutan (save/reorder/detach/delete) comparan el autor bajo lock.
    expect(occurrences).toBe(4);
    expect(code).toMatch(/raise exception 'not_owner'/);
  });

  it("community_post_save exige perfil de Comunidad existente (no_profile) antes de crear", () => {
    expect(code).toMatch(
      /not exists \(\s*select 1 from public\.profiles where user_id = p_actor_user_id\s*\)\s*then\s*\n\s*raise exception 'no_profile'/,
    );
  });

  it("las 4 RPC re-verifican propiedad/estado bajo `for update` (lock de fila, protección de carrera)", () => {
    const forUpdateCount = (code.match(/for update/g) ?? []).length;
    expect(forUpdateCount).toBeGreaterThanOrEqual(4);
  });
});
