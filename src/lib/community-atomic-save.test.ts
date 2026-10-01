// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  ASSETS,
  ATTACHMENTS,
  POST,
  atomicSave,
  createAtomicTestDatabase,
  snapshot,
  type TestDatabase,
} from "./community-atomic-save-test-db";

let db: TestDatabase;
beforeEach(async () => {
  db = await createAtomicTestDatabase();
}, 30000);
afterEach(async () => {
  await db?.close();
});

describe("real PostgreSQL atomic Community edit", () => {
  it.each([
    ["keep", [0, 1, 2], []],
    ["remove", [0, 2], [ATTACHMENTS[1]]],
    ["reorder", [2, 0, 1], []],
    ["remove/reorder", [2, 0], [ATTACHMENTS[1]]],
    ["add", [0, 1, 2, 3], []],
    ["remove/add", [0, 2, 3], [ATTACHMENTS[1]]],
    ["remove/add/reorder", [3, 2, 0], [ATTACHMENTS[1]]],
  ] as const)(
    "%s preserves final order, post identity and increments once",
    async (_label, order, removed) => {
      const result = await atomicSave(db, [...order], [...removed]);
      expect(result.post).toMatchObject({ id: POST, version: 3, text: "Editado" });
      expect(result.media.map((m) => m.asset_id)).toEqual(order.map((n) => ASSETS[n]));
      expect(result.media.map((m) => m.position)).toEqual(order.map((_, n) => n));
      expect(result.cleanup_asset_ids).toEqual(removed.length ? [ASSETS[1]] : []);
      const statuses = (
        await db.query<{ status: string }>(
          "select status from media_assets where id=$1",
          [ASSETS[1]],
        )
      ).rows;
      expect(statuses[0].status).toBe(removed.length ? "deleting" : "ready");
    },
  );

  it.each([
    ["unexplained omission", [0, 2], [], 2, "media_missing_existing"],
    [
      "foreign removal",
      [0, 2],
      ["99999999-9999-4999-8999-999999999999"],
      2,
      "media_not_found",
    ],
    ["retained and removed", [0, 1, 2], [ATTACHMENTS[1]], 2, "invalid_argument"],
    [
      "duplicate removal",
      [0, 2],
      [ATTACHMENTS[1], ATTACHMENTS[1]],
      2,
      "invalid_argument",
    ],
    ["stale version", [0, 2], [ATTACHMENTS[1]], 1, "version_conflict"],
    ["empty final state", [], [...ATTACHMENTS], 2, "empty_post"],
  ] as const)(
    "%s rejects without any mutation",
    async (_label, order, removed, version, error) => {
      const before = await snapshot(db);
      await expect(
        atomicSave(db, [...order], [...removed], version, order.length ? "Editado" : ""),
      ).rejects.toThrow(error);
      expect(await snapshot(db)).toEqual(before);
    },
  );

  it("foreign attachment belongs to a real other post, not just an unknown UUID", async () => {
    const otherPost = "99999999-9999-4999-8999-999999999999";
    const otherMedia = "88888888-8888-4888-8888-888888888888";
    await db.query(
      "insert into community_posts(id,author_user_id,text) values ($1,$2,'Other')",
      [otherPost, ACTOR],
    );
    await db.query(
      "insert into community_post_media(id,post_id,asset_id,position) values ($1,$2,$3,0)",
      [otherMedia, otherPost, ASSETS[3]],
    );
    const before = await snapshot(db);
    await expect(atomicSave(db, [0, 2], [otherMedia])).rejects.toThrow("media_not_found");
    expect(await snapshot(db)).toEqual(before);
  });

  it("forced late lifecycle failure rolls back text, removal, new attachment, positions, version and assets", async () => {
    await db.exec(`create function test_fail_cleanup() returns trigger language plpgsql as $$ begin raise exception 'forced_late_failure'; end $$;
      create trigger test_fail_cleanup before update on media_assets for each row execute function test_fail_cleanup();`);
    const before = await snapshot(db);
    await expect(atomicSave(db, [3, 2, 0], [ATTACHMENTS[1]])).rejects.toThrow(
      "forced_late_failure",
    );
    expect(await snapshot(db)).toEqual(before);
  });

  it("unauthorized actor cannot remove another author's attachment", async () => {
    const before = await snapshot(db);
    await expect(
      atomicSave(db, [0, 2], [ATTACHMENTS[1]], 2, "Editado", ASSETS[3]),
    ).rejects.toThrow("not_owner");
    expect(await snapshot(db)).toEqual(before);
  });

  it("remaining external reference prevents lifecycle transition and cleanup", async () => {
    await db.query("insert into cosplay_post_images values ($1)", [ASSETS[1]]);
    expect((await atomicSave(db, [0, 2], [ATTACHMENTS[1]])).cleanup_asset_ids).toEqual(
      [],
    );
    expect(
      (await db.query("select status from media_assets where id=$1", [ASSETS[1]])).rows[0]
        .status,
    ).toBe("ready");
  });

  it("create remains valid and rejects create removals", async () => {
    const result = await atomicSave(db, [3], [], 2, "New", ACTOR, null);
    expect(result.post.id).not.toBe(POST);
    expect(result.post.version).toBe(1);
    await expect(
      atomicSave(db, [], [ATTACHMENTS[1]], 2, "New", ACTOR, null),
    ).rejects.toThrow("invalid_argument");
  });

  it("legacy omission guard remains and public roles cannot execute the new RPC", async () => {
    await expect(
      db.query("select community_post_save($1,$2,2,'Editado',$3::jsonb)", [
        ACTOR,
        POST,
        JSON.stringify([{ asset_id: ASSETS[0], position: 0 }]),
      ]),
    ).rejects.toThrow("media_missing_existing");
    const { rows } = await db.query(
      "select has_function_privilege('anon','public.community_post_save_atomic(uuid,uuid,integer,text,jsonb,uuid[])','execute') anon, has_function_privilege('authenticated','public.community_post_save_atomic(uuid,uuid,integer,text,jsonb,uuid[])','execute') authenticated, has_function_privilege('service_role','public.community_post_save_atomic(uuid,uuid,integer,text,jsonb,uuid[])','execute') service",
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service: true });
  });
});
