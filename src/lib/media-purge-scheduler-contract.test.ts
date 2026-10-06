// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";
import { GC_REQUEST_PATH, verifyGcRequest } from "./media-delivery-protocol";

// R4-E3: contrato SQL del tick del scheduler (migración 20261021). PGlite no trae pg_cron, pg_net ni
// Vault: se sustituyen por stubs mínimos que REGISTRAN lo que el tick intenta hacer. El HMAC del stub
// es RFC 2104 real sobre sha256(), así que la firma producida por el SQL se verifica con el
// verificador de Node (compatibilidad Postgres ↔ WebCrypto). La evidencia remota (cron real, pg_net
// real, Vault real) está en el smoke de Testing, no aquí.

const migration = (n: string) => readFileSync(`supabase/migrations/${n}`, "utf8");
const SCHEDULER = migration("20261021120000_community_media_purge_scheduler.sql");
const SECRET = "synthetic-scheduler-secret-for-tests-0123456789";
const URL = "https://backend.synthetic.example/api/media/gc";
const A = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let db: TestDatabase;

/** Solo la función del tick y su ACL: cron.schedule/create extension no existen en PGlite. */
function functionPart(sql: string): string {
  const start = sql.indexOf(
    "create or replace function public.community_media_purge_tick()",
  );
  const end = sql.indexOf("-- Exactly ONE job.");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

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
  await db.exec(`
    create schema vault;
    create table vault.decrypted_secrets(name text primary key, decrypted_secret text);
    create schema net;
    create table net.calls(id bigserial primary key, url text, body jsonb, params jsonb,
      headers jsonb, timeout_ms int);
    create function net.http_post(url text, body jsonb default '{}'::jsonb,
      params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
      timeout_milliseconds int default 5000) returns bigint language plpgsql as $f$
    declare v_id bigint;
    begin
      if current_setting('test.net_fail', true) = 'on' then raise exception 'net_down'; end if;
      insert into net.calls(url, body, params, headers, timeout_ms)
        values (url, body, params, headers, timeout_milliseconds) returning id into v_id;
      return v_id;
    end $f$;
    create schema extensions;
    create function extensions.hmac(data bytea, key bytea, algo text) returns bytea
      language plpgsql immutable as $f$
    declare k bytea := key; ip bytea; op bytea; i int;
    begin
      if algo <> 'sha256' then raise exception 'only sha256'; end if;
      if length(k) > 64 then k := sha256(k); end if;
      k := k || decode(repeat('00', 64 - length(k)), 'hex');
      ip := k; op := k;
      for i in 0..63 loop
        ip := set_byte(ip, i, get_byte(k, i) # 54);
        op := set_byte(op, i, get_byte(k, i) # 92);
      end loop;
      return sha256(op || sha256(ip || data));
    end $f$;
  `);
  await db.exec(functionPart(SCHEDULER));
}, 90000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  try {
    await db.exec("reset role");
  } catch {
    /* aborted transaction: rollback below */
  }
  await db.exec("rollback");
});

const configure = () =>
  db.query(
    "insert into vault.decrypted_secrets values ('media_gc_shared_secret',$1),('media_gc_endpoint_url',$2)",
    [SECRET, URL],
  );
const seedDeleting = (id: string, extra = "") =>
  db.query(
    `insert into media_assets(id,domain,kind,status,created_by,storage_key ${extra ? ",purge_next_attempt_at" : ""})
     values($1,'community','image','deleting',$2,$3 ${extra ? ",$4" : ""})`,
    extra
      ? [id, ACTOR, `community/${id}/w960.webp`, extra]
      : [id, ACTOR, `community/${id}/w960.webp`],
  );
const tick = async () =>
  (
    await db.query<{ r: Record<string, unknown> }>(
      "select public.community_media_purge_tick() r",
    )
  ).rows[0].r;
const calls = async () =>
  (
    await db.query<{
      url: string;
      body: unknown;
      params: unknown;
      headers: Record<string, string>;
    }>("select url, body, params, headers from net.calls order by id")
  ).rows;

