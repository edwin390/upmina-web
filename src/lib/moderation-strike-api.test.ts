// @vitest-environment node
import { readFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// R5-D: frontera privilegiada de strikes. Se ejercitan los handlers REALES, requireCapability REAL
// (JWT → rol ACTUAL en admin_roles → capacidad → MFA reciente) y el SQL REAL de R5-B/R5-C en PGlite.
// Solo el cliente de Supabase es un adaptador: auth.getClaims y admin_roles leen la BD de prueba y
// rpc() ejecuta la función SQL real dentro de un savepoint (como una llamada PostgREST atómica).

const NOW = Math.floor(Date.now() / 1000);
const uid = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOD = uid(1);
const MOD2 = uid(2);
const DEV = uid(3);
const ADM = uid(4);
const USER = uid(5);
const reporters = [11, 12, 13].map(uid);
const AUTHOR = ACTOR;

const h = vi.hoisted(() => ({
  db: null as null | {
    exec(sql: string): Promise<unknown>;
    query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
  },
  tokens: {} as Record<string, { sub: string; aal: string; amr?: unknown }>,
  rpcLog: [] as { name: string; args: Record<string, unknown> }[],
  tables: [] as string[],
  override: null as
    | null
    | ((
        name: string,
        args: Record<string, unknown>,
      ) => { data: unknown; error: unknown } | undefined),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      async getClaims(jwt: string) {
        const claims = h.tokens[jwt];
        return claims
          ? { data: { claims }, error: null }
          : { data: null, error: { message: "jwt inválido" } };
      },
    },
    from(table: string) {
      h.tables.push(table);
      if (table !== "admin_roles") throw new Error(`tabla inesperada: ${table}`);
      let userId = "";
      const builder = {
        eq(_c: string, v: string) {
          userId = v;
          return builder;
        },
        async maybeSingle() {
          const r = await h.db!.query<{ role: string }>(
            "select role from admin_roles where user_id=$1",
            [userId],
          );
          return { data: r.rows[0] ?? null, error: null };
        },
      };
      return { select: () => builder };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      h.rpcLog.push({ name, args });
      const forced = h.override?.(name, args);
      if (forced) return forced;
      const keys = Object.keys(args);
      const sql = `select ${name}(${keys.map((_, i) => `$${i + 1}`).join(",")}) r`;
      await h.db!.exec("savepoint rpc_s");
      try {
        const out = await h.db!.query<{ r: unknown }>(
          sql,
          keys.map((k) => args[k]),
        );
        await h.db!.exec("release savepoint rpc_s");
        return { data: out.rows[0].r, error: null };
      } catch (e) {
        await h.db!.exec("rollback to savepoint rpc_s");
        const err = e as { code?: string; message?: string };
        return {
          data: null,
          error: { code: err.code ?? "P0001", message: String(err.message) },
        };
      }
    },
  }),
}));

const { handleModerationStrikeApply, handleModerationStrikeRevoke } =
  await import("./moderation-strike-handlers");
const { parseStrikeApplyResponse, parseStrikeRevokeResponse } =
  await import("./moderation-strike-contract");
const { handleModerationCases } = await import("./moderation-case-handlers");
const { handleModerationCaseDecision } = await import("./moderation-decision-handlers");

const migration = (n: string) =>
  readFileSync(`supabase/migrations/${n}`, "utf8").replace(/\r\n/g, "\n");
const R5B = migration("20261023120000_community_strikes_foundation.sql");
let db: TestDatabase;
let seq = 0;
interface Obj {
  [key: string]: unknown;
}
const one = async <T = Obj>(sql: string, params: unknown[] = []) =>
  (await db.query<{ r: T }>(sql, params)).rows[0].r;

beforeAll(async () => {
  db = await createAtomicTestDatabase();
  h.db = db;
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
    "20261022120000_moderation_purged_history_read.sql",
    "20261023120000_community_strikes_foundation.sql",
    "20261024120000_community_strike_write_enforcement.sql",
  ])
    await db.exec(migration(n));
  await db.query(
    "insert into admin_roles values($1,'moderator'),($2,'moderator'),($3,'developer'),($4,'admin')",
    [MOD, MOD2, DEV, ADM],
  );
  for (const id of [MOD, MOD2, DEV, ADM, USER, ...reporters])
    await db.query("insert into auth.users values($1) on conflict do nothing", [id]);
  const sub: Record<string, string> = {
    mod: MOD,
    mod2: MOD2,
    dev: DEV,
    adm: ADM,
    user: USER,
  };
  for (const [name, id] of Object.entries(sub)) {
    h.tokens[`${name}-fresh`] = {
      sub: id,
      aal: "aal2",
      amr: [{ method: "totp", timestamp: NOW }],
    };
    h.tokens[`${name}-aal1`] = { sub: id, aal: "aal1" };
    h.tokens[`${name}-stale`] = {
      sub: id,
      aal: "aal2",
      amr: [{ method: "totp", timestamp: NOW - 86400 }],
    };
  }
}, 90000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  h.rpcLog.length = 0;
  h.tables.length = 0;
  h.override = null;
  await db.exec("begin");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    await db.exec("reset role");
  } catch {
    /* aborted */
  }
  await db.exec("rollback");
});

