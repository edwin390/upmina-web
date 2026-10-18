// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- los resultados jsonb de PGlite no tienen tipo estático */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  ASSETS,
  POST,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// F4-F: PostgreSQL real (PGlite). Cadena: base de guardado atómico + Fase 2 + migraciones shadow F4-A..C + interruptor NUEVO.
const migration = (f: string) => readFileSync(resolve("supabase/migrations", f), "utf8");
const fresh = (n: number) =>
  `00000000-0000-4000-8000-${String(400 + n).padStart(12, "0")}`;

let db: TestDatabase;
beforeEach(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`
    create function public.community_assert_author_may_write(uuid) returns void language sql as $$ select $$;
    create function public.copyright_post_protected(uuid) returns boolean language sql stable as $$ select false $$;
    create table public.admin_roles(user_id uuid primary key, role text not null);
    alter table public.community_posts add column if not exists purge_after timestamptz;
    alter table public.media_assets add column if not exists failure_code text;
  `);
  for (const f of [
    "20261120120000_held_for_review_pending_edits.sql",
    "20261122120000_community_shadow_persistence.sql",
    "20261123120000_community_shadow_retry_delay.sql",
    "20261124120000_community_shadow_administrative_defer.sql",
    "20261125120000_community_shadow_budget.sql",
  ])
    await db.exec(migration(f));
}, 60000);
afterEach(async () => {
  await db?.close();
});

const jobs = async () =>
  (
    await db.query(
      "select post_id, version, state, snapshot_text, obsolete_at from community_shadow_jobs order by created_at",
    )
  ).rows as any[];
async function newPost(n: number, text: string) {
  await db.query(
    "insert into media_assets(id,domain,status,kind,created_by) values ($1,'community','ready','image',$2)",
    [fresh(n), ACTOR],
  );
  const r = await db.query<{ r: any }>(
    "select public.community_post_save_atomic($1,null,null,$2,$3::jsonb,'{}'::uuid[]) r",
    [ACTOR, text, JSON.stringify([{ asset_id: fresh(n), position: 0 }])],
  );
  return r.rows[0].r.post as { id: string; version: number };
}

describe("captura shadow con el interruptor", () => {
  it("línea base (sin la migración nueva): publicar una publicación crea un job con copia del texto", async () => {
    const p = await newPost(1, "texto uno");
    const j = await jobs();
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({
      post_id: p.id,
      state: "queued",
      snapshot_text: "texto uno",
    });
  });

  describe("con la migración nueva (captura apagada por defecto)", () => {
    beforeEach(async () => {
      await db.exec(migration("20261126120000_community_shadow_capture_switch.sql"));
    });

    it("la migración deja el interruptor apagado y sin acceso para ningún rol de la API", async () => {
      expect(
        (await db.query("select enabled from community_shadow_capture_control")).rows,
      ).toEqual([{ enabled: false }]);
      for (const role of ["anon", "authenticated", "service_role"])
        for (const priv of ["select", "insert", "update", "delete"])
          expect(
            (
              await db.query(
                `select has_table_privilege('${role}','public.community_shadow_capture_control','${priv}') p`,
              )
            ).rows[0],
          ).toEqual({ p: false });
    });

    it("apagada: Community funciona igual (la publicación se guarda y se edita) pero no se crean jobs ni snapshot_text", async () => {
      const p = await newPost(1, "texto uno");
      expect(await jobs()).toHaveLength(0);
      const edit = await db.query<{ r: any }>(
        "select public.community_post_save_atomic($1,$2,$3,'texto editado',$4::jsonb,'{}'::uuid[]) r",
        [ACTOR, p.id, 1, JSON.stringify([{ asset_id: fresh(1), position: 0 }])],
      );
      expect(edit.rows[0].r.post).toMatchObject({ text: "texto editado", version: 2 });
      expect(await jobs()).toHaveLength(0);
      expect(
        (
          await db.query(
            "select count(*)::int n from community_post_media where post_id=$1",
            [p.id],
          )
        ).rows[0],
      ).toEqual({ n: 1 });
    });

    it("apagada: los jobs anteriores se obsoletan y pierden su copia de texto cuando el contenido cambia", async () => {
      await db.query("update community_shadow_capture_control set enabled = true");
      const p = await newPost(1, "texto con copia");
      expect((await jobs())[0].snapshot_text).toBe("texto con copia");
      await db.query("update community_shadow_capture_control set enabled = false");
      await db.query(
        "select public.community_post_save_atomic($1,$2,1,'texto nuevo',$3::jsonb,'{}'::uuid[])",
        [ACTOR, p.id, JSON.stringify([{ asset_id: fresh(1), position: 0 }])],
      );
      const j = await jobs();
      expect(j).toHaveLength(1);
      expect(j[0]).toMatchObject({ snapshot_text: null, state: "cancelled" });
      expect(j[0].obsolete_at).not.toBeNull();
    });

    it("reversible: al reactivar vuelven a crearse jobs, y el contenido vigente se recupera con reconcile", async () => {
      const p = await newPost(1, "publicada durante la suspensión");
      expect(await jobs()).toHaveLength(0);
      await db.query("update community_shadow_capture_control set enabled = true");
      // reconcile recupera el contenido vigente de las últimas 24 h (incluida la publicación histórica de la base de pruebas).
      expect(
        (
          (await db.query("select public.community_shadow_reconcile(10) n"))
            .rows[0] as any
        ).n,
      ).toBeGreaterThanOrEqual(1);
      const j = (await jobs()).filter((x) => x.post_id === p.id);
      expect(j).toHaveLength(1);
      expect(j[0]).toMatchObject({
        state: "queued",
        snapshot_text: "publicada durante la suspensión",
      });
      const q = await newPost(2, "otra");
      expect((await jobs()).map((x) => x.post_id)).toContain(q.id);
    });

    it("apagada: la limpieza de retención sigue disponible", async () => {
      await db.query("update community_shadow_capture_control set enabled = true");
      await newPost(1, "x");
      await db.query("update community_shadow_capture_control set enabled = false");
      await db.query(
        "update community_shadow_jobs set snapshot_expires_at = now() - interval '1 minute'",
      );
      await db.query("select public.community_shadow_maintain(10)");
      expect((await jobs())[0]).toMatchObject({ snapshot_text: null, state: "expired" });
    });
  });

  it("referencias de la base de pruebas intactas", () => {
    expect(POST).toBeTruthy();
    expect(ASSETS.length).toBeGreaterThan(0);
  });
});