describe("community_media_purge_tick — wake-up decisions", () => {
  it("no backlog: runs the logical purge (0) and enqueues NO http request", async () => {
    await configure();
    const r = await tick();
    expect(r).toMatchObject({ status: "idle", eligible: 0, purgeFailed: false });
    expect(r.purge).toMatchObject({ purged: 0 });
    expect(await calls()).toHaveLength(0);
  });

  it("eligible backlog: exactly ONE signed POST, nothing chosen by the tick", async () => {
    await configure();
    await seedDeleting(A(1));
    await seedDeleting(A(2));
    const r = await tick();
    expect(r).toMatchObject({ status: "gc_enqueued", eligible: 2 });
    const rows = await calls();
    expect(rows).toHaveLength(1); // one wake-up for the whole backlog, not one per asset
    expect(rows[0].url).toBe(URL);
    expect(Object.keys(rows[0].headers).sort()).toEqual([
      "x-media-signature",
      "x-media-timestamp",
    ]);
    // no asset ids, keys, bucket or limit anywhere in the request
    expect(JSON.stringify(rows[0])).not.toMatch(
      /community\/|0e000000|bucket|limit|storage/i,
    );
    expect(rows[0].body).toEqual({}); // pg_net default; the endpoint accepts a key-less object
  });

  it("the SQL-built signature verifies with the Node verifier (Postgres HMAC == WebCrypto HMAC)", async () => {
    await configure();
    await seedDeleting(A(1));
    await tick();
    const [row] = await calls();
    const ok = await verifyGcRequest(SECRET, {
      method: "POST",
      path: GC_REQUEST_PATH,
      timestamp: row.headers["x-media-timestamp"],
      signature: row.headers["x-media-signature"],
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(ok).toEqual({ ok: true });
    const wrong = await verifyGcRequest("another-secret-0123456789012345678901234", {
      method: "POST",
      path: GC_REQUEST_PATH,
      timestamp: row.headers["x-media-timestamp"],
      signature: row.headers["x-media-signature"],
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(wrong).toEqual({ ok: false, reason: "signature" });
  });

  it("an asset still in backoff is not eligible: no request", async () => {
    await configure();
    await seedDeleting(A(1), new Date(Date.now() + 3_600_000).toISOString());
    expect(await tick()).toMatchObject({ status: "idle", eligible: 0 });
    expect(await calls()).toHaveLength(0);
  });

  it.each([
    [
      "missing secret",
      `insert into vault.decrypted_secrets values ('media_gc_endpoint_url','${URL}')`,
    ],
    [
      "missing url",
      `insert into vault.decrypted_secrets values ('media_gc_shared_secret','${SECRET}')`,
    ],
    [
      "plain-http url",
      `insert into vault.decrypted_secrets values ('media_gc_shared_secret','${SECRET}'),('media_gc_endpoint_url','http://backend.synthetic.example/api/media/gc')`,
    ],
    [
      "url with another path",
      `insert into vault.decrypted_secrets values ('media_gc_shared_secret','${SECRET}'),('media_gc_endpoint_url','https://backend.synthetic.example/api/other')`,
    ],
    [
      "short secret",
      `insert into vault.decrypted_secrets values ('media_gc_shared_secret','short'),('media_gc_endpoint_url','${URL}')`,
    ],
  ])("not configured (%s): fails closed, no request", async (_n, sql) => {
    await db.exec(sql);
    await seedDeleting(A(1));
    expect(await tick()).toMatchObject({ status: "gc_not_configured" });
    expect(await calls()).toHaveLength(0);
  });
});

describe("community_media_purge_tick — failure isolation", () => {
  it("an enqueue failure raises and never touches the asset (no lease, attempts, state)", async () => {
    await configure();
    await seedDeleting(A(1));
    await db.exec("savepoint s");
    await db.exec("select set_config('test.net_fail','on',true)");
    await expect(tick()).rejects.toThrow();
    await db.exec("rollback to savepoint s");
  });
  it("after a failed wake-up the asset is exactly as before (the next tick can recover)", async () => {
    await configure();
    await seedDeleting(A(1));
    await db.exec("savepoint s");
    await db.exec("select set_config('test.net_fail','on',true)");
    await expect(tick()).rejects.toThrow();
    await db.exec("rollback to savepoint s");
    const row = (
      await db.query<Record<string, unknown>>(
        "select status,purge_attempts,purge_claim_token,purge_lease_until,purge_next_attempt_at,purge_last_error_class from media_assets where id=$1",
        [A(1)],
      )
    ).rows[0];
    expect(row).toEqual({
      status: "deleting",
      purge_attempts: 0,
      purge_claim_token: null,
      purge_lease_until: null,
      purge_next_attempt_at: null,
      purge_last_error_class: null,
    });
    expect(await tick()).toMatchObject({ status: "gc_enqueued" });
  });
  it("a failing logical purge does not stop the GC wake-up and reports only a flag", async () => {
    await configure();
    await seedDeleting(A(1));
    await db.exec(`create or replace function public.community_purge_due_posts(p_limit integer default 50)
      returns jsonb language plpgsql as $f$ begin raise exception 'boom secret-detail'; end $f$`);
    const r = await tick();
    expect(r).toMatchObject({ status: "gc_enqueued", purgeFailed: true });
    expect(JSON.stringify(r)).not.toMatch(/boom|secret-detail/);
  });
  it("the tick never writes media_assets itself (a successful wake-up leaves the queue untouched)", async () => {
    await configure();
    await seedDeleting(A(1));
    await tick();
    const row = (
      await db.query<{ purge_attempts: number; purge_claim_token: unknown }>(
        "select purge_attempts, purge_claim_token from media_assets where id=$1",
        [A(1)],
      )
    ).rows[0];
    expect(row).toEqual({ purge_attempts: 0, purge_claim_token: null });
  });
});

describe("community_media_purge_tick — surface and privileges", () => {
  it("takes no arguments (nothing can be caller-controlled, including time)", async () => {
    const r = await db.query<{ pronargs: number }>(
      "select pronargs from pg_proc where proname='community_media_purge_tick'",
    );
    expect(r.rows).toEqual([{ pronargs: 0 }]);
  });
  it("is SECURITY DEFINER with a pinned search_path and not executable by client roles", async () => {
    const r = await db.query<{ secdef: boolean; cfg: string[]; acl: string | null }>(
      "select prosecdef secdef, proconfig cfg, proacl::text acl from pg_proc where proname='community_media_purge_tick'",
    );
    expect(r.rows[0].secdef).toBe(true);
    expect(r.rows[0].cfg).toEqual(["search_path=pg_catalog, public"]);
    expect(r.rows[0].acl).toBe("{postgres=X/postgres}"); // owner only
  });
});

describe("migration 20261021 source", () => {
  it("contains no secret material, keys, bearer tokens or service-role usage", () => {
    expect(SCHEDULER).not.toContain(SECRET);
    expect(SCHEDULER).not.toMatch(
      /Bearer|eyJ[A-Za-z0-9_-]{10,}|sb_secret|SUPABASE_SERVICE_ROLE_KEY/,
    );
    // the only secret access is a Vault read by NAME at run time
    expect(SCHEDULER.match(/vault\.decrypted_secrets/g)).toHaveLength(2);
    expect(SCHEDULER).not.toMatch(/vault\.(create_secret|update_secret)/);
    // no env-specific host baked in
    expect(SCHEDULER).not.toMatch(
      /https:\/\/[a-z0-9-]+\.(vercel\.app|workers\.dev|supabase\.co)/,
    );
  });
  it("schedules exactly ONE job, every 5 minutes, by name (idempotent upsert)", () => {
    expect(SCHEDULER.match(/^select cron\.schedule\(/gm)).toHaveLength(1);
    expect(SCHEDULER).toContain("'community-media-purge-tick'");
    expect(SCHEDULER).toContain("'*/5 * * * *'");
    expect(SCHEDULER).not.toMatch(/cron\.schedule_in_database|alter_job/);
  });
  it("does not modify the E1/E2 migration or any table", () => {
    expect(SCHEDULER).not.toMatch(
      /\b(alter table|create table|drop table|insert into|update public\.|delete from)\b/i,
    );
  });
});