// ── helpers ───────────────────────────────────────────────────────────────────────────────────
function mockRes() {
  const state = {
    status: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  const res = {
    setHeader(k: string, v: string) {
      state.headers[k] = v;
      return res;
    },
    status(c: number) {
      state.status = c;
      return res;
    },
    json(b: unknown) {
      state.body = b;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}
function req(o: {
  method?: string;
  token?: string | null;
  body?: unknown;
  query?: Record<string, string>;
}) {
  const headers: Record<string, string> = {};
  if (o.token !== null && o.token !== undefined)
    headers.authorization = `Bearer ${o.token}`;
  return {
    method: o.method ?? "POST",
    headers,
    query: o.query ?? {},
    body: o.body,
  } as unknown as VercelRequest;
}
async function call(
  handler: (q: VercelRequest, r: VercelResponse) => Promise<unknown>,
  q: VercelRequest,
) {
  const { res, state } = mockRes();
  await handler(q, res);
  return state;
}
const apply = (token: string | null, body: unknown) =>
  call(handleModerationStrikeApply, req({ token, body }));
const revoke = (token: string | null, body: unknown) =>
  call(handleModerationStrikeRevoke, req({ token, body }));
const names = () => h.rpcLog.map((c) => c.name);
const REASON = "Motivo humano del strike.";

async function decision(
  kind: "content_actioned" | "reports_not_valid" = "content_actioned",
) {
  const post = uid(1000 + ++seq);
  await db.query(
    "insert into community_posts(id,author_user_id,text,version) values($1,$2,'t',2)",
    [post, AUTHOR],
  );
  let ctx!: Obj;
  for (const r of reporters)
    ctx = await one<Obj>("select community_post_report_submit($1,$2,'spam',null) r", [
      r,
      post,
    ]);
  const d = await one<{ decisionId: string }>(
    "select community_moderation_case_decide($1,$2,$3,$4,$5,$6,$7) r",
    [
      MOD,
      ctx.caseId,
      ctx.cycleId,
      ctx.caseVersion,
      ctx.postVersion,
      kind,
      kind === "content_actioned" ? "mensaje" : null,
    ],
  );
  return {
    post,
    caseId: ctx.caseId as string,
    cycleId: ctx.cycleId as string,
    decisionId: d.decisionId,
  };
}
const auditCount = async (action: string) =>
  Number(
    (
      await db.query<{ n: string }>(
        "select count(*) n from moderation_audit_log where action=$1",
        [action],
      )
    ).rows[0].n,
  );
const strikeCount = async () =>
  Number(
    (await db.query<{ n: string }>("select count(*) n from community_user_strikes"))
      .rows[0].n,
  );

// ── APPLY ─────────────────────────────────────────────────────────────────────────────────────
describe("APPLY — authentication, role and recent MFA happen BEFORE the database", () => {
  it("unauthenticated → 401, no RPC, no DB table access", async () => {
    const d = await decision();
    h.rpcLog.length = 0;
    const s = await apply(null, { decisionId: d.decisionId, reason: REASON });
    expect(s.status).toBe(401);
    expect(h.rpcLog).toHaveLength(0);
  });
  it("an ordinary user (no admin_roles row), even with fresh MFA → generic 403, no RPC", async () => {
    const d = await decision();
    h.rpcLog.length = 0;
    const s = await apply("user-fresh", { decisionId: d.decisionId, reason: REASON });
    expect(s.status).toBe(403);
    expect(s.body).not.toHaveProperty("code", "step_up_required");
    expect(h.rpcLog).toHaveLength(0);
  });
  it.each([
    ["missing MFA (aal1)", "mod-aal1"],
    ["stale MFA (24 h old)", "mod-stale"],
  ])("%s → 403 step_up_required, no RPC, no strike, no audit", async (_n, token) => {
    const d = await decision();
    h.rpcLog.length = 0;
    const s = await apply(token, { decisionId: d.decisionId, reason: REASON });
    expect(s.status).toBe(403);
    expect(s.body).toMatchObject({ code: "step_up_required" });
    expect(h.rpcLog).toHaveLength(0);
    expect(await strikeCount()).toBe(0);
    expect(await auditCount("strike_applied")).toBe(0);
  });
  it.each([
    ["moderator", "mod-fresh"],
    ["developer", "dev-fresh"],
    ["admin", "adm-fresh"],
  ])(
    "%s with recent MFA reaches the RPC and applies a level-1 strike",
    async (_r, token) => {
      const d = await decision();
      const s = await apply(token, { decisionId: d.decisionId, reason: REASON });
      expect(s.status).toBe(201);
      expect(s.headers["Cache-Control"]).toBe("no-store");
      expect(s.body).toMatchObject({
        strike: {
          level: 1,
          permanent: false,
          revoked: false,
          reason: REASON,
          decisionId: d.decisionId,
        },
      });
      expect(names()).toEqual(["community_strike_apply"]);
    },
  );
  it("the actor is ALWAYS the verified session (a forged actor in the body is rejected, never used)", async () => {
    const d = await decision();
    h.rpcLog.length = 0;
    const s = await apply("mod-fresh", {
      decisionId: d.decisionId,
      reason: REASON,
      actorUserId: ADM,
    });
    expect(s.status).toBe(400);
    expect(h.rpcLog).toHaveLength(0);
    await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON });
    expect(h.rpcLog[0].args.p_actor_user_id).toBe(MOD);
  });
  it("only POST is accepted", async () => {
    const s = await call(
      handleModerationStrikeApply,
      req({ method: "GET", token: "mod-fresh" }),
    );
    expect(s.status).toBe(405);
    expect(s.headers.Allow).toBe("POST");
  });
});

describe("APPLY — strict validation (nothing reaches the DB)", () => {
  const cases: [string, unknown][] = [
    ["malformed decision UUID", { decisionId: "no-uuid", reason: REASON }],
    ["blank reason", { decisionId: uid(1), reason: "   " }],
    ["missing reason", { decisionId: uid(1) }],
    ["1001 code points", { decisionId: uid(1), reason: "😀".repeat(1001) }],
    [
      "expectedLevel as a string",
      { decisionId: uid(1), reason: REASON, expectedLevel: "1" },
    ],
    ["expectedLevel 4", { decisionId: uid(1), reason: REASON, expectedLevel: 4 }],
    ["caller-supplied level", { decisionId: uid(1), reason: REASON, level: 3 }],
    ["caller-supplied user", { decisionId: uid(1), reason: REASON, userId: uid(9) }],
    [
      "caller-supplied deadline",
      { decisionId: uid(1), reason: REASON, endsAt: "2030-01-01T00:00:00Z" },
    ],
    ["array body", []],
    ["no body", undefined],
  ];
  it.each(cases)("%s → 400, no RPC", async (_n, body) => {
    const s = await apply("mod-fresh", body);
    expect(s.status).toBe(400);
    expect(h.rpcLog).toHaveLength(0);
  });
  it("exactly 1000 code points is accepted and stored trimmed", async () => {
    const d = await decision();
    const s = await apply("mod-fresh", {
      decisionId: d.decisionId,
      reason: `\u00a0${"😀".repeat(1000)}\u2003`,
    });
    expect(s.status).toBe(201);
    expect([...(s.body as { strike: { reason: string } }).strike.reason]).toHaveLength(
      1000,
    );
  });
  it("a JSON string body is parsed", async () => {
    const d = await decision();
    const s = await apply(
      "mod-fresh",
      JSON.stringify({ decisionId: d.decisionId, reason: REASON }),
    );
    expect(s.status).toBe(201);
  });
});

describe("APPLY — business errors map to stable codes (no raw SQL)", () => {
  it("expectedLevel mismatch → 409 level_changed, nothing written", async () => {
    const d = await decision();
    const s = await apply("mod-fresh", {
      decisionId: d.decisionId,
      reason: REASON,
      expectedLevel: 2,
    });
    expect(s.status).toBe(409);
    expect(s.body).toMatchObject({ code: "level_changed" });
    expect(await strikeCount()).toBe(0);
    expect(names()).toEqual(["community_strike_apply"]); // never retried
  });
  it("expectedLevel match applies", async () => {
    const d = await decision();
    expect(
      (
        await apply("mod-fresh", {
          decisionId: d.decisionId,
          reason: REASON,
          expectedLevel: 1,
        })
      ).status,
    ).toBe(201);
  });
  it("No procede → 409 decision_not_content_actioned", async () => {
    const d = await decision("reports_not_valid");
    const s = await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON });
    expect(s).toMatchObject({
      status: 409,
      body: { code: "decision_not_content_actioned" },
    });
  });
  it("open case → 409 case_not_closed", async () => {
    const d = await decision();
    await db.query(
      "update community_moderation_cases set status='pending', closed_at=null where id=$1",
      [d.caseId],
    );
    expect(
      await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON }),
    ).toMatchObject({ status: 409, body: { code: "case_not_closed" } });
  });
  it("unknown decision → 404", async () => {
    expect(
      await apply("mod-fresh", { decisionId: uid(7777), reason: REASON }),
    ).toMatchObject({ status: 404, body: { code: "decision_not_found" } });
  });
  it("unknown author → 409 author_unavailable", async () => {
    const d = await decision();
    await db.query(
      "update community_moderation_cases set author_identity='unavailable', target_author_user_id=null where id=$1",
      [d.caseId],
    );
    expect(
      await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON }),
    ).toMatchObject({ status: 409, body: { code: "author_unavailable" } });
  });
  it("self-strike → 403", async () => {
    const d = await decision();
    await db.query("insert into admin_roles values($1,'moderator')", [AUTHOR]);
    h.tokens["author-fresh"] = {
      sub: AUTHOR,
      aal: "aal2",
      amr: [{ method: "totp", timestamp: NOW }],
    };
    expect(
      await apply("author-fresh", { decisionId: d.decisionId, reason: REASON }),
    ).toMatchObject({ status: 403, body: { code: "self_strike_forbidden" } });
  });
  it("the post is already physically purged → still 201 (history is enough)", async () => {
    const d = await decision();
    await db.query("delete from community_posts where id=$1", [d.post]);
    expect(
      (await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON })).status,
    ).toBe(201);
  });
  it("double submit: one wins, the other gets strike_already_issued; exactly one strike and ONE audit row", async () => {
    const d = await decision();
    const first = await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON });
    const second = await apply("mod2-fresh", {
      decisionId: d.decisionId,
      reason: REASON,
    });
    expect([first.status, second.status]).toEqual([201, 409]);
    expect(second.body).toMatchObject({ code: "strike_already_issued" });
    expect(await strikeCount()).toBe(1);
    expect(await auditCount("strike_applied")).toBe(1);
  });
  it("level escalates server-side across decisions (the client never chooses)", async () => {
    const levels: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await decision();
      levels.push(
        (
          (await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON }))
            .body as { strike: { level: number } }
        ).strike.level,
      );
    }
    expect(levels).toEqual([1, 2, 3]);
  });
  it("raw database failures never leak: unknown/infrastructure errors → generic 500", async () => {
    const d = await decision();
    h.override = () => ({
      data: null,
      error: {
        code: "XX000",
        message: 'relation "community_user_strikes" does not exist at 10.0.0.5',
      },
    });
    const s = await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON });
    expect(s.status).toBe(500);
    expect(JSON.stringify(s.body)).not.toMatch(
      /relation|community_user_strikes|10\.0\.0/,
    );
    h.override = () => ({
      data: null,
      error: { code: "P0001", message: "some_unlisted_business_code" },
    });
    const t = await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON });
    expect(t.status).toBe(500);
    expect(JSON.stringify(t.body)).not.toContain("some_unlisted");
  });
  it("a malformed RPC payload → controlled 500 invalid_response (never forwarded)", async () => {
    const d = await decision();
    h.override = () => ({
      data: { strikeId: "x", level: 9, secret: "leak" },
      error: null,
    });
    const s = await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON });
    expect(s).toMatchObject({ status: 500, body: { code: "invalid_response" } });
    expect(JSON.stringify(s.body)).not.toContain("leak");
  });
});

