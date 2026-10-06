// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";
import { runMediaGcBatch, type GcDb, type PhysicalDeleteIo } from "./media-gc";

// R4-E2 ↔ R4-E1: el motor TS contra las RPC REALES de la migración 20261020 (PGlite), con R2
// simulado. Fija el contrato de forma y de resultados entre ambas capas.

const migration = (n: string) => readFileSync(`supabase/migrations/${n}`, "utf8");
const A = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let db: TestDatabase;

beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`create table admin_roles(user_id uuid primary key,role text);
 alter table profiles add column username text,add column display_name text;
 alter table media_assets add column storage_key text,add column width int,add column height int,
   add column duration_seconds numeric,add column private_original_key text;
 create table media_asset_variants(id uuid primary key default gen_random_uuid(),
   asset_id uuid not null references media_assets(id) on delete cascade,
   variant int, storage_key text not null);`);
  for (const n of [
    "20261007120000_moderation_foundation.sql",
    "20261009120000_moderation_workflow_core.sql",
    "20261010120000_moderation_case_foundation.sql",
    "20261011120000_community_report_submission.sql",
    "20261012120000_community_report_submission_account_race_fix.sql",
    "20261013120000_moderation_case_read_model.sql",
    "20261014120000_moderation_case_media_references.sql",
    "20261015120000_moderation_grouped_decision_core.sql",
    "20261016120000_community_controlled_write_boundary.sql",
    "20261017120000_community_author_moderation_access.sql",
    "20261018120000_community_author_resolved_notice_flag.sql",
    "20261019120000_community_media_delivery_state.sql",
    "20261020120000_community_media_purge_lifecycle.sql",
  ])
    await db.exec(migration(n));
}, 60000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  await db.exec("reset role;rollback");
});

const adapter: GcDb = {
  async rpc(name, args) {
    const params = Object.values(args);
    const sql = `select ${name}(${params.map((_, i) => `$${i + 1}`).join(",")}) r`;
    try {
      return {
        data: (await db.query<{ r: unknown }>(sql, params)).rows[0].r,
        error: null,
      };
    } catch (error) {
      return { data: null, error };
    }
  },
};
function fakeR2(failPublicFor?: string) {
  const deleted: string[] = [];
  const io: PhysicalDeleteIo = {
    async deletePublic(keys) {
      if (failPublicFor && keys.some((k) => k.includes(failPublicFor)))
        throw Object.assign(new Error("partial"), { name: "R2PartialDeleteError" });
      deleted.push(...keys);
    },
    async deletePrivate(key) {
      deleted.push(key);
    },
  };
  return { io, deleted };
}
async function seed() {
  const mk = (
    id: string,
    kind: string,
    storage: string | null,
    priv: string | null = null,
  ) =>
    db.query(
      "insert into media_assets(id,domain,kind,status,created_by,storage_key,private_original_key) values($1,'community',$2,'deleting',$3,$4,$5)",
      [id, kind, ACTOR, storage, priv],
    );
  await mk(
    A(1),
    "image",
    `community/${A(1)}/w960.webp`,
    `staging/community/${A(1)}/original.png`,
  );
  await db.query(
    "insert into media_asset_variants(asset_id,variant,storage_key) values($1,480,$2),($1,960,$3)",
    [A(1), `community/${A(1)}/w480.webp`, `community/${A(1)}/w960.webp`],
  );
  await mk(A(2), "video", `community/${A(2)}/original.mp4`);
  await mk(A(3), "image", `community/${A(9)}/w960.webp`); // hostile: key of ANOTHER asset
}
const exists = async (id: string) =>
  (await db.query("select 1 from media_assets where id=$1", [id])).rows.length === 1;

it("image + video are deleted physically then finalized; a hostile row fails closed with zero deletes", async () => {
  await seed();
  const { io, deleted } = fakeR2();
  const summary = await runMediaGcBatch({ db: adapter, io, log: () => undefined });
  expect(summary).toMatchObject({
    claimed: 3,
    finalized: 2,
    failed: 1,
    errorClasses: { invalid_object_reference: 1 },
  });
  expect(deleted.sort()).toEqual(
    [
      `community/${A(1)}/w480.webp`,
      `community/${A(1)}/w960.webp`,
      `staging/community/${A(1)}/original.png`,
      `community/${A(2)}/original.mp4`,
    ].sort(),
  );
  expect(await exists(A(1))).toBe(false);
  expect(await exists(A(2))).toBe(false);
  expect(await exists(A(3))).toBe(true); // never finalized
  const row = (
    await db.query<{ attempts: number; err: string; lease: unknown }>(
      "select purge_attempts attempts, purge_last_error_class err, purge_lease_until lease from media_assets where id=$1",
      [A(3)],
    )
  ).rows[0];
  expect(row).toEqual({ attempts: 1, err: "invalid_object_reference", lease: null });
});

it("a partial R2 failure keeps the asset deleting with backoff; after R2 recovers a later run finalizes it", async () => {
  await seed();
  await db.query("delete from media_assets where id=$1", [A(3)]);
  const first = await runMediaGcBatch({
    db: adapter,
    io: fakeR2(A(1)).io,
    log: () => undefined,
  });
  expect(first.errorClasses).toEqual({ r2_partial_delete: 1 });
  expect(first.finalized).toBe(1); // the video
  expect(await exists(A(1))).toBe(true);
  // not claimable until next_attempt_at; make it due like the passage of time would
  await db.query(
    "update media_assets set purge_next_attempt_at = clock_timestamp() where id=$1",
    [A(1)],
  );
  const second = await runMediaGcBatch({
    db: adapter,
    io: fakeR2().io,
    log: () => undefined,
  });
  expect(second).toMatchObject({ claimed: 1, finalized: 1, failed: 0 });
  expect(await exists(A(1))).toBe(false);
});

it("an empty queue claims nothing and touches nothing", async () => {
  const { io, deleted } = fakeR2();
  expect(await runMediaGcBatch({ db: adapter, io, log: () => undefined })).toMatchObject({
    claimed: 0,
    finalized: 0,
  });
  expect(deleted).toEqual([]);
});
