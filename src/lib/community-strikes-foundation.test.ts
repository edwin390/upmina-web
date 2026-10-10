// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// R5-B: fundación de strikes (solo BD). SQL REAL de las migraciones hasta 20261023 sobre PGlite.
// El reloj de las funciones de strike se sustituye por un seam SOLO dentro de la transacción de
// prueba (la migración no tiene parámetro "now"). PGlite es de una sola conexión: la concurrencia
// real entre sesiones NO se prueba aquí (queda para el smoke de Testing R5-F); se prueban las
// restricciones, la unicidad y el orden canónico de adquisición de locks en el código.

const migration = (n: string) => readFileSync(`supabase/migrations/${n}`, "utf8");
const R5B = migration("20261023120000_community_strikes_foundation.sql");
const uid = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOD = uid(1);
const MOD2 = uid(2);
const DEV = uid(3);
const ADM = uid(4);
const NOBODY = uid(5);
const reporters = [11, 12, 13].map(uid);
const AUTHOR = ACTOR; // the harness profile / author
const REASON = "Motivo humano del strike: contenido contrario a las normas.";
let db: TestDatabase;
let seq = 0;

interface Obj {
  [key: string]: unknown;
}
const one = async <T = Obj>(sql: string, params: unknown[] = []) =>
  (await db.query<{ r: T }>(sql, params)).rows[0].r;

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
    "20261022120000_moderation_purged_history_read.sql",
    "20261023120000_community_strikes_foundation.sql",
  ])
    await db.exec(migration(n));
  await db.exec(
    migration("20261004120000_community_posts_media.sql").match(
      /create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/,
    )![0],
  );
  for (const [id, role] of [
    [MOD, "moderator"],
    [MOD2, "moderator"],
    [DEV, "developer"],
    [ADM, "admin"],
  ])
    await db.query("insert into admin_roles values($1,$2)", [id, role]);
  for (const id of [MOD, MOD2, DEV, ADM, NOBODY, ...reporters])
    await db.query("insert into auth.users values($1) on conflict do nothing", [id]);
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
    /* aborted transaction */
  }
  await db.exec("rollback");
});

/** Production definitions with ONLY the clock replaced (rolled back with the test). */
async function setupClock(iso: string) {
  for (const name of [
    "community_strike_apply",
    "community_strike_revoke",
    "community_author_restriction",
    "community_strike_state_read",
  ]) {
    const src = R5B.match(
      new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
    )![0];
    expect(src).toContain("clock_timestamp()");
    await db.exec(
      src
        .replace("create function", "create or replace function")
        .replaceAll(
          "clock_timestamp()",
          "current_setting('upmina.test_now')::timestamptz",
        ),
    );
  }
  await setNow(iso);
}
const setNow = (iso: string) =>
  db.query("select set_config('upmina.test_now', $1, true)", [iso]);

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
      kind === "content_actioned" ? "mensaje del moderador" : null,
    ],
  );
  return {
    post,
    caseId: ctx.caseId as string,
    cycleId: ctx.cycleId as string,
    decisionId: d.decisionId,
  };
}
const apply = (
  actor: string,
  decisionId: string,
  reason: string | null = REASON,
  expected: number | null = null,
) =>
  one<{
    strikeId: string;
    level: number;
    permanent: boolean;
    startsAt: string;
    endsAt: string | null;
  }>("select community_strike_apply($1,$2,$3,$4) r", [
    actor,
    decisionId,
    reason,
    expected,
  ]);
const revoke = (
  actor: string,
  strikeId: string,
  reason: string | null = "Revocación justificada",
) =>
  one<{ strikeId: string }>("select community_strike_revoke($1,$2,$3) r", [
    actor,
    strikeId,
    reason,
  ]);
const restriction = (user = AUTHOR) =>
  one<{
    restricted: boolean;
    level?: number;
    permanent?: boolean;
    endsAt?: string | null;
    reason?: string;
  }>("select community_author_restriction($1) r", [user]);
/** Runs a statement that must fail, isolated by a savepoint so the transaction stays usable. */
async function fails(sql: string, params: unknown[], code: string | RegExp) {
  await db.exec("savepoint s");
  let message = "";
  try {
    await db.query(sql, params);
  } catch (e) {
    message = String((e as Error).message);
  }
  await db.exec("rollback to savepoint s");
  expect(message).not.toBe("");
  expect(message).toMatch(code);
}
const failApply = (
  actor: string,
  d: string,
  code: string | RegExp,
  reason: string | null = REASON,
  expected: number | null = null,
) =>
  fails("select community_strike_apply($1,$2,$3,$4)", [actor, d, reason, expected], code);