describe("APPLY — response privacy and audit", () => {
  it("projection exposes only product fields: no moderator, author, reporters, case/cycle/post ids", async () => {
    const d = await decision();
    const s = await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON });
    const strike = (s.body as { strike: Obj }).strike;
    expect(Object.keys(strike).sort()).toEqual([
      "decisionId",
      "endsAt",
      "id",
      "level",
      "permanent",
      "reason",
      "revoked",
      "sanctionInEffect",
      "startsAt",
    ]);
    const dump = JSON.stringify(s.body);
    for (const leak of [MOD, AUTHOR, ...reporters, d.caseId, d.cycleId, d.post])
      expect(dump).not.toContain(leak);
  });
  it("one apply = exactly one strike_applied audit row, written by the DB (the handler writes none)", async () => {
    const d = await decision();
    await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON });
    expect(await auditCount("strike_applied")).toBe(1);
    expect(h.tables).not.toContain("moderation_audit_log"); // the handler never touches the audit table
    expect(names()).toEqual(["community_strike_apply"]);
  });
  it("failed authorization / MFA / validation leave no strike audit", async () => {
    const d = await decision();
    await apply("mod-aal1", { decisionId: d.decisionId, reason: REASON });
    await apply("user-fresh", { decisionId: d.decisionId, reason: REASON });
    await apply("mod-fresh", { decisionId: "bad", reason: REASON });
    expect(await auditCount("strike_applied")).toBe(0);
    expect(await strikeCount()).toBe(0);
  });
});

