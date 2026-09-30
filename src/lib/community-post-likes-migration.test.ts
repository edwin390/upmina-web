import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo enfoque que community-posts-media-migration.test.ts: sin Postgres real en este entorno de
// test, se verifica ESTÁTICAMENTE el contenido de la migración 9J-2C. No sustituye aplicarla en
// Supabase y comprobar RLS/grants/constraints/cascada con datos reales — YA HECHO por separado
// contra Upmina Testing vía MCP (like idempotente, unlike idempotente, post_not_found para
// inexistente/hidden, cascada de borrado limpia los likes, contador denormalizado sincronizado).

const MIGRATION_PATH = resolve(
  __dirname,
  "../../supabase/migrations/20261005120000_community_post_likes.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("migración 20261005120000_community_post_likes.sql — alcance de tablas", () => {
  it("crea exactamente community_post_likes (ninguna otra tabla)", () => {
    const created = [...code.matchAll(/create table\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect(created).toEqual(["community_post_likes"]);
  });

  it("no borra ni recrea ninguna tabla existente", () => {
    expect(code).not.toMatch(/drop table/i);
  });

  it("el único ALTER TABLE sobre una tabla PREEXISTENTE es community_posts (like_count), nada más", () => {
    const created = new Set(
      [...code.matchAll(/create table\s+public\.(\w+)/gi)].map((m) => m[1]),
    );
    const altered = [...code.matchAll(/alter table\s+public\.(\w+)/gi)].map((m) => m[1]);
    const alteredPreexisting = new Set(altered.filter((name) => !created.has(name)));
    expect(alteredPreexisting).toEqual(new Set(["community_posts"]));
  });

  it("no toca cosplay_*, profiles, admin_*, social_*, media_assets ni community_post_media", () => {
    expect(code).not.toMatch(
      /alter table public\.(cosplay_\w+|profiles|admin_\w+|social_\w+|media_assets|community_post_media)\b/i,
    );
  });

  it("no contiene secretos ni JWT", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(sql).not.toMatch(/service_role_key|sk_live|BEGIN (RSA|PRIVATE)/i);
  });
});

describe("community_post_likes — esquema y seguridad", () => {
  it("PK compuesta (post_id, user_id): como máximo un like por usuario y publicación", () => {
    expect(code).toMatch(
      /constraint community_post_likes_pkey\s+primary key \(post_id, user_id\)/,
    );
  });

  it("post_id referencia community_posts con ON DELETE CASCADE (borrar el post limpia sus likes)", () => {
    expect(code).toMatch(
      /post_id\s+uuid not null references public\.community_posts\(id\) on delete cascade/,
    );
  });

  it("user_id referencia auth.users con ON DELETE CASCADE", () => {
    expect(code).toMatch(
      /user_id\s+uuid not null references auth\.users\(id\) on delete cascade/,
    );
  });

  it("RLS habilitado y FORZADO", () => {
    expect(code).toMatch(
      /alter table public\.community_post_likes enable row level security/,
    );
    expect(code).toMatch(
      /alter table public\.community_post_likes force row level security/,
    );
  });

  it("cero grants para anon/authenticated/public; service_role solo select/insert/delete (nunca update)", () => {
    expect(code).toMatch(/revoke all on table public\.community_post_likes from public/);
    expect(code).toMatch(/revoke all on table public\.community_post_likes from anon/);
    expect(code).toMatch(
      /revoke all on table public\.community_post_likes from authenticated/,
    );
    expect(code).toMatch(
      /grant select, insert, delete on table public\.community_post_likes to service_role/,
    );
  });

  it("no crea NINGUNA policy pública (mutación exclusiva vía RPC SECURITY DEFINER)", () => {
    expect(code).not.toMatch(/create policy/i);
  });
});

describe("community_posts.like_count — contador desnormalizado", () => {
  it("columna con default 0 y CHECK >= 0 (nunca negativo)", () => {
    expect(code).toMatch(
      /alter table public\.community_posts add column like_count integer not null default 0\s+check \(like_count >= 0\)/,
    );
  });

  it("índice para Populares: status, like_count desc, created_at desc, id desc", () => {
    expect(code).toMatch(
      /create index community_posts_popular on public\.community_posts\s*\(status, like_count desc, created_at desc, id desc\)/,
    );
  });
});