const failRevoke = (
  actor: string,
  s: string,
  code: string | RegExp,
  reason: string | null = "Revocación justificada",
) => fails("select community_strike_revoke($1,$2,$3)", [actor, s, reason], code);
const strikeCount = async () =>
  Number(
    (await db.query<{ n: string }>("select count(*) n from community_user_strikes"))
      .rows[0].n,
  );

describe("apply: escalation and sanction", () => {
  it("1st strike = level 1, exactly 14 days, server clock", async () => {
    await setupClock("2026-03-01T10:00:00Z");
    const { decisionId } = await decision();
    const s = await apply(MOD, decisionId);
    expect(s).toMatchObject({ level: 1, permanent: false });
    expect(new Date(s.endsAt!).getTime() - new Date(s.startsAt).getTime()).toBe(
      14 * 86400000,
    );
    expect(s.startsAt).toMatch(/^2026-03-01T10:00:00/);
  });
  it("2nd non-revoked = level 2 (1 calendar month UTC); 3rd = permanent; 4th stays level 3", async () => {
    await setupClock("2026-01-01T00:00:00Z");
    const levels: number[] = [];
    let last!: { permanent: boolean; endsAt: string | null };
    for (let i = 0; i < 4; i++) {
      const { decisionId } = await decision();
      await setNow(`2026-01-0${i + 2}T00:00:00Z`);
      last = await apply(i % 2 ? MOD : MOD2, decisionId);
      levels.push(last ? (last as unknown as { level: number }).level : 0);
    }
    expect(levels).toEqual([1, 2, 3, 3]);
    expect(last).toMatchObject({ permanent: true, endsAt: null });
  });
  it("calendar month semantics: 31 Jan + 1 month = 28 Feb (stored, not recomputed)", async () => {
    await setupClock("2026-01-02T00:00:00Z");
    await apply(MOD, (await decision()).decisionId);
    await setNow("2026-01-31T10:00:00Z");
    const s = await apply(MOD, (await decision()).decisionId);
    expect(s).toMatchObject({ level: 2 });
    expect(new Date(s.endsAt!).toISOString()).toBe("2026-02-28T10:00:00.000Z");
  });
  it("an EXPIRED but non-revoked strike still escalates: next is level 2", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await apply(MOD, (await decision()).decisionId);
    await setNow("2026-04-15T00:00:00Z"); // 45 days later: sanction long over
    expect((await restriction()).restricted).toBe(false);
    expect(await apply(MOD, (await decision()).decisionId)).toMatchObject({ level: 2 });
  });
  it("a REVOKED strike no longer counts: next is level 1 again", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const first = await apply(MOD, (await decision()).decisionId);
    await revoke(DEV, first.strikeId);
    expect(await apply(MOD, (await decision()).decisionId)).toMatchObject({ level: 1 });
  });
  it("revoking level 2 while level 1 stays leaves the next one at level 2", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await apply(MOD, (await decision()).decisionId);
    const second = await apply(MOD, (await decision()).decisionId);
    await revoke(DEV, second.strikeId);
    expect(await apply(MOD, (await decision()).decisionId)).toMatchObject({ level: 2 });
  });
  it("expected_level is only a precondition: mismatch writes nothing, match proceeds", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const { decisionId } = await decision();
    await failApply(MOD, decisionId, /level_changed/, REASON, 2);
    expect(await strikeCount()).toBe(0);
    expect(await apply(MOD, decisionId, REASON, 1)).toMatchObject({ level: 1 });
  });
});

