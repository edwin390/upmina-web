// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  ASSETS,
  ATTACHMENTS,
  POST,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// MEDIA-1: PostgreSQL real (PGlite). Se aplica la migración NUEVA sobre la base de pruebas del guardado atómico; la
// guardia de restricciones/cuenta (otra migración) se sustituye por un stub vacío porque aquí no se ejercita.
const OTHER = "44444444-4444-4444-8444-444444444444";
const TEXT_ONLY_POST = "55555555-5555-4555-8555-555555555555";
const FRESH = (n: number) => `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`;

let db: TestDatabase;
beforeEach(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(
    "create function public.community_assert_author_may_write(uuid) returns void language sql as $$ select $$;",
  );
  await db.exec(
    readFileSync(
      resolve("supabase/migrations/20261119120000_community_media_required.sql"),
      "utf8",
    ),
  );
}, 30000);
afterEach(async () => {
  await db?.close();
});

async function asset(id: string, kind = "image", owner = ACTOR, domain = "community", status = "ready") {
  await db.query(
    "insert into media_assets(id,domain,status,kind,created_by) values ($1,$2,$3,$4,$5)",
    [id, domain, status, kind, owner],
  );
}

async function save(
  postId: string | null,
  text: string | null,
  assetIds: string[],
  removed: string[] = [],
  version: number | null = postId ? 2 : null,
) {
  const media = assetIds.map((id, position) => ({ asset_id: id, position }));
  try {
    const { rows } = await db.query<{ r: { post: { version: number; text: string | null; status: string } } }>(
      "select public.community_post_save_atomic($1::uuid,$2::uuid,$3::integer,$4::text,$5::jsonb,$6::uuid[]) r",
      [ACTOR, postId, version, text, JSON.stringify(media), removed],
    );
    return { ok: true as const, post: rows[0].r.post };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

async function detach(mediaId: string, version: number) {
  try {
    await db.query("select public.community_post_detach_media($1,$2,$3,$4)", [
      ACTOR,
      POST,
      version,
      mediaId,
    ]);
    return "ok";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("MEDIA-1 · creación", () => {
  it("rechaza sin texto y sin archivos", async () => {
    expect(await save(null, null, [])).toEqual({ ok: false, error: "media_required" });
  });
  it("rechaza solo con texto", async () => {
    expect(await save(null, "solo texto", [])).toEqual({ ok: false, error: "media_required" });
  });
  it("acepta con una imagen válida (y texto opcional)", async () => {
    await asset(FRESH(1));
    const r = await save(null, null, [FRESH(1)]);
    expect(r.ok && r.post.status).toBe("published");
  });
  it("acepta un vídeo sin texto", async () => {
    await asset(FRESH(2), "video");
    const r = await save(null, null, [FRESH(2)]);
    expect(r.ok && r.post.text).toBeNull();
  });
  it("rechaza archivo inexistente, ajeno, de otro dominio, no listo o ya adjunto", async () => {
    await asset(FRESH(3), "image", OTHER);
    await asset(FRESH(4), "image", ACTOR, "cosplay");
    await asset(FRESH(5), "image", ACTOR, "community", "processing");
    expect(await save(null, "x", [FRESH(9)])).toEqual({ ok: false, error: "invalid_asset" });
    expect(await save(null, "x", [FRESH(3)])).toEqual({ ok: false, error: "foreign_asset" });
    expect(await save(null, "x", [FRESH(4)])).toEqual({ ok: false, error: "foreign_asset" });
    expect(await save(null, "x", [FRESH(5)])).toEqual({ ok: false, error: "asset_not_ready" });
    expect(await save(null, "x", [ASSETS[0]])).toEqual({ ok: false, error: "asset_already_attached" });
  });
  it("conserva los límites de medios: más de 10 y más de un vídeo", async () => {
    expect(await save(null, "x", Array.from({ length: 11 }, (_, i) => FRESH(20 + i)))).toEqual({
      ok: false,
      error: "too_many_media",
    });
    await asset(FRESH(6), "video");
    await asset(FRESH(7), "video");
    expect(await save(null, null, [FRESH(6), FRESH(7)])).toEqual({
      ok: false,
      error: "too_many_videos",
    });
  });
});

describe("MEDIA-1 · edición", () => {
  async function textOnlyPost() {
    await db.query(
      "insert into community_posts(id,author_user_id,text,version) values ($1,$2,'Histórico',2)",
      [TEXT_ONLY_POST, ACTOR],
    );
  }
  it("un post histórico de solo texto sigue pudiendo editar su texto", async () => {
    await textOnlyPost();
    const r = await save(TEXT_ONLY_POST, "Texto editado", []);
    expect(r.ok && r.post.text).toBe("Texto editado");
    expect(r.ok && r.post.version).toBe(3);
  });
  it("un post histórico de solo texto no puede quedar vacío", async () => {
    await textOnlyPost();
    expect(await save(TEXT_ONLY_POST, null, [])).toEqual({ ok: false, error: "empty_post" });
  });
  it("un post con archivos no puede quedarse sin ninguno al editar", async () => {
    const all = await save(POST, "Editado", [], ATTACHMENTS);
    expect(all).toEqual({ ok: false, error: "media_required" });
    const none = await save(POST, "Editado", []);
    expect(none.ok).toBe(false);
    const { rows } = await db.query("select count(*)::int n from community_post_media where post_id=$1", [POST]);
    expect((rows[0] as { n: number }).n).toBe(3);
  });
  it("sustituir todos los archivos por uno nuevo sí es válido", async () => {
    const r = await save(POST, "Editado", [ASSETS[3]], ATTACHMENTS);
    expect(r.ok).toBe(true);
  });
  it("quitar algunos archivos y conservar al menos uno sigue permitido", async () => {
    expect((await save(POST, "Editado", [ASSETS[0]], [ATTACHMENTS[1], ATTACHMENTS[2]])).ok).toBe(true);
  });
});

describe("MEDIA-1 · detach", () => {
  it("permite retirar archivos mientras quede alguno, pero nunca el último", async () => {
    expect(await detach(ATTACHMENTS[0], 2)).toBe("ok");
    expect(await detach(ATTACHMENTS[1], 3)).toBe("ok");
    expect(await detach(ATTACHMENTS[2], 4)).toBe("media_required");
    const { rows } = await db.query("select count(*)::int n from community_post_media where post_id=$1", [POST]);
    expect((rows[0] as { n: number }).n).toBe(1);
  });
  it("tampoco lo permite aunque la publicación tenga texto", async () => {
    await save(POST, "Con texto", [ASSETS[0]], [ATTACHMENTS[1], ATTACHMENTS[2]]);
    expect(await detach(ATTACHMENTS[0], 3)).toBe("media_required");
  });
});
