import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo enfoque que community-posts-media-migration.test.ts / community-post-likes-migration.test.ts:
// sin Postgres real en este entorno de test, se verifica ESTÁTICAMENTE el contenido de la migración
// 9J-3. No sustituye aplicarla en Supabase y comprobar CHECK/RLS/grants con datos reales — YA HECHO
// por separado contra Upmina Testing vía MCP (media_assets_kind_check/mime_check/source_mime_check/
// source_bytes_check/bytes_check ampliados y verificados con pg_get_constraintdef, community_post_save
// re-verificado con 2 vídeos → too_many_videos, y 1 vídeo + 1 imagen → éxito, ambos rollback).

const MIGRATION_PATH = resolve(
  __dirname,
  "../../supabase/migrations/20261006120000_community_video_media.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("migración 20261006120000_community_video_media.sql — alcance", () => {
  it("no crea ninguna tabla nueva (solo amplía media_assets y reemplaza community_post_save)", () => {
    expect(code).not.toMatch(/create table/i);
  });

  it("no borra ninguna tabla ni función existente", () => {
    expect(code).not.toMatch(/drop table/i);
    expect(code).not.toMatch(/drop function/i);
  });

  it("no toca cosplay_*, community_post_likes, community_post_media, profiles ni admin_*", () => {
    expect(code).not.toMatch(
      /alter table public\.(cosplay_\w+|community_post_likes|community_post_media|profiles|admin_\w+)\b/i,
    );
  });

  it("no contiene secretos ni JWT", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(sql).not.toMatch(/service_role_key|sk_live|BEGIN (RSA|PRIVATE)/i);
  });
});

describe("media_assets — CHECK ampliados para admitir vídeo", () => {
  it("kind admite 'image' y 'video' (lista cerrada, nada más)", () => {
    expect(code).toMatch(
      /alter table public\.media_assets add constraint media_assets_kind_check\s+check \(kind in \('image', 'video'\)\)/,
    );
  });

  it("mime canónico admite el vídeo original (mp4/quicktime/webm) además de image\\/webp", () => {
    expect(code).toMatch(
      /alter table public\.media_assets add constraint media_assets_mime_check\s+check \(mime in \('image\/webp', 'video\/mp4', 'video\/quicktime', 'video\/webm'\)\)/,
    );
  });

  it("source_mime admite los mismos 3 contenedores de vídeo junto a la lista de imagen existente", () => {
    expect(code).toMatch(/'video\/mp4', 'video\/quicktime', 'video\/webm'/);
    expect(code).toMatch(/media_assets_source_mime_check/);
  });

  it("source_bytes y bytes se amplían a 104857600 (100 MiB) — el techo EXACTO por kind vive en TypeScript", () => {
    expect(code).toMatch(
      /media_assets_source_bytes_check\s+check \(source_bytes is null or \(source_bytes > 0 and source_bytes <= 104857600\)\)/,
    );
    expect(code).toMatch(
      /media_assets_bytes_check\s+check \(bytes > 0 and bytes <= 104857600\)/,
    );
  });

  it("duration_seconds es nullable, > 0 si presente, y NUNCA se documenta como boundary de seguridad", () => {
    expect(code).toMatch(/add column duration_seconds double precision/);
    expect(code).toMatch(
      /media_assets_duration_seconds_check\s+check \(duration_seconds is null or duration_seconds > 0\)/,
    );
    expect(code).toMatch(/nunca boundary de seguridad/);
  });
});

describe("community_post_save — create or replace (9J-3 añade too_many_videos)", () => {
  it("MISMA firma que la migración original (uuid, uuid, integer, text, jsonb) — nunca una función paralela", () => {
    expect(code).toMatch(
      /create or replace function public\.community_post_save\(\s*p_actor_user_id uuid,\s*p_post_id uuid,\s*p_expected_version integer,\s*p_text text,\s*p_media jsonb\s*\)/,
    );
  });

  it("cuenta los vídeos del conjunto FINAL (existente + nuevo) y rechaza más de 1 con too_many_videos", () => {
    expect(code).toMatch(
      /select count\(\*\) into v_final_video_count\s+from public\.media_assets\s+where id = any\(v_incoming_asset_ids\) and kind = 'video'/,
    );
    expect(code).toMatch(
      /if v_final_video_count > 1 then\s+raise exception 'too_many_videos'/,
    );
  });

  it("el límite de 10 media totales sigue intacto (sin cambios de ese invariante)", () => {
    expect(code).toMatch(/if v_media_count > 10 then\s+raise exception 'too_many_media'/);
  });

  it("conserva el invariante 'texto o media' (empty_post) sin alterar su condición", () => {
    expect(code).toMatch(
      /if \(p_text is null or length\(trim\(p_text\)\) = 0\) and v_final_media_count = 0 then\s+raise exception 'empty_post'/,
    );
  });

  it("sigue re-verificando author_user_id bajo lock (not_owner) — nunca admin_roles", () => {
    expect(code).toMatch(
      /if v_author <> p_actor_user_id then\s+raise exception 'not_owner'/,
    );
  });

  it("SOLO service_role puede ejecutar la función reemplazada (nunca anon/authenticated)", () => {
    expect(code).toMatch(
      /revoke all on function public\.community_post_save\(uuid, uuid, integer, text, jsonb\) from public/,
    );
    expect(code).toMatch(
      /revoke execute on function public\.community_post_save\(uuid, uuid, integer, text, jsonb\) from anon/,
    );
    expect(code).toMatch(
      /revoke execute on function public\.community_post_save\(uuid, uuid, integer, text, jsonb\)\s+from authenticated/,
    );
    expect(code).toMatch(
      /grant execute on function public\.community_post_save\(uuid, uuid, integer, text, jsonb\)\s+to service_role/,
    );
  });
});