describe("apply: eligibility", () => {
  beforeEach(() => setupClock("2026-03-01T00:00:00Z"));
  it("No procede cannot strike", async () => {
    const { decisionId } = await decision("reports_not_valid");
    await failApply(MOD, decisionId, /decision_not_content_actioned/);
  });
  it("unknown decision", async () => {
    await failApply(MOD, uid(9999), /decision_not_found/);
  });
  it("a case that is not closed is rejected", async () => {
    const { decisionId, caseId } = await decision();
    await db.query(
      "update community_moderation_cases set status='pending', closed_at=null where id=$1",
      [caseId],
    );
    await failApply(MOD, decisionId, /case_not_closed/);
  });
  it("unknown author (identity unavailable) is rejected", async () => {
    const { decisionId, caseId } = await decision();
    await db.query(
      "update community_moderation_cases set author_identity='unavailable', target_author_user_id=null where id=$1",
      [caseId],
    );
    await failApply(MOD, decisionId, /author_unavailable/);
  });
  it("the author profile must exist", async () => {
    const { decisionId, caseId } = await decision();
    const ghost = uid(7777);
    await db.query(
      "update community_moderation_cases set target_author_user_id=$2 where id=$1",
      [caseId, ghost],
    );
    await failApply(MOD, decisionId, /author_unavailable/);
  });
  it("the actor cannot strike their own content", async () => {
    const { decisionId } = await decision();
    await db.query(
      "insert into admin_roles values($1,'moderator') on conflict do nothing",
      [AUTHOR],
    );
    await failApply(AUTHOR, decisionId, /self_strike_forbidden/);
  });
  it("a plain user or an unknown actor is rejected (role revalidated in the DB)", async () => {
    const { decisionId } = await decision();
    await failApply(NOBODY, decisionId, /actor_not_moderator/);
    await failApply(reporters[0], decisionId, /actor_not_moderator/);
  });
  it("a decision can produce ONE strike forever, even after revocation", async () => {
    const { decisionId } = await decision();
    const s = await apply(MOD, decisionId);
    await failApply(MOD2, decisionId, /strike_already_issued/);
    await revoke(DEV, s.strikeId);
    await failApply(MOD2, decisionId, /strike_already_issued/);
    expect(await strikeCount()).toBe(1);
  });
  it("physical purge of the post does not block (and does not invalidate) a strike", async () => {
    const { decisionId, post } = await decision();
    await db.query("delete from community_posts where id=$1", [post]);
    const s = await apply(MOD, decisionId);
    expect(s.level).toBe(1);
    expect(
      (
        await db.query(
          "select 1 from community_user_strikes where decision_id=$1 and post_id=$2",
          [decisionId, post],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("content deleted by the author BEFORE the decision cannot be struck (no Procede, no evidence)", async () => {
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
    await db.query("delete from community_posts where id=$1", [post]); // owner removed it
    // Procede is impossible without the post...
    await fails(
      "select community_moderation_case_decide($1,$2,$3,$4,null,'content_actioned','x')",
      [MOD, ctx.caseId, ctx.cycleId, ctx.caseVersion],
      /post_not_found/,
    );
    // ...so the only possible decision is No procede, which cannot strike.
    const d = await one<{ decisionId: string }>(
      "select community_moderation_case_decide($1,$2,$3,$4,null,'reports_not_valid',null) r",
      [MOD, ctx.caseId, ctx.cycleId, ctx.caseVersion],
    );
    await failApply(MOD, d.decisionId, /decision_not_content_actioned/);
  });
});

describe("apply: reason and Unicode length (code points, like resolution_message)", () => {
  beforeEach(() => setupClock("2026-03-01T00:00:00Z"));
  it.each([[null], [""], ["   "], ["  \t\n"]])(
    "blank reason %j is rejected",
    async (reason) => {
      const { decisionId } = await decision();
      await failApply(MOD, decisionId, /reason_required/, reason as string | null);
    },
  );
  it("exactly 1000 emoji (4000 bytes) is accepted; 1001 is rejected", async () => {
    const a = (await decision()).decisionId;
    const b = (await decision()).decisionId;
    const ok = await apply(MOD, a, "😀".repeat(1000));
    expect(ok.level).toBe(1);
    await failApply(MOD, b, /invalid_argument/, "😀".repeat(1001));
  });
  it("the reason is stored trimmed", async () => {
    const { decisionId } = await decision();
    await apply(MOD, decisionId, "  motivo  \n");
    expect(
      (await db.query<{ reason: string }>("select reason from community_user_strikes"))
        .rows[0].reason,
    ).toBe("motivo");
  });
  it("revocation reason follows the same rule", async () => {
    const s = await apply(MOD, (await decision()).decisionId);
    await failRevoke(DEV, s.strikeId, /reason_required/, "  ");
    await failRevoke(DEV, s.strikeId, /invalid_argument/, "😀".repeat(1001));
    await revoke(DEV, s.strikeId, "😀".repeat(1000));
  });
});

describe("revoke", () => {
  beforeEach(() => setupClock("2026-03-01T00:00:00Z"));
  it.each([
    ["developer", DEV],
    ["admin", ADM],
  ])("%s may revoke a strike they did not apply", async (_n, actor) => {
    const s = await apply(MOD, (await decision()).decisionId);
    await revoke(actor, s.strikeId);
    const row = (
      await db.query<{ revoked_by: string; revocation_reason: string }>(
        "select revoked_by, revocation_reason from community_user_strikes where id=$1",
        [s.strikeId],
      )
    ).rows[0];
    expect(row).toEqual({
      revoked_by: actor,
      revocation_reason: "Revocación justificada",
    });
  });
  it("a moderator can NOT revoke (deterministic business error)", async () => {
    const s = await apply(MOD, (await decision()).decisionId);
    await failRevoke(MOD2, s.strikeId, /revoker_role_insufficient/);
  });
  it("the actor who applied a strike cannot revoke it, even a developer/admin", async () => {
    const a = await apply(DEV, (await decision()).decisionId);
    await failRevoke(DEV, a.strikeId, /self_revoke_forbidden/);
    const b = await apply(ADM, (await decision()).decisionId);
    await failRevoke(ADM, b.strikeId, /self_revoke_forbidden/);
    await revoke(ADM, a.strikeId); // someone else can
  });
  it("already revoked / unknown strike / non-privileged actor", async () => {
    const s = await apply(MOD, (await decision()).decisionId);
    await revoke(DEV, s.strikeId);
    await failRevoke(ADM, s.strikeId, /strike_already_revoked/);
    await failRevoke(DEV, uid(8888), /strike_not_found/);
    await failRevoke(NOBODY, s.strikeId, /actor_not_moderator/);
  });
  it("revoking does not restore content and does not touch the decision/case history", async () => {
    const d = await decision();
    const s = await apply(MOD, d.decisionId);
    const before = await one<number>(
      "select (select count(*) from community_moderation_decisions)::int r",
    );
    await revoke(DEV, s.strikeId);
    expect(
      await one<number>(
        "select (select count(*) from community_moderation_decisions)::int r",
      ),
    ).toBe(before);
    expect(
      (
        await db.query<{ status: string }>(
          "select status from community_posts where id=$1",
          [d.post],
        )
      ).rows[0].status,
    ).toBe("removed_pending_purge");
  });
});

describe("restriction read", () => {
  it("active level 1 blocks; expired does not; revoked does not", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const s = await apply(MOD, (await decision()).decisionId);
    expect(await restriction()).toMatchObject({
      restricted: true,
      level: 1,
      permanent: false,
      reason: REASON,
    });
    await setNow("2026-03-15T00:00:00Z"); // exactly the deadline: no longer in the future
    expect((await restriction()).restricted).toBe(false);
    await setNow("2026-03-14T23:59:59Z");
    expect((await restriction()).restricted).toBe(true);
    await revoke(DEV, s.strikeId);
    expect((await restriction()).restricted).toBe(false);
  });
  it("active level 2 blocks; level 3 is permanent", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await apply(MOD, (await decision()).decisionId);
    await apply(MOD, (await decision()).decisionId);
    await setNow("2026-03-20T00:00:00Z"); // level 1 over, level 2 (until 1 Apr) still active
    expect(await restriction()).toMatchObject({
      restricted: true,
      level: 2,
      permanent: false,
    });
    await setNow("2026-03-01T00:00:00Z");
    await apply(MOD, (await decision()).decisionId);
    await setNow("2030-01-01T00:00:00Z");
    expect(await restriction()).toMatchObject({
      restricted: true,
      level: 3,
      permanent: true,
      endsAt: null,
    });
  });
  it("deterministic selection: permanent wins, then the furthest deadline; falls back after revocation", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await apply(MOD, (await decision()).decisionId); // L1 ends 15 Mar
    await apply(MOD, (await decision()).decisionId); // L2 ends 1 Apr
    const l3 = await apply(MOD, (await decision()).decisionId); // permanent
    expect(await restriction()).toMatchObject({ level: 3, permanent: true });
    await revoke(DEV, l3.strikeId);
    expect(await restriction()).toMatchObject({ level: 2, permanent: false });
    expect((await restriction()).endsAt).toMatch(/^2026-04-01T00:00:00/);
  });
  it("exposes only product fields (no ids, no moderator identity)", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await apply(MOD, (await decision()).decisionId);
    const r = await restriction();
    expect(Object.keys(r).sort()).toEqual([
      "endsAt",
      "level",
      "permanent",
      "reason",
      "restricted",
      "serverNow",
    ]);
    expect(JSON.stringify(r)).not.toContain(MOD);
  });
  it("users without strikes and other users are unaffected", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await apply(MOD, (await decision()).decisionId);
    expect(await restriction(reporters[0])).toMatchObject({ restricted: false });
  });
});