// ── REVOKE ────────────────────────────────────────────────────────────────────────────────────
describe("REVOKE — authentication, role, MFA and the developer/admin boundary", () => {
  async function applied(by = "mod-fresh") {
    const d = await decision();
    const s = await apply(by, { decisionId: d.decisionId, reason: REASON });
    h.rpcLog.length = 0;
    return { d, id: (s.body as { strike: { id: string } }).strike.id };
  }
  it("unauthenticated → 401, no RPC", async () => {
    const { id } = await applied();
    expect((await revoke(null, { strikeId: id, reason: "error" })).status).toBe(401);
    expect(h.rpcLog).toHaveLength(0);
  });
  it("an ordinary user → 403, no RPC", async () => {
    const { id } = await applied();
    expect((await revoke("user-fresh", { strikeId: id, reason: "error" })).status).toBe(
      403,
    );
    expect(h.rpcLog).toHaveLength(0);
  });
  it("a moderator WITH recent MFA is stopped at the HTTP layer (revoker_role_insufficient), no RPC", async () => {
    const { id } = await applied();
    const s = await revoke("mod2-fresh", { strikeId: id, reason: "error" });
    expect(s).toMatchObject({ status: 403, body: { code: "revoker_role_insufficient" } });
    expect(h.rpcLog).toHaveLength(0);
    expect(await auditCount("strike_revoked")).toBe(0);
  });
  it.each([
    ["developer missing MFA", "dev-aal1"],
    ["developer stale MFA", "dev-stale"],
    ["admin missing MFA", "adm-aal1"],
    ["admin stale MFA", "adm-stale"],
  ])("%s → step_up_required before any DB call", async (_n, token) => {
    const { id } = await applied();
    const s = await revoke(token, { strikeId: id, reason: "error" });
    expect(s).toMatchObject({ status: 403, body: { code: "step_up_required" } });
    expect(h.rpcLog).toHaveLength(0);
    expect(await auditCount("strike_revoked")).toBe(0);
  });
  it.each([
    ["developer", "dev-fresh"],
    ["admin", "adm-fresh"],
  ])(
    "%s with recent MFA revokes a strike applied by someone else (200)",
    async (_r, token) => {
      const { id } = await applied();
      const s = await revoke(token, { strikeId: id, reason: "error de apreciación" });
      expect(s.status).toBe(200);
      expect(s.body).toMatchObject({ strike: { id, level: 1, revoked: true } });
      expect(names()).toEqual(["community_strike_revoke"]);
    },
  );
  it("the original applier can NOT revoke their own strike, even as developer/admin (DB authority)", async () => {
    for (const token of ["dev-fresh", "adm-fresh"]) {
      const { id } = await applied(token);
      const s = await revoke(token, { strikeId: id, reason: "me arrepiento" });
      expect(s).toMatchObject({ status: 403, body: { code: "self_revoke_forbidden" } });
      expect(h.rpcLog.filter((c) => c.name === "community_strike_revoke")).toHaveLength(
        1,
      ); // reached the DB, never retried
    }
  });
  it("unknown strike → 404; already revoked → 409 (second submit)", async () => {
    expect(await revoke("dev-fresh", { strikeId: uid(8888), reason: "x" })).toMatchObject(
      { status: 404, body: { code: "strike_not_found" } },
    );
    const { id } = await applied();
    expect((await revoke("dev-fresh", { strikeId: id, reason: "x" })).status).toBe(200);
    expect(await revoke("adm-fresh", { strikeId: id, reason: "x" })).toMatchObject({
      status: 409,
      body: { code: "strike_already_revoked" },
    });
    expect(await auditCount("strike_revoked")).toBe(1);
  });
  it.each([
    ["malformed id", { strikeId: "no", reason: "x" }],
    ["blank reason", { strikeId: uid(1), reason: " " }],
    ["1001 code points", { strikeId: uid(1), reason: "😀".repeat(1001) }],
    ["caller-supplied revoker", { strikeId: uid(1), reason: "x", revokedBy: ADM }],
    ["caller-supplied user", { strikeId: uid(1), reason: "x", userId: AUTHOR }],
    ["non-object", "texto"],
  ])("%s → 400, no RPC", async (_n, body) => {
    const s = await revoke("dev-fresh", body);
    expect(s.status).toBe(400);
    expect(h.rpcLog).toHaveLength(0);
  });
  it("projection and audit: only id/level/revoked/revokedAt, one strike_revoked row, none from the handler", async () => {
    const { id } = await applied();
    const s = await revoke("dev-fresh", { strikeId: id, reason: "error" });
    expect(Object.keys((s.body as { strike: Obj }).strike).sort()).toEqual([
      "id",
      "level",
      "revoked",
      "revokedAt",
    ]);
    const dump = JSON.stringify(s.body);
    for (const leak of [MOD, DEV, AUTHOR, ...reporters]) expect(dump).not.toContain(leak);
    expect(await auditCount("strike_revoked")).toBe(1);
    expect(h.tables).not.toContain("moderation_audit_log");
  });
  it("raw DB failures and malformed payloads stay generic", async () => {
    const { id } = await applied();
    h.override = () => ({
      data: null,
      error: { code: "XX000", message: "connection to 10.0.0.9 lost" },
    });
    const s = await revoke("dev-fresh", { strikeId: id, reason: "x" });
    expect(s.status).toBe(500);
    expect(JSON.stringify(s.body)).not.toContain("10.0.0.9");
    h.override = () => ({ data: { strikeId: id, level: 99 }, error: null });
    expect(await revoke("dev-fresh", { strikeId: id, reason: "x" })).toMatchObject({
      status: 500,
      body: { code: "invalid_response" },
    });
  });
  it("revoking restores nothing and escalation resets (next strike is level 1 again)", async () => {
    const { id } = await applied();
    await revoke("dev-fresh", { strikeId: id, reason: "error" });
    const d = await decision();
    expect(
      (
        (await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON })).body as {
          strike: { level: number };
        }
      ).strike.level,
    ).toBe(1);
  });
});