describe("community_post_likes_sync_count — trigger de sincronización", () => {
  it("es SECURITY DEFINER con search_path fijo (mismo patrón que el resto de RPC/triggers del proyecto)", () => {
    expect(code).toMatch(
      /create or replace function public\.community_post_likes_sync_count\(\)[\s\S]{0,200}security definer[\s\S]{0,100}set search_path = pg_catalog, public/,
    );
  });

  it("incrementa en INSERT y decrementa (con greatest(...,0)) en DELETE", () => {
    expect(code).toMatch(
      /update public\.community_posts set like_count = like_count \+ 1/,
    );
    expect(code).toMatch(
      /update public\.community_posts\s+set like_count = greatest\(like_count - 1, 0\)/,
    );
  });

  it("el trigger se dispara AFTER INSERT OR DELETE en community_post_likes", () => {
    expect(code).toMatch(
      /create trigger community_post_likes_sync_count_trigger\s+after insert or delete on public\.community_post_likes/,
    );
  });

  it("EXECUTE revocado de anon/authenticated (el linter de seguridad lo exige para SECURITY DEFINER expuesta)", () => {
    expect(code).toMatch(
      /revoke all on function public\.community_post_likes_sync_count\(\) from public/,
    );
    expect(code).toMatch(
      /revoke execute on function public\.community_post_likes_sync_count\(\) from anon/,
    );
    expect(code).toMatch(
      /revoke execute on function public\.community_post_likes_sync_count\(\) from authenticated/,
    );
  });
});

describe("community_post_set_like — RPC de estado idempotente", () => {
  it("valida argumentos no nulos (invalid_argument)", () => {
    expect(code).toMatch(
      /if p_actor_user_id is null or p_post_id is null or p_liked is null then\s+raise exception 'invalid_argument'/,
    );
  });

  it("re-verifica bajo lock (for update) que la publicación existe y sigue published", () => {
    expect(code).toMatch(
      /select status into v_status from public\.community_posts where id = p_post_id for update/,
    );
    expect(code).toMatch(
      /if not found or v_status <> 'published' then\s+raise exception 'post_not_found'/,
    );
  });

  it("liked=true usa ON CONFLICT DO NOTHING (idempotente, sin duplicar la fila)", () => {
    expect(code).toMatch(
      /insert into public\.community_post_likes \(post_id, user_id\)\s+values \(p_post_id, p_actor_user_id\)\s+on conflict \(post_id, user_id\) do nothing/,
    );
  });

  it("liked=false borra sin condición previa (idempotente: 0 filas afectadas no es un error)", () => {
    expect(code).toMatch(
      /delete from public\.community_post_likes\s+where post_id = p_post_id and user_id = p_actor_user_id/,
    );
  });

  it("nunca compara author_user_id contra el actor: cualquier autenticado puede dar like, incluido el propio autor", () => {
    expect(code).not.toMatch(/community_post_set_like[\s\S]*author_user_id/);
  });

  it("devuelve postId/likeCount/likedByMe (camelCase de salida, nunca liker user_id de otros)", () => {
    expect(code).toMatch(
      /return jsonb_build_object\(\s*'postId', p_post_id,\s*'likeCount', v_like_count,\s*'likedByMe', v_liked_by_me\s*\)/,
    );
  });

  it("SOLO service_role puede ejecutar la RPC (nunca anon/authenticated)", () => {
    expect(code).toMatch(
      /revoke all on function public\.community_post_set_like\(uuid, uuid, boolean\) from public/,
    );
    expect(code).toMatch(
      /revoke execute on function public\.community_post_set_like\(uuid, uuid, boolean\) from anon/,
    );
    expect(code).toMatch(
      /revoke execute on function public\.community_post_set_like\(uuid, uuid, boolean\) from authenticated/,
    );
    expect(code).toMatch(
      /grant execute on function public\.community_post_set_like\(uuid, uuid, boolean\) to service_role/,
    );
  });
});