describe("strike state read (not an authority)", () => {
  beforeEach(() => setupClock("2026-03-01T00:00:00Z"));
  it("eligible Procede: predicted level, no strike, no identity or reporter data", async () => {
    const d = await decision();
    const s = await one<Obj>("select community_strike_state_read($1,$2) r", [
      MOD,
      d.caseId,
    ]);
    expect(s).toMatchObject({
      hasDecision: true,
      eligible: true,
      ineligibleReason: null,
      nextLevel: 1,
      strike: null,
      canRevoke: false,
    });
    const json = JSON.stringify(s);
    for (const id of [...reporters, MOD, AUTHOR]) expect(json).not.toContain(id);
  });
  it("No procede is not eligible", async () => {
    const d = await decision("reports_not_valid");
    expect(
      await one<Obj>("select community_strike_state_read($1,$2) r", [MOD, d.caseId]),
    ).toMatchObject({
      hasDecision: false,
      eligible: false,
      ineligibleReason: "decision_not_content_actioned",
    });
  });
  it("after apply: strike shown as active; canRevoke depends on role and applier", async () => {
    const d = await decision();
    await apply(DEV, d.decisionId);
    const read = (actor: string) =>
      one<Obj & { strike: Obj; canRevoke: boolean }>(
        "select community_strike_state_read($1,$2) r",
        [actor, d.caseId],
      );
    const asApplier = await read(DEV);
    expect(asApplier).toMatchObject({
      eligible: false,
      ineligibleReason: "strike_already_issued",
      canRevoke: false,
    });
    expect(asApplier.strike).toMatchObject({
      level: 1,
      status: "active",
      sanctionInEffect: true,
      reason: REASON,
    });
    expect((await read(MOD)).canRevoke).toBe(false); // moderator
    expect((await read(ADM)).canRevoke).toBe(true);
    expect(JSON.stringify(asApplier)).not.toMatch(/appliedBy|applied_by|revokedBy/);
  });
  it("revoked strike is reported as revoked with its reason; predicted level resets", async () => {
    const d = await decision();
    const s = await apply(MOD, d.decisionId);
    await revoke(DEV, s.strikeId, "Error de apreciación");
    const r = await one<{ strike: Obj; canRevoke: boolean }>(
      "select community_strike_state_read($1,$2) r",
      [ADM, d.caseId],
    );
    expect(r.strike).toMatchObject({
      status: "revoked",
      sanctionInEffect: false,
      revocationReason: "Error de apreciación",
    });
    expect(r.canRevoke).toBe(false);
    const d2 = await decision();
    expect(
      await one<Obj>("select community_strike_state_read($1,$2) r", [MOD, d2.caseId]),
    ).toMatchObject({ nextLevel: 1 });
  });
  it("requires a moderation role and an existing case", async () => {
    const d = await decision();
    await fails(
      "select community_strike_state_read($1,$2)",
      [NOBODY, d.caseId],
      /actor_not_moderator/,
    );
    await fails(
      "select community_strike_state_read($1,$2)",
      [MOD, uid(8000)],
      /case_not_found/,
    );
  });
});