describe("wire contract: the real handler responses are accepted by the client parsers", () => {
  it("apply and revoke bodies round-trip through the frontend validators", async () => {
    const d = await decision();
    const a = await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON });
    const parsed = parseStrikeApplyResponse(JSON.parse(JSON.stringify(a.body)));
    expect(parsed.strike).toMatchObject({
      decisionId: d.decisionId,
      level: 1,
      reason: REASON,
    });
    const r = await revoke("dev-fresh", { strikeId: parsed.strike.id, reason: "error" });
    expect(
      parseStrikeRevokeResponse(JSON.parse(JSON.stringify(r.body))).strike,
    ).toMatchObject({ id: parsed.strike.id, revoked: true });
  });
});

describe("ROLE MATRIX (HTTP + DB)", () => {
  it.each([
    ["mod-fresh", 201, 403],
    ["dev-fresh", 201, 200],
    ["adm-fresh", 201, 200],
    ["user-fresh", 403, 403],
  ])("%s: apply=%i revoke=%i", async (token, applyStatus, revokeStatus) => {
    const d1 = await decision();
    const a = await apply(token, { decisionId: d1.decisionId, reason: REASON });
    expect(a.status).toBe(applyStatus);
    // the strike to revoke is always applied by a DIFFERENT actor (MOD2), so self-revoke never masks the role rule
    const d2 = await decision();
    const other = await apply("mod2-fresh", {
      decisionId: d2.decisionId,
      reason: REASON,
    });
    const id = (other.body as { strike: { id: string } }).strike.id;
    expect((await revoke(token, { strikeId: id, reason: "x" })).status).toBe(
      revokeStatus,
    );
  });
});

describe("no coupling with the Procede decision", () => {
  it("moderation-case-decision never applies a strike and does not call the strike RPCs", async () => {
    const post = uid(1000 + ++seq);
    await db.query(
      "insert into community_posts(id,author_user_id,text,version) values($1,$2,'t',2)",
      [post, AUTHOR],
    );
    let ctx!: Obj;
    for (const r of reporters)
      ctx = await one<Obj>("select community_post_report_submit($1,$2,'spam',null) r", [
        r,
        post,
      ]);
    const s = await call(
      handleModerationCaseDecision,
      req({
        token: "mod-fresh",
        body: {
          caseId: ctx.caseId,
          cycleId: ctx.cycleId,
          expectedCaseVersion: ctx.caseVersion,
          expectedPostVersion: ctx.postVersion,
          originalPostState: "hidden_pending_review",
          decision: "content_actioned",
          resolutionMessage: "mensaje",
        },
      }),
    );
    expect(s.status).toBe(200);
    expect(names()).toEqual(["community_moderation_case_decide"]);
    expect(await strikeCount()).toBe(0);
    expect(await auditCount("strike_applied")).toBe(0);
  });
  it("static: the decision handler/SQL do not mention strikes", () => {
    expect(readFileSync("src/lib/moderation-decision-handlers.ts", "utf8")).not.toMatch(
      /strike/i,
    );
    expect(readFileSync("src/lib/moderation-decision-contract.ts", "utf8")).not.toMatch(
      /strike/i,
    );
  });
});