describe("immutability and direct DML", () => {
  async function one_strike() {
    await setupClock("2026-03-01T00:00:00Z");
    return apply(MOD, (await decision()).decisionId);
  }
  it.each([
    ["level", "level = 3"],
    ["reason", "reason = 'otra'"],
    ["user_id", `user_id = '${uid(42)}'`],
    ["applied_by", `applied_by = '${uid(42)}'`],
    ["sanction_ends_at", "sanction_ends_at = sanction_ends_at + interval '1 day'"],
    ["permanent", "permanent = true"],
    ["decision_id", `decision_id = '${uid(42)}'`],
    ["created_at", "created_at = created_at + interval '1 second'"],
  ])("issuance field %s cannot be updated", async (_f, set) => {
    const s = await one_strike();
    await fails(
      `update community_user_strikes set ${set} where id = $1`,
      [s.strikeId],
      /community_user_strikes_immutable|violates/,
    );
  });
  it("DELETE and TRUNCATE are rejected", async () => {
    const s = await one_strike();
    await fails(
      "delete from community_user_strikes where id=$1",
      [s.strikeId],
      /community_user_strikes_immutable/,
    );
    await fails(
      "truncate community_user_strikes",
      [],
      /community_user_strikes_immutable/,
    );
  });
  it("a second revocation, and an update of a revoked row, are rejected", async () => {
    const s = await one_strike();
    await revoke(DEV, s.strikeId);
    await fails(
      "update community_user_strikes set revocation_reason='x' where id=$1",
      [s.strikeId],
      /community_user_strikes_immutable/,
    );
    await fails(
      "update community_user_strikes set revoked_at=null where id=$1",
      [s.strikeId],
      /community_user_strikes_immutable/,
    );
  });
  it("a revocation transition that also edits issuance data is rejected", async () => {
    const s = await one_strike();
    await fails(
      "update community_user_strikes set revoked_at=now(), revoked_by=$2, revocation_reason='x', level=3 where id=$1",
      [s.strikeId, DEV],
      /community_user_strikes_immutable|violates/,
    );
  });
  it("the table cannot hold a self-revocation, a half revocation or a forged sanction", async () => {
    const s = await one_strike();
    await fails(
      "update community_user_strikes set revoked_at=now(), revoked_by=applied_by, revocation_reason='x' where id=$1",
      [s.strikeId],
      /violates|check/,
    );
    await fails(
      "update community_user_strikes set revoked_at=now() where id=$1",
      [s.strikeId],
      /immutable|violates|check/,
    );
  });
  it.each([
    ["level 1 with a 20-day deadline", "1, false, '2026-03-21T00:00:00Z'"],
    ["level 2 with the 14-day deadline", "2, false, '2026-03-15T00:00:00Z'"],
    ["level 3 with a deadline", "3, true, '2026-03-15T00:00:00Z'"],
    ["level 3 not permanent", "3, false, null"],
    ["level 4", "4, false, '2026-03-15T00:00:00Z'"],
  ])("a forged insert (%s) violates the CHECKs even for the owner", async (_n, vals) => {
    const d = await decision();
    const dec = (
      await db.query<{ case_id: string; cycle_id: string; post_id: string }>(
        "select case_id, cycle_id, post_id from community_moderation_decisions where id=$1",
        [d.decisionId],
      )
    ).rows[0];
    await fails(
      `insert into community_user_strikes(user_id,case_id,cycle_id,decision_id,post_id,level,permanent,sanction_ends_at,reason,applied_by,sanction_starts_at,created_at)
       values($1,$2,$3,$4,$5,${vals.split(",")[0]},${vals.split(",")[1]},${vals.split(",").slice(2).join(",")},'r',$6,'2026-03-01T00:00:00Z','2026-03-01T00:00:00Z')`,
      [AUTHOR, dec.case_id, dec.cycle_id, d.decisionId, dec.post_id, MOD],
      /violates|check/,
    );
  });
  it("cross-case / cross-cycle / cross-post forgery is impossible (composite FK + context trigger)", async () => {
    const a = await decision();
    const b = await decision();
    const decA = (
      await db.query<{ case_id: string; cycle_id: string; post_id: string }>(
        "select case_id, cycle_id, post_id from community_moderation_decisions where id=$1",
        [a.decisionId],
      )
    ).rows[0];
    const decB = (
      await db.query<{ case_id: string; cycle_id: string; post_id: string }>(
        "select case_id, cycle_id, post_id from community_moderation_decisions where id=$1",
        [b.decisionId],
      )
    ).rows[0];
    const ins = (caseId: string, cycleId: string, postId: string, user = AUTHOR) =>
      `insert into community_user_strikes(user_id,case_id,cycle_id,decision_id,post_id,level,permanent,sanction_ends_at,reason,applied_by,sanction_starts_at,created_at)
       values('${user}','${caseId}','${cycleId}','${a.decisionId}','${postId}',3,true,null,'r','${MOD}','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z')`;
    await fails(
      ins(decB.case_id, decA.cycle_id, decA.post_id),
      [],
      /violates foreign key/,
    );
    await fails(
      ins(decA.case_id, decB.cycle_id, decA.post_id),
      [],
      /violates foreign key/,
    );
    await fails(
      ins(decA.case_id, decA.cycle_id, decB.post_id),
      [],
      /violates foreign key/,
    );
    await fails(
      ins(decA.case_id, decA.cycle_id, decA.post_id, reporters[0]),
      [],
      /community_user_strikes_context/,
    );
  });
  it("No procede decisions cannot carry a strike even if inserted directly", async () => {
    const d = await decision("reports_not_valid");
    const dec = (
      await db.query<{ case_id: string; cycle_id: string; post_id: string }>(
        "select case_id, cycle_id, post_id from community_moderation_decisions where id=$1",
        [d.decisionId],
      )
    ).rows[0];
    await fails(
      `insert into community_user_strikes(user_id,case_id,cycle_id,decision_id,post_id,level,permanent,sanction_ends_at,reason,applied_by,sanction_starts_at,created_at)
       values($1,$2,$3,$4,$5,3,true,null,'r',$6,'2026-03-01T00:00:00Z','2026-03-01T00:00:00Z')`,
      [AUTHOR, dec.case_id, dec.cycle_id, d.decisionId, dec.post_id, MOD],
      /community_user_strikes_context/,
    );
  });
  it("API roles have no table privileges and no direct function access beyond service_role", async () => {
    for (const role of ["anon", "authenticated", "service_role"])
      for (const priv of ["select", "insert", "update", "delete", "truncate"])
        expect(
          (
            await db.query<{ ok: boolean }>(
              "select has_table_privilege($1,'public.community_user_strikes',$2) ok",
              [role, priv],
            )
          ).rows[0].ok,
        ).toBe(false);
    const sigs = [
      "community_strike_apply(uuid,uuid,text,integer)",
      "community_strike_revoke(uuid,uuid,text)",
      "community_author_restriction(uuid)",
      "community_strike_state_read(uuid,uuid)",
    ];
    for (const sig of sigs) {
      for (const role of ["anon", "authenticated"])
        expect(
          (
            await db.query<{ ok: boolean }>(
              "select has_function_privilege($1,$2,'execute') ok",
              [role, `public.${sig}`],
            )
          ).rows[0].ok,
        ).toBe(false);
      expect(
        (
          await db.query<{ ok: boolean }>(
            "select has_function_privilege('service_role',$1,'execute') ok",
            [`public.${sig}`],
          )
        ).rows[0].ok,
      ).toBe(true);
    }
    const meta = await db.query<{
      proname: string;
      secdef: boolean;
      owner: string;
      cfg: string[];
    }>(
      `select proname, prosecdef secdef, pg_get_userbyid(proowner) owner, proconfig cfg from pg_proc
       where proname in ('community_strike_apply','community_strike_revoke','community_author_restriction','community_strike_state_read')`,
    );
    expect(meta.rows).toHaveLength(4);
    for (const r of meta.rows)
      expect(r).toMatchObject({
        secdef: true,
        owner: "postgres",
        cfg: ["search_path=pg_catalog, public"],
      });
  });
  it("RLS is forced and no policy exists", async () => {
    const r = await db.query<{ rls: boolean; frls: boolean }>(
      "select relrowsecurity rls, relforcerowsecurity frls from pg_class where relname='community_user_strikes'",
    );
    expect(r.rows[0]).toEqual({ rls: true, frls: true });
    expect(
      (
        await db.query(
          "select 1 from pg_policies where tablename='community_user_strikes'",
        )
      ).rows,
    ).toHaveLength(0);
  });
});