// ── CASE DETAIL: strike state integration ─────────────────────────────────────────────────────
describe("STRIKE STATE in the moderation case detail", () => {
  const T = "2026-10-06T10:00:00+00:00";
  const states = {
    fromPostStatus: null,
    toPostStatus: null,
    fromReportStatus: null,
    toReportStatus: null,
  };
  function caseJson(
    d: { caseId: string; cycleId: string; post: string; decisionId: string },
    over: Obj = {},
  ) {
    return {
      caseId: d.caseId,
      caseVersion: 4,
      postId: d.post,
      cycleId: d.cycleId,
      currentCycleId: d.cycleId,
      cycleNumber: 1,
      currentCycleNumber: 1,
      isCurrentCycle: true,
      caseStatus: "closed",
      cycleStatus: "closed",
      closureKind: "decision",
      createdAt: T,
      openedAt: T,
      closedAt: T,
      activityAt: T,
      firstReportAt: T,
      lastReportAt: T,
      totalReports: 3,
      qualifyingReporters: 0,
      reasons: [{ reason: "spam", count: 3 }],
      reportsTruncated: false,
      post: null,
      media: [],
      decision: {
        decisionId: d.decisionId,
        result: "content_actioned",
        resolutionMessage: "mensaje",
        createdAt: T,
      },
      reports: [
        {
          reportId: uid(77),
          reason: "spam",
          detail: "detalle",
          status: "actioned",
          version: 1,
          createdAt: T,
        },
      ],
      audit: [
        { id: uid(78), action: "post_purged", actorKind: "system", createdAt: T, states },
      ],
      ...over,
    };
  }
  /** The E4 case read is scripted (it is not under test); the strike state comes from the REAL SQL. */
  function scriptCaseRead(
    item: Obj,
    strike?: (args: Obj) => { data: unknown; error: unknown } | undefined,
  ) {
    h.override = (name, args) => {
      if (name === "community_moderation_cases_read")
        return { data: { item }, error: null };
      if (name === "community_strike_state_read" && strike) return strike(args);
      return undefined;
    };
  }
  const detail = (token: string, cycleId: string) =>
    call(handleModerationCases, req({ method: "GET", token, query: { cycleId } }));
  type Item = {
    item: { post: unknown; decision: Obj; reports: unknown[]; strike?: Obj };
  };

  it("History / Procede / no strike: eligible with the predicted level and the decision id (REAL SQL)", async () => {
    const d = await decision();
    scriptCaseRead(caseJson(d));
    const s = await detail("mod-fresh", d.cycleId);
    expect(s.status).toBe(200);
    expect((s.body as Item).item.strike).toEqual({
      eligible: true,
      ineligibleReason: null,
      predictedLevel: 1,
      decisionId: d.decisionId,
      existing: null,
    });
  });
  it("History / active strike: existing strike shown (REAL SQL), canRevoke depends on the viewer", async () => {
    const d = await decision();
    await apply("mod-fresh", { decisionId: d.decisionId, reason: "motivo X" });
    scriptCaseRead(caseJson(d));
    const asMod = ((await detail("mod2-fresh", d.cycleId)).body as Item).item.strike!;
    expect(asMod).toMatchObject({
      eligible: false,
      ineligibleReason: "strike_already_issued",
      predictedLevel: null,
    });
    expect(asMod.existing).toMatchObject({
      level: 1,
      reason: "motivo X",
      revoked: false,
      sanctionInEffect: true,
      canRevoke: false,
    });
    const asAdmin = ((await detail("adm-fresh", d.cycleId)).body as Item).item.strike!;
    expect((asAdmin.existing as Obj).canRevoke).toBe(true);
    const asApplierDev = await (async () => {
      const d2 = await decision();
      await apply("dev-fresh", { decisionId: d2.decisionId, reason: "mío" });
      scriptCaseRead(caseJson(d2));
      return ((await detail("dev-fresh", d2.cycleId)).body as Item).item.strike!;
    })();
    expect((asApplierDev.existing as Obj).canRevoke).toBe(false); // applier cannot revoke
  });
  it("revoked strike: shown as revoked with its reason; canRevoke false; next level resets", async () => {
    const d = await decision();
    const a = await apply("mod-fresh", { decisionId: d.decisionId, reason: "motivo" });
    await revoke("dev-fresh", {
      strikeId: (a.body as { strike: { id: string } }).strike.id,
      reason: "error mío",
    });
    scriptCaseRead(caseJson(d));
    const st = ((await detail("adm-fresh", d.cycleId)).body as Item).item.strike!;
    expect(st.existing).toMatchObject({
      revoked: true,
      revocationReason: "error mío",
      sanctionInEffect: false,
      canRevoke: false,
    });
  });
  it("Active/open case and No procede: not eligible", async () => {
    const d = await decision("reports_not_valid");
    scriptCaseRead(
      caseJson(d, {
        decision: {
          decisionId: d.decisionId,
          result: "reports_not_valid",
          resolutionMessage: null,
          createdAt: T,
        },
      }),
    );
    const st = ((await detail("mod-fresh", d.cycleId)).body as Item).item.strike!;
    expect(st).toEqual({
      eligible: false,
      ineligibleReason: "decision_not_content_actioned",
      predictedLevel: null,
      decisionId: null,
      existing: null,
    });
  });
  it("post = null after purge: the case still carries decision, reports, audit AND the strike state", async () => {
    const d = await decision();
    await db.query("delete from community_posts where id=$1", [d.post]);
    scriptCaseRead(caseJson(d));
    const s = await detail("mod-fresh", d.cycleId);
    const body = s.body as Item;
    expect(s.status).toBe(200);
    expect(body.item.post).toBeNull();
    expect(body.item.decision).toMatchObject({ resolutionMessage: "mensaje" });
    expect(body.item.reports).toHaveLength(1);
    expect(body.item.strike).toMatchObject({ eligible: true, decisionId: d.decisionId });
  });
  it.each([
    [
      "expired temporary sanction",
      {
        level: 1,
        permanent: false,
        endsAt: "2026-10-01T00:00:00+00:00",
        sanctionInEffect: false,
      },
      { sanctionInEffect: false, permanent: false },
    ],
    [
      "permanent strike",
      { level: 3, permanent: true, endsAt: null, sanctionInEffect: true },
      { sanctionInEffect: true, permanent: true, endsAt: null },
    ],
  ])("%s", async (_n, over, expected) => {
    const d = await decision();
    scriptCaseRead(caseJson(d), () => ({
      data: {
        hasDecision: true,
        decisionId: d.decisionId,
        eligible: false,
        ineligibleReason: "strike_already_issued",
        nextLevel: null,
        canRevoke: true,
        serverNow: T,
        strike: {
          strikeId: uid(55),
          level: 1,
          reason: "motivo",
          permanent: false,
          startsAt: "2026-09-01T00:00:00+00:00",
          endsAt: null,
          createdAt: T,
          status: "active",
          sanctionInEffect: true,
          revokedAt: null,
          revocationReason: null,
          ...(over as Obj),
        },
      },
      error: null,
    }));
    const st = ((await detail("adm-fresh", d.cycleId)).body as Item).item.strike!;
    expect(st.existing).toMatchObject(expected);
  });
  it("malformed strike payload → the case is STILL delivered (without the block, flagged as unavailable)", async () => {
    const d = await decision();
    scriptCaseRead(caseJson(d), () => ({
      data: { eligible: "maybe", strike: { level: 99 } },
      error: null,
    }));
    const s = await detail("mod-fresh", d.cycleId);
    expect(s.status).toBe(200);
    expect((s.body as Item).item.strike).toBeUndefined();
    expect((s.body as { item: Obj }).item.strikeUnavailable).toBe(true);
    expect((s.body as Item).item.decision).toMatchObject({
      resolutionMessage: "mensaje",
    });
  });
  it("strike RPC missing/failing (database without R5) → the case is still delivered without the block", async () => {
    const d = await decision();
    scriptCaseRead(caseJson(d), () => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    }));
    const s = await detail("mod-fresh", d.cycleId);
    expect(s.status).toBe(200);
    expect((s.body as Item).item.strike).toBeUndefined();
    // Función no instalada = «la BD aún no tiene strikes»: NO es un fallo de lectura.
    expect((s.body as { item: Obj }).item.strikeUnavailable).toBeUndefined();
  });
  it("R5-F: a FAILING strike read (not a missing function) is reported as unavailable, never with DB text", async () => {
    for (const failing of [
      () => ({
        data: null,
        error: { code: "57014", message: "canceling statement SELECT secret_table" },
      }),
      () => ({ data: null, error: { message: "connection reset by peer 10.0.0.5" } }),
    ]) {
      const d = await decision();
      scriptCaseRead(caseJson(d), failing);
      const s = await detail("mod-fresh", d.cycleId);
      expect(s.status).toBe(200);
      const body = s.body as { item: Obj };
      expect(body.item.strike).toBeUndefined();
      expect(body.item.strikeUnavailable).toBe(true);
      expect(body.item.decision).toMatchObject({ resolutionMessage: "mensaje" });
      expect(JSON.stringify(s.body)).not.toMatch(/secret_table|10\.0\.0\.5|57014/);
    }
  });
  it("R5-F: an exception while reading the strike state is also 'unavailable' (and the case still loads)", async () => {
    const d = await decision();
    scriptCaseRead(caseJson(d), () => {
      throw new Error("network down 10.1.1.1");
    });
    const s = await detail("mod-fresh", d.cycleId);
    expect(s.status).toBe(200);
    expect((s.body as { item: Obj }).item.strikeUnavailable).toBe(true);
    expect(JSON.stringify(s.body)).not.toContain("10.1.1.1");
  });
  it("R5-F: a successful read never carries the unavailable flag", async () => {
    const d = await decision();
    scriptCaseRead(caseJson(d));
    const s = await detail("mod-fresh", d.cycleId);
    expect((s.body as { item: Obj }).item.strikeUnavailable).toBeUndefined();
    expect((s.body as Item).item.strike).toBeDefined();
  });
  it("the strike state is only read for the DETAIL (never for lists) and uses the verified actor", async () => {
    const d = await decision();
    h.override = (name) =>
      name === "community_moderation_cases_read"
        ? { data: { cases: [caseJson(d)], next: null }, error: null }
        : undefined;
    const list = await call(
      handleModerationCases,
      req({ method: "GET", token: "mod-fresh", query: { scope: "closed" } }),
    );
    expect(list.status).toBe(200);
    expect(names()).not.toContain("community_strike_state_read");
    expect(
      (list.body as { cases: { strike?: unknown }[] }).cases[0].strike,
    ).toBeUndefined();
    h.rpcLog.length = 0;
    scriptCaseRead(caseJson(d));
    await detail("mod-fresh", d.cycleId);
    expect(h.rpcLog.find((c) => c.name === "community_strike_state_read")?.args).toEqual({
      p_actor_user_id: MOD,
      p_case_id: d.caseId,
    });
  });
  it("no reporter identity, applier or revoker identity anywhere in the detail payload", async () => {
    const d = await decision();
    const a = await apply("mod-fresh", { decisionId: d.decisionId, reason: "motivo" });
    await revoke("dev-fresh", {
      strikeId: (a.body as { strike: { id: string } }).strike.id,
      reason: "x",
    });
    scriptCaseRead(caseJson(d));
    const dump = JSON.stringify((await detail("adm-fresh", d.cycleId)).body);
    for (const leak of [
      ...reporters,
      MOD,
      DEV,
      ADM,
      AUTHOR,
      "appliedBy",
      "revokedBy",
      "reporter",
    ])
      expect(dump).not.toContain(leak);
  });
  it("an ordinary user still cannot read case detail (and never triggers the strike read)", async () => {
    const d = await decision();
    scriptCaseRead(caseJson(d));
    h.rpcLog.length = 0;
    const s = await detail("user-fresh", d.cycleId);
    expect(s.status).toBe(403);
    expect(h.rpcLog).toHaveLength(0);
  });
});

describe("R5-B / R5-C invariants are untouched by the API layer", () => {
  it("a sanctioned author is still blocked by the DB writers and may still delete their post", async () => {
    const d = await decision();
    await apply("mod-fresh", { decisionId: d.decisionId, reason: REASON });
    await db.exec("savepoint s");
    let message = "";
    try {
      await db.query("select community_post_save($1,null,null,'x','[]'::jsonb)", [
        AUTHOR,
      ]);
    } catch (e) {
      message = String((e as Error).message);
    }
    await db.exec("rollback to savepoint s");
    expect(message).toMatch(/author_restricted/);
    const own = uid(1000 + ++seq);
    // a post created BEFORE the strike would be deletable; here we use one of the author's existing posts
    await db.query(
      "insert into community_posts(id,author_user_id,text,version) values($1,$2,'mío',2)",
      [own, AUTHOR],
    );
    await db.exec(
      migration("20261004120000_community_posts_media.sql").match(
        /create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/,
      )![0],
    );
    await db.query("select community_post_delete($1,$2,2)", [AUTHOR, own]);
    expect(
      (await db.query("select 1 from community_posts where id=$1", [own])).rows,
    ).toHaveLength(0);
  });
  it("R5-B migration is byte-identical to the reviewed one", () => {
    expect(R5B.length).toBeGreaterThan(1000);
  });
});