describe("audit", () => {
  beforeEach(() => setupClock("2026-03-01T00:00:00Z"));
  it("strike_applied and strike_revoked are human audit rows with minimal metadata", async () => {
    const d = await decision();
    const s = await apply(MOD, d.decisionId, "motivo-secreto-del-strike");
    await revoke(DEV, s.strikeId, "motivo-secreto-de-revocacion");
    const rows = (
      await db.query<{
        action: string;
        actor_kind: string;
        actor_user_id: string;
        target_type: string;
        target_id: string;
        metadata: Obj;
      }>(
        "select action, actor_kind, actor_user_id, target_type, target_id, metadata from moderation_audit_log where action in ('strike_applied','strike_revoked') order by created_at, id",
      )
    ).rows;
    expect(rows.map((r) => r.action).sort()).toEqual([
      "strike_applied",
      "strike_revoked",
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        actor_kind: "human",
        target_type: "community_user_strike",
        target_id: s.strikeId,
      });
      expect(Object.keys(r.metadata).sort()).toEqual(["case_id", "decision_id", "level"]);
    }
    const dump = JSON.stringify(rows);
    expect(dump).not.toMatch(/motivo-secreto/);
    for (const id of reporters) expect(dump).not.toContain(id);
    expect(rows.find((r) => r.action === "strike_applied")!.actor_user_id).toBe(MOD);
    expect(rows.find((r) => r.action === "strike_revoked")!.actor_user_id).toBe(DEV);
  });
  it("a failed apply leaves no strike and no audit row", async () => {
    const d = await decision("reports_not_valid");
    await failApply(MOD, d.decisionId, /decision_not_content_actioned/);
    expect(await strikeCount()).toBe(0);
    expect(
      (await db.query("select 1 from moderation_audit_log where action like 'strike_%'"))
        .rows,
    ).toHaveLength(0);
  });
});

describe("purge compatibility and isolation", () => {
  it("no foreign key from strikes to community_posts or auth.users (purge and account deletion stay possible)", async () => {
    const r = await db.query<{ ref: string }>(
      `select confrelid::regclass::text ref from pg_constraint
       where conrelid = 'public.community_user_strikes'::regclass and contype = 'f'`,
    );
    expect(r.rows.map((x) => x.ref)).toEqual(["community_moderation_decisions"]);
  });
  it("deleting the post row after a strike keeps strike, decision and case", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const d = await decision();
    await apply(MOD, d.decisionId);
    await db.query("delete from community_posts where id=$1", [d.post]);
    expect(await strikeCount()).toBe(1);
    expect(
      (
        await db.query("select 1 from community_moderation_decisions where id=$1", [
          d.decisionId,
        ])
      ).rows,
    ).toHaveLength(1);
  });
  // executable SQL only: no comments and no COMMENT ON statements (they mention the design)
  const code = R5B.replace(/--.*$/gm, "").replace(/comment on [\s\S]*?;\r?\n/gi, "");
  it("never references the post writers, the purge/GC functions or the post table in executable SQL", () => {
    for (const forbidden of [
      "community_post_save",
      "community_post_reorder_media",
      "community_post_detach_media",
      "community_post_delete",
      "community_purge_due_posts",
      "community_asset_gc",
      "community_media_purge_tick",
      "media_assets",
    ])
      expect(code).not.toContain(forbidden);
    expect(code).not.toMatch(/\bcommunity_posts\b/);
  });
  it("only adds: no change to existing tables beyond one unique constraint, no update/delete of history", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate (table|public)/i);
    expect(code.match(/alter table/gi)).toHaveLength(3); // decisions unique + 2x RLS on the new table
    expect(code).not.toMatch(
      /\bupdate public\.(community_moderation|community_posts|profiles)/i,
    );
    expect(code).not.toMatch(/delete from/i);
  });
  it("contains no secret material", () => {
    expect(R5B).not.toMatch(
      /Bearer|eyJ[A-Za-z0-9_-]{10,}|sb_secret|SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});

describe("canonical lock order (documented and enforced in the code)", () => {
  const body = (name: string) =>
    R5B.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))![0];
  const at = (s: string, needle: string) => {
    const i = s.indexOf(needle);
    expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
    return i;
  };
  it("apply: admin_roles(share) -> profiles(no key update) -> case(share) -> cycle(share) -> strike insert -> audit", () => {
    const f = body("community_strike_apply");
    const order = [
      at(f, "from public.admin_roles where user_id = p_actor_user_id for share"),
      at(f, "from public.profiles where user_id = v_author for no key update"),
      at(
        f,
        "from public.community_moderation_cases where id = v_decision.case_id for share",
      ),
      at(
        f,
        "from public.community_moderation_cycles\n    where id = v_decision.cycle_id for share",
      ),
      at(f, "insert into public.community_user_strikes"),
      at(f, "insert into public.moderation_audit_log"),
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(f).not.toMatch(/community_posts/); // proof obligation: no post lock, history is immutable
    expect(f).not.toMatch(/for update/i); // nothing that could invert against case_decide
  });
  it("revoke: admin_roles(share) -> profiles(no key update) -> strike(update) -> audit", () => {
    const f = body("community_strike_revoke");
    const order = [
      at(f, "from public.admin_roles where user_id = p_actor_user_id for share"),
      at(f, "from public.profiles where user_id = v_user for no key update"),
      at(f, "from public.community_user_strikes where id = p_strike_id for update"),
      at(f, "insert into public.moderation_audit_log"),
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
  it("the existing decision keeps post -> case -> cycle and never locks profiles (no inversion with strikes)", () => {
    const decide = migration("20261015120000_moderation_grouped_decision_core.sql");
    const fn = decide.slice(
      decide.indexOf("create function public.community_moderation_case_decide"),
    );
    const end = fn.indexOf("\n$$;");
    const f = fn.slice(0, end);
    const p = f.indexOf("from public.community_posts where id = v_post_id for update");
    const c = f.indexOf(
      "from public.community_moderation_cases where id = p_case_id for update",
    );
    const y = f.indexOf(
      "from public.community_moderation_cycles where id = p_cycle_id for update",
    );
    expect(p).toBeGreaterThan(-1);
    expect(p).toBeLessThan(c);
    expect(c).toBeLessThan(y);
    expect(f).not.toMatch(/public\.profiles[^;]*for (share|update|no key update)/);
  });
  it("PGlite is single-session: real concurrency is deferred to the Testing smoke (R5-F)", () => {
    // Intentionally a documented limitation, not a skipped assertion: two-session apply/apply,
    // apply/revoke and apply/create races need real connections.
    expect(true).toBe(true);
  });
});
