// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// COPY-1: strikes MANUALES de Copyright. SQL REAL (PGlite) de 20261111120000 sobre 2A + 2B + el sistema de strikes de Community.
// COPY-1 fase 2A: SQL REAL (PGlite) de la migración PROPUESTA 20261107120000 (reclamaciones de copyright) sobre la cadena vigente,
// y de su rollback. No se aplica en ningún entorno remoto. Una reclamación NO oculta, retira ni toca nada del circuito ordinario.

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const migration = (n: string) => read(`supabase/migrations/${n}`);
const MIG = migration("20261107120000_copyright_claims.sql");
const REVOKE_MIG = migration("20261108120000_copyright_events_immutable_revoke.sql");
const REM = migration("20261110120000_copyright_removal_appeals.sql");
const STRIKES = migration("20261111120000_copyright_strikes.sql");
const COMMUNITY_NOTICE = migration("20261112120000_community_strike_notice.sql");
const COMMUNITY_NOTICE_ROLLBACK = read(
  "supabase/rollbacks/20261112120000_community_strike_notice.rollback.sql",
);
const STRIKES_ROLLBACK = read(
  "supabase/rollbacks/20261111120000_copyright_strikes.rollback.sql",
);
const USERNAME_MIGRATION = migration("20261003120000_community_username_foundation.sql");
const REAL_USERNAME_CHECK = USERNAME_MIGRATION.match(
  /add constraint profiles_username_format check \(([\s\S]*?)\n {2}\);/,
)![1];
const uid = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOD = uid(1);
const PENDING_USER = uid(2);
const hex = (label: string | number) =>
  createHash("sha256").update(`copyright-test:${label}`).digest("hex");
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
  await db.exec(
    migration("20261005120000_community_post_likes.sql")
      .replace(/alter table public\.community_posts add column like_count[\s\S]*?;\n/, "")
      .replace(/create index community_posts_popular[\s\S]*?;\n/, ""),
  );
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
    "20261025120000_account_complete_authority.sql",
    "20261029120000_moderation_audit_strike_events.sql",
    "20261030120000_moderation_queue_filters.sql",
    "20261031120000_moderation_pending_count.sql",
  ])
    await db.exec(migration(n));
  await db.exec(
    "update profiles set username = 'actor_user' where username is null; alter table profiles alter column username set not null;",
  );
  await db.exec(
    `alter table profiles add constraint profiles_username_format check (${REAL_USERNAME_CHECK});`,
  );
  // Supabase concede EXECUTE por defecto a los roles de API sobre las funciones nuevas de public: se reproduce para que los
  // REVOKE de la migración se ejerciten de verdad (sin esto un REVOKE incompleto pasaría desapercibido).
  await db.exec(
    "alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;",
  );
  await db.exec("alter table auth.users add column email text;");
  await db.exec(MIG);
  await db.exec(
    migration("20261004120000_community_posts_media.sql").match(
      /create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/,
    )![0],
  );
  await db.exec(REVOKE_MIG);
  await db.exec(REM);
  await db.exec(STRIKES);
  await db.exec(COMMUNITY_NOTICE);
}, 120000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
  await db.query("insert into admin_roles values($1,'moderator')", [MOD]);
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [MOD]);
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
    PENDING_USER,
  ]);
});
afterEach(async () => {
  try {
    await db.exec("reset role");
  } catch {
    /* transacción abortada */
  }
  await db.exec("rollback");
});

/** Un error SQL aborta la transacción del test: se aísla en un savepoint para poder seguir consultando. */
async function fails(run: () => Promise<unknown>, pattern: RegExp) {
  await db.exec("savepoint expected_failure");
  await expect(run()).rejects.toThrow(pattern);
  await db.exec("rollback to savepoint expected_failure");
}
async function newPost(text = "texto original de la publicación") {
  const post = uid(1000 + ++seq);
  await db.query(
    "insert into community_posts(id,author_user_id,text,version) values($1,$2,$3,2)",
    [post, ACTOR, text],
  );
  return post;
}
const input = (over: Obj = {}): Obj => ({
  claimantName: "  Ana Titular ",
  claimantEmail: "  Ana.Titular@Example.COM ",
  organization: "Estudio Ejemplo",
  relationship: "owner",
  workDescription: "Ilustración original publicada en mi portafolio en 2025",
  infringementDescription: "La publicación reutiliza mi ilustración sin mi permiso",
  evidenceUrls: ["https://example.com/portafolio/obra-1"],
  postUrl: "https://upmina.test/community/ejemplo",
  postId: null,
  signature: "Ana Titular",
  statementVersion: "v1",
  statementsAccepted: true,
  ...over,
});
let keyN = 0;
const create = (over: Obj = {}, keys?: { ip?: string; net?: string; email?: string }) =>
  one<Obj>("select copyright_claim_create($1,$2,$3,$4::jsonb) r", [
    keys?.ip ?? hex(`ip${++keyN}`),
    keys?.net ?? hex(`net${keyN}`),
    keys?.email ?? hex(`mail${keyN}`),
    JSON.stringify(input(over)),
  ]);
const claimId = async (reference: string) =>
  (
    await db.query<{ id: string }>("select id from copyright_claims where reference=$1", [
      reference,
    ])
  ).rows[0]!.id;
const review = (
  claim: string,
  action: string,
  version: number,
  note: string | null = null,
  actor = MOD,
) =>
  one<Obj>("select copyright_claim_review($1,$2,$3,$4,$5) r", [
    actor,
    claim,
    action,
    version,
    note,
  ]);
// ---------------------------------------------------------------------------------------------------------------------------------
// Fase 2B: retirada, apelación, restauración y eliminación manual. SQL REAL sobre la cadena vigente + 2A + 2B (nada remoto).
// ---------------------------------------------------------------------------------------------------------------------------------
const AUTHOR_EMAIL = "autor@example.com";
let tokenN = 0;
const tok = () => hex(`appeal-token-${++tokenN}`);
const REASON = "El contenido reproduce la obra identificada sin autorización";

async function postWithMedia(text = "publicación con medios", assets = 2) {
  const post = await newPost(text);
  const ids: string[] = [];
  for (let n = 0; n < assets; n += 1) {
    const asset = uid(6000 + ++seq);
    ids.push(asset);
    await db.query(
      "insert into media_assets(id,domain,status,kind,created_by) values ($1,'community','ready','image',$2)",
      [asset, ACTOR],
    );
    await db.query(
      "insert into community_post_media(post_id,asset_id,position) values ($1,$2,$3)",
      [post, asset, n],
    );
  }
  return { post, ids };
}
async function inReview(postId: string | null) {
  const made = await create({ postId });
  const id = await claimId(made.reference as string);
  await review(id, "start_review", 1);
  return { id, reference: made.reference as string };
}
const claimRow = async (id: string) =>
  (await db.query<Obj>("select * from copyright_claims where id=$1", [id])).rows[0]!;
const postRow = async (id: string) =>
  (await db.query<Obj>("select * from community_posts where id=$1", [id])).rows[0];
const removeClaim = (
  id: string,
  reference: string,
  over: {
    actor?: string;
    version?: number;
    postVersion?: number;
    confirm?: string | null;
    reason?: string | null;
    token?: string | null;
    window?: number;
  } = {},
) =>
  one<Obj>("select copyright_claim_remove($1,$2,$3,$4,$5,$6,$7,$8) r", [
    over.actor ?? MOD,
    id,
    over.version ?? 2,
    over.postVersion ?? 2,
    over.confirm === undefined ? reference : over.confirm,
    over.reason === undefined ? REASON : over.reason,
    over.token === undefined ? tok() : over.token,
    over.window ?? 60,
  ]);
const record = (
  id: string,
  kind: string,
  ok: boolean,
  errorClass: string | null = null,
  actor = MOD,
) =>
  one<Obj>("select copyright_claim_notice_record($1,$2,$3,$4,$5) r", [
    actor,
    id,
    kind,
    ok,
    errorClass,
  ]);
const appealInput = (over: Obj = {}): Obj => ({
  contactName: "Autor Original",
  contactEmail: "Autor@Example.com",
  reason: "own_work",
  explanation: "La ilustración es mía y la publiqué antes que la reclamante",
  evidenceText: "Archivo fuente con fechas de creación",
  evidenceUrls: ["https://example.com/mi-portafolio"],
  statementVersion: "v1",
  statementAccepted: true,
  ...over,
});
const appeal = (token: string, over: Obj = {}, user = ACTOR) =>
  one<Obj>("select copyright_appeal_submit($1,$2,$3::jsonb) r", [
    user,
    token,
    JSON.stringify(appealInput(over)),
  ]);
const resolve = (
  id: string,
  decision: string,
  version: number,
  note: string | null = "Decisión motivada de la moderación",
  actor = MOD,
) =>
  one<Obj>("select copyright_appeal_resolve($1,$2,$3,$4,$5) r", [
    actor,
    id,
    version,
    decision,
    note,
  ]);
const purge = (
  id: string,
  reference: string,
  version: number,
  over: { confirm?: string | null; note?: string | null; actor?: string } = {},
) =>
  one<Obj>("select copyright_claim_purge($1,$2,$3,$4,$5) r", [
    over.actor ?? MOD,
    id,
    version,
    over.confirm === undefined ? reference : over.confirm,
    over.note === undefined ? "Eliminación definitiva confirmada" : over.note,
  ]);
const expire = (id: string) =>
  db.query(
    "update copyright_claims set notified_at = now() - interval '3 hours', appeal_deadline = now() - interval '1 minute' where id=$1",
    [id],
  );

/** Estado de la reclamación hasta «removed» con aviso enviado (versión resultante en `version`). */
async function removedAndNotified(window = 60) {
  await db.query("update auth.users set email=$1 where id=$2", [AUTHOR_EMAIL, ACTOR]);
  const { post, ids } = await postWithMedia();
  const claim = await inReview(post);
  const token = tok();
  const out = await removeClaim(claim.id, claim.reference, { token, window });
  await record(claim.id, "removal", true);
  return {
    ...claim,
    post,
    ids,
    token,
    version: (await claimRow(claim.id)).version as number,
    out,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Strikes manuales de Copyright
// ---------------------------------------------------------------------------------------------------------------------------------
const STRIKE_REASON =
  "Infracción de copyright confirmada tras la eliminación definitiva.";
const ADMIN = uid(3);
const DEV = uid(4);
const reporters = [41, 42, 43].map((n) => uid(8000 + n));

const apply = (
  id: string,
  over: { actor?: string; reason?: string | null; expected?: number | null } = {},
) =>
  one<Obj>("select copyright_strike_apply($1,$2,$3,$4) r", [
    over.actor ?? MOD,
    id,
    over.reason === undefined ? STRIKE_REASON : over.reason,
    over.expected === undefined ? null : over.expected,
  ]);
const state = (id: string, actor = MOD) =>
  one<Obj>("select copyright_strike_state($1,$2) r", [actor, id]);
const strikesOf = async (user = ACTOR) =>
  (
    await db.query<Obj>(
      "select * from community_user_strikes where user_id=$1 order by created_at, id",
      [user],
    )
  ).rows;
const copyrightStrikes = async () =>
  Number(
    (
      await db.query<{ n: string }>(
        "select count(*) n from community_user_strikes where source = 'copyright'",
      )
    ).rows[0]!.n,
  );

/** Reclamación llevada hasta `purged` por el flujo real (retirada, aviso, ventana vencida, eliminación manual). */
async function purgedClaim() {
  const r = await removedAndNotified();
  await expire(r.id);
  await purge(r.id, r.reference, (await claimRow(r.id)).version as number);
  return r;
}
async function communityStrike() {
  const post = await newPost("publicación sancionada por el circuito ordinario");
  let ctx!: Obj;
  for (const [i, id] of reporters.entries()) {
    await db.query(
      "insert into auth.users(id,email_confirmed_at) values($1,now()) on conflict do nothing",
      [id],
    );
    await db.query(
      "insert into profiles(user_id,username) values($1,$2) on conflict do nothing",
      [id, `reporter_${i + 1}`],
    );
    ctx = await one<Obj>("select community_post_report_submit($1,$2,'spam',null) r", [
      id,
      post,
    ]);
    if (i === 1) break;
  }
  await db.query(
    "select community_moderation_case_decide($1,$2,$3,$4,$5,'content_actioned',$6)",
    [
      MOD,
      ctx.caseId,
      ctx.cycleId,
      ctx.caseVersion,
      (await postRow(post))!.version,
      "Mensaje",
    ],
  );
  const decision = (
    await db.query<{ id: string }>(
      "select id from community_moderation_decisions where case_id=$1",
      [ctx.caseId],
    )
  ).rows[0]!.id;
  return one<Obj>("select community_strike_apply($1,$2,$3) r", [
    MOD,
    decision,
    "Strike de Community",
  ]);
}

describe("strikes de Copyright · solo manuales y solo tras purged", () => {
  beforeEach(async () => {
    await db.query("insert into admin_roles values($1,'admin')", [ADMIN]);
    await db.query("insert into admin_roles values($1,'developer')", [DEV]);
    for (const id of [ADMIN, DEV])
      await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
        id,
      ]);
  });

  it("ninguna etapa del ciclo crea un strike: retirada, aviso, apelación, aceptación, rechazo y eliminación", async () => {
    const accepted = await removedAndNotified();
    expect(await copyrightStrikes()).toBe(0);
    await appeal(accepted.token);
    expect(await copyrightStrikes()).toBe(0);
    await resolve(accepted.id, "accept", (await claimRow(accepted.id)).version as number);
    expect(await copyrightStrikes()).toBe(0);
    const rejected = await removedAndNotified();
    await appeal(rejected.token);
    await resolve(rejected.id, "reject", (await claimRow(rejected.id)).version as number);
    expect(await copyrightStrikes()).toBe(0);
    await purgedClaim();
    expect(await copyrightStrikes()).toBe(0); // `purged` sin acción manual: cero strikes
    expect(await strikesOf()).toHaveLength(0);
  });

  it("antes de purged la aplicación se rechaza: recibida, en revisión, retirada, apelación pendiente, restaurada y apelación rechazada", async () => {
    const received = await create({ postId: null });
    const receivedId = await claimId(received.reference as string);
    await fails(() => apply(receivedId), /claim_not_purged/);
    const review1 = await inReview(await newPost());
    await fails(() => apply(review1.id), /claim_not_purged/);
    const removed = await removedAndNotified();
    await fails(() => apply(removed.id), /claim_not_purged/);
    await appeal(removed.token);
    await fails(() => apply(removed.id), /claim_not_purged/); // apelación pendiente
    await resolve(removed.id, "reject", (await claimRow(removed.id)).version as number);
    await fails(() => apply(removed.id), /claim_not_purged/); // apelación rechazada, aún no eliminada
    const restored = await removedAndNotified();
    await appeal(restored.token);
    await resolve(restored.id, "accept", (await claimRow(restored.id)).version as number);
    await fails(() => apply(restored.id), /claim_not_purged/);
    expect(await copyrightStrikes()).toBe(0);
  });

  it("purged + acción manual autorizada: un strike de nivel 1 de 14 días, auditado y con el aviso pendiente", async () => {
    const r = await purgedClaim();
    const out = await apply(r.id);
    expect(out).toMatchObject({
      level: 1,
      permanent: false,
      claimId: r.id,
      reference: r.reference,
    });
    const [s] = await strikesOf();
    expect(s).toMatchObject({
      source: "copyright",
      claim_id: r.id,
      level: 1,
      applied_by: MOD,
      reason: STRIKE_REASON,
      case_id: null,
      decision_id: null,
      revoked_at: null,
    });
    expect(
      Math.round(
        (new Date(s!.sanction_ends_at as string).getTime() -
          new Date(s!.sanction_starts_at as string).getTime()) /
          86_400_000,
      ),
    ).toBe(14);
    // El estado `purged` NO lo revoca: sigue activo y restringe al autor.
    expect(
      (await one<Obj>("select community_author_restriction($1) r", [ACTOR])).restricted,
    ).toBe(true);
    const audit = await db.query<Obj>(
      "select metadata from moderation_audit_log where action='strike_applied' and target_id=$1",
      [out.strikeId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toEqual({
      source: "copyright",
      claim_id: r.id,
      reference: r.reference,
      level: 1,
    });
    const events = (
      await db.query<{ kind: string }>(
        "select kind from copyright_claim_events where claim_id=$1 order by created_at, id",
        [r.id],
      )
    ).rows.map((e) => e.kind);
    expect(events.at(-1)).toBe("strike_applied");
    expect(
      (await db.query("select * from copyright_strike_notices where claim_id=$1", [r.id]))
        .rows[0],
    ).toMatchObject({ strike_id: out.strikeId, notified_at: null, attempts: 0 });
  });

  it("un máximo de un strike por reclamación: doble aplicación, reintento y revocación posterior no permiten otro", async () => {
    const r = await purgedClaim();
    await apply(r.id);
    await fails(() => apply(r.id), /strike_already_issued/);
    await fails(
      () =>
        db.query(
          `insert into community_user_strikes(user_id,post_id,level,reason,applied_by,sanction_starts_at,sanction_ends_at,permanent,created_at,source,claim_id)
           select $1,post_id,1,'duplicado',$2,now(),now() + interval '14 days',false,now(),'copyright',id from copyright_claims where id=$3`,
          [ACTOR, MOD, r.id],
        ),
      /duplicate key|community_user_strikes_claim_unique/,
    );
    const [first] = await strikesOf();
    await db.query("select community_strike_revoke($1,$2,$3)", [
      ADMIN,
      first!.id,
      "Corrección excepcional",
    ]);
    await fails(() => apply(r.id), /strike_already_issued/); // revocado o no, nunca otro por la misma reclamación
    expect(await copyrightStrikes()).toBe(1);
  });

  it("rechaza al no autorizado, al autor sobre su propio contenido, un motivo inválido y un nivel esperado distinto", async () => {
    const r = await purgedClaim();
    await fails(() => apply(r.id, { actor: uid(9999) }), /actor_not_moderator/);
    await fails(() => apply(r.id, { actor: ACTOR }), /actor_not_moderator/);
    await db.query("insert into admin_roles values($1,'moderator')", [ACTOR]);
    await fails(() => apply(r.id, { actor: ACTOR }), /self_strike_forbidden/);
    await fails(() => apply(r.id, { reason: null }), /reason_required/);
    await fails(() => apply(r.id, { reason: "   " }), /reason_required/);
    await fails(() => apply(r.id, { reason: "x".repeat(1001) }), /invalid_argument/);
    await fails(() => apply(r.id, { expected: 2 }), /level_changed/);
    await fails(() => apply(r.id, { expected: 4 }), /invalid_argument/);
    await fails(() => apply(uid(31337)), /claim_not_found/);
    expect(await copyrightStrikes()).toBe(0);
    expect((await apply(r.id, { expected: 1 })).level).toBe(1);
  });

  it("escalada combinada con Community: nivel 1 (Community) → 2 (Copyright, 1 mes) → 3 (Copyright, permanente)", async () => {
    const community = await communityStrike();
    expect(community.level).toBe(1);
    const second = await apply((await purgedClaim()).id);
    expect(second).toMatchObject({ level: 2, permanent: false });
    const [, s2] = await strikesOf();
    expect(s2!.sanction_ends_at).not.toBeNull();
    const third = await apply((await purgedClaim()).id);
    expect(third).toMatchObject({ level: 3, permanent: true, endsAt: null });
    expect((await strikesOf()).map((s) => [s.source, s.level])).toEqual([
      ["community", 1],
      ["copyright", 2],
      ["copyright", 3],
    ]);
  });

  it("las reglas de Community no cambian: los strikes existentes siguen con source community y la revocación sigue siendo developer/admin", async () => {
    const community = await communityStrike();
    const [row] = await strikesOf();
    expect(row).toMatchObject({ source: "community", claim_id: null });
    const copyright = await apply((await purgedClaim()).id);
    await fails(
      () =>
        one("select community_strike_revoke($1,$2,$3) r", [
          MOD,
          copyright.strikeId,
          "motivo",
        ]),
      /revoker_role_insufficient/,
    );
    await fails(
      () =>
        one("select community_strike_revoke($1,$2,$3) r", [
          MOD,
          community.strikeId,
          "motivo",
        ]),
      /revoker_role_insufficient/,
    );
    await one("select community_strike_revoke($1,$2,$3) r", [
      DEV,
      copyright.strikeId,
      "Corrección excepcional",
    ]);
    await one("select community_strike_revoke($1,$2,$3) r", [
      ADMIN,
      community.strikeId,
      "Corrección excepcional",
    ]);
    expect(
      (
        await db.query(
          "select count(*)::int n from community_user_strikes where revoked_at is not null",
        )
      ).rows[0],
    ).toMatchObject({ n: 2 });
  });

  it("el historial es inmutable y la base impide strikes de Copyright incoherentes", async () => {
    const r = await purgedClaim();
    const out = await apply(r.id);
    await fails(
      () =>
        db.query("update community_user_strikes set level = 3 where id=$1", [
          out.strikeId,
        ]),
      /community_user_strikes_immutable/,
    );
    await fails(
      () =>
        db.query("update community_user_strikes set claim_id = null where id=$1", [
          out.strikeId,
        ]),
      /community_user_strikes_immutable/,
    );
    await fails(
      () => db.query("delete from community_user_strikes where id=$1", [out.strikeId]),
      /community_user_strikes_immutable/,
    );
    const removed = await removedAndNotified();
    const insert = (claimId: string, extra = "") =>
      db.query(
        `insert into community_user_strikes(user_id,post_id,level,reason,applied_by,sanction_starts_at,sanction_ends_at,permanent,created_at,source,claim_id${extra})
         select $1,post_id,1,'forzado',$2,now(),now() + interval '14 days',false,now(),'copyright',id from copyright_claims where id=$3`,
        [ACTOR, MOD, claimId],
      );
    await fails(() => insert(removed.id), /community_user_strikes_context/); // reclamación no purged
    await fails(
      () =>
        db.query(
          `insert into community_user_strikes(user_id,post_id,level,reason,applied_by,sanction_starts_at,sanction_ends_at,permanent,created_at,source,claim_id)
           select $1,post_id,1,'forzado',$2,now(),now() + interval '14 days',false,now(),'community',id from copyright_claims where id=$3`,
          [ACTOR, MOD, removed.id],
        ),
      /community_user_strikes_(context|source_check)/,
    );
  });

  it("estado del panel: no elegible antes de purged; elegible con el nivel siguiente; después muestra el strike y el aviso", async () => {
    const removed = await removedAndNotified();
    expect(await state(removed.id)).toMatchObject({
      eligible: false,
      blocker: "claim_not_purged",
      nextLevel: null,
    });
    const r = await purgedClaim();
    expect(await state(r.id)).toMatchObject({
      eligible: true,
      blocker: null,
      nextLevel: 1,
      strike: null,
    });
    await apply(r.id);
    const after = await state(r.id);
    expect(after).toMatchObject({
      eligible: false,
      blocker: "strike_already_issued",
      strike: { level: 1, permanent: false, reason: STRIKE_REASON, revokedAt: null },
      notice: { status: "pending", attempts: 0, error: null },
    });
    await fails(() => state(r.id, uid(9999)), /actor_not_moderator/);
  });

  it("aviso al autor: contexto, fallo reintentable, envío único y sin duplicados", async () => {
    const r = await purgedClaim();
    await apply(r.id);
    const context = (actor = MOD) =>
      one<Obj>("select copyright_strike_notice_context($1,$2) r", [actor, r.id]);
    const noticeRecord = (ok: boolean, error: string | null = null) =>
      one<Obj>("select copyright_strike_notice_record($1,$2,$3,$4) r", [
        MOD,
        r.id,
        ok,
        error,
      ]);
    expect((await context()).strike).toMatchObject({
      authorEmail: AUTHOR_EMAIL,
      level: 1,
      permanent: false,
      reason: STRIKE_REASON,
    });
    await fails(() => context(uid(9999)), /actor_not_moderator/);
    await noticeRecord(false, "provider_unavailable");
    expect((await state(r.id)).notice).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "provider_unavailable",
    });
    await context(); // sigue pudiendo reintentarse
    await fails(() => noticeRecord(false, "inventado"), /invalid_argument/);
    expect(await noticeRecord(true)).toMatchObject({ alreadyNotified: false });
    expect(await noticeRecord(true)).toMatchObject({ alreadyNotified: true }); // no repite
    await fails(() => context(), /invalid_transition/); // ya enviado: no hay nada que reenviar
    expect((await state(r.id)).notice).toMatchObject({ status: "sent", error: null });
    const kinds = (
      await db.query<{ kind: string }>(
        "select kind from copyright_claim_events where claim_id=$1 and kind like 'strike_%' order by created_at, id",
        [r.id],
      )
    ).rows.map((e) => e.kind);
    expect(kinds).toEqual([
      "strike_applied",
      "strike_notification_failed",
      "strike_notified",
    ]);
    const audit = await db.query<Obj>(
      "select action, metadata->>'notice' notice from moderation_audit_log where target_id=$1 and action like 'copyright_notification%' order by created_at, id",
      [r.id],
    );
    expect(audit.rows.filter((a) => a.notice === "strike").map((a) => a.action)).toEqual([
      "copyright_notification_failed",
      "copyright_notification_sent",
    ]);
  });

  it("la migración no añade ningún trigger sobre copyright_claims: no hay strikes ni revocaciones automáticas", () => {
    expect(STRIKES).not.toMatch(/create trigger[^;]*on public\.copyright_claims/i);
    expect(STRIKES).not.toMatch(/update public\.community_user_strikes/i);
    // Solo la RPC manual inserta strikes de Copyright.
    expect(STRIKES.match(/insert into public\.community_user_strikes/g)).toHaveLength(1);
  });

  it("funciones y tabla privadas: sin acceso para anon ni authenticated; solo service_role ejecuta; SECURITY DEFINER con search_path fijo", async () => {
    const fns = [
      "copyright_strike_apply(uuid,uuid,text,integer)",
      "copyright_strike_state(uuid,uuid)",
      "copyright_strike_notice_context(uuid,uuid)",
      "copyright_strike_notice_record(uuid,uuid,boolean,text)",
    ];
    for (const fn of fns) {
      const rows = (
        await db.query<{ r: string; ok: boolean }>(
          `select r, has_function_privilege(r, $1, 'execute') ok from unnest(array['public','anon','authenticated','service_role']) r`,
          [`public.${fn}`],
        )
      ).rows;
      expect(Object.fromEntries(rows.map((x) => [x.r, x.ok]))).toEqual({
        public: false,
        anon: false,
        authenticated: false,
        service_role: true,
      });
    }
    const meta = (
      await db.query<{ definer: boolean; cfg: string[]; owner: string }>(
        `select prosecdef definer, proconfig cfg, pg_get_userbyid(proowner) owner from pg_proc where proname like 'copyright_strike_%'`,
      )
    ).rows;
    expect(meta).toHaveLength(4);
    for (const m of meta) {
      expect(m.definer).toBe(true);
      expect(m.cfg.join()).toContain("search_path=pg_catalog, public");
      expect(m.owner).toBe("postgres");
    }
    const tbl = (
      await db.query<{ rls: boolean; force: boolean }>(
        "select relrowsecurity rls, relforcerowsecurity force from pg_class where relname='copyright_strike_notices'",
      )
    ).rows[0]!;
    expect(tbl).toEqual({ rls: true, force: true });
    expect(
      (
        await db.query<{ ok: boolean }>(
          "select has_table_privilege('authenticated','public.copyright_strike_notices','select') ok",
        )
      ).rows[0]!.ok,
    ).toBe(false);
  });

  it("rollback: se niega a ejecutarse con strikes de Copyright y, sin ellos, restaura el esquema anterior", async () => {
    const r = await purgedClaim();
    await apply(r.id);
    await fails(
      () => db.exec(STRIKES_ROLLBACK),
      /rollback_blocked_copyright_strikes_exist/,
    );
    // Sin strikes de Copyright: el rollback se ejecuta y deja las columnas y la tabla fuera.
    await db.exec("rollback");
    await db.exec("begin");
    await db.exec(STRIKES_ROLLBACK);
    const cols = (
      await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name='community_user_strikes' and column_name in ('source','claim_id')",
      )
    ).rows;
    expect(cols).toHaveLength(0);
    expect(
      (await db.query("select to_regclass('public.copyright_strike_notices') t")).rows[0],
    ).toMatchObject({ t: null });
    expect(
      (
        await db.query<{ is_nullable: string }>(
          "select is_nullable from information_schema.columns where table_name='community_user_strikes' and column_name='decision_id'",
        )
      ).rows[0]!.is_nullable,
    ).toBe("NO");
  });
});

describe("aviso de strikes de Community (mismo registro que Copyright)", () => {
  const ctx = (strikeId: string, actor = MOD) =>
    one<Obj>("select community_strike_notice_context($1,$2) r", [actor, strikeId]);
  const rec = (strikeId: string, ok: boolean, error: string | null = null, actor = MOD) =>
    one<Obj>("select community_strike_notice_record($1,$2,$3,$4) r", [
      actor,
      strikeId,
      ok,
      error,
    ]);
  const notices = async () =>
    (
      await db.query<Obj>(
        "select * from copyright_strike_notices order by created_at, strike_id",
      )
    ).rows;

  beforeEach(async () => {
    await db.query("insert into admin_roles values($1,'admin')", [ADMIN]);
    await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
      ADMIN,
    ]);
    await db.query("update auth.users set email=$1 where id=$2", [AUTHOR_EMAIL, ACTOR]);
  });

  it("un strike de Community confirmado da el contexto REAL (correo, nivel, vencimiento, motivo) y crea su registro de aviso", async () => {
    const strike = await communityStrike();
    expect(await notices()).toHaveLength(0); // aplicar el strike no crea nada: el aviso lo pide el handler tras confirmarlo
    const out = await ctx(strike.strikeId as string);
    expect(out).toMatchObject({
      strikeId: strike.strikeId,
      strike: {
        authorEmail: AUTHOR_EMAIL,
        level: 1,
        permanent: false,
        reason: "Strike de Community",
      },
    });
    expect(new Date((out.strike as Obj).endsAt as string).getTime()).toBe(
      new Date(strike.endsAt as string).getTime(),
    );
    expect(await notices()).toEqual([
      expect.objectContaining({
        strike_id: strike.strikeId,
        claim_id: null,
        notified_at: null,
        attempts: 0,
      }),
    ]);
    await ctx(strike.strikeId as string); // pedir el contexto otra vez no duplica el registro
    expect(await notices()).toHaveLength(1);
  });

  it("sin strike real no hay aviso: inexistente, de Copyright (otro circuito), revocado y actor sin permisos", async () => {
    await fails(() => ctx(uid(424242)), /strike_not_found/);
    const copyright = await apply((await purgedClaim()).id);
    await fails(() => ctx(copyright.strikeId as string), /strike_not_found/);
    const community = await communityStrike();
    await fails(
      () => ctx(community.strikeId as string, uid(9999)),
      /actor_not_moderator/,
    );
    await fails(
      () => rec(community.strikeId as string, true, null, uid(9999)),
      /actor_not_moderator/,
    );
    await one("select community_strike_revoke($1,$2,$3) r", [
      ADMIN,
      community.strikeId,
      "Corrección excepcional",
    ]);
    await fails(() => ctx(community.strikeId as string), /invalid_transition/);
    expect(
      (await notices()).filter((n) => n.strike_id === community.strikeId),
    ).toHaveLength(0);
  });

  it("registro: fallo reintentable, envío único e idempotente, y un aviso enviado no vuelve a pedirse", async () => {
    const strike = await communityStrike();
    const id = strike.strikeId as string;
    await fails(() => rec(id, true), /invalid_transition/); // sin contexto previo no hay nada que registrar
    await ctx(id);
    await fails(() => rec(id, false, "inventado"), /invalid_argument/);
    await fails(() => rec(id, true, "timeout"), /invalid_argument/);
    expect(await rec(id, false, "provider_unavailable")).toMatchObject({
      alreadyNotified: false,
    });
    expect(await notices()).toEqual([
      expect.objectContaining({
        attempts: 1,
        last_error: "provider_unavailable",
        notified_at: null,
      }),
    ]);
    await ctx(id); // tras un fallo se puede reintentar
    expect(await rec(id, true)).toMatchObject({ alreadyNotified: false });
    expect(await rec(id, true)).toMatchObject({ alreadyNotified: true });
    expect(await rec(id, false, "timeout")).toMatchObject({ alreadyNotified: true }); // un fallo tardío no desmarca un envío
    await fails(() => ctx(id), /invalid_transition/); // ya enviado: no hay nada que reenviar
    expect(await notices()).toEqual([
      expect.objectContaining({ attempts: 1, last_error: null }),
    ]);
    expect((await notices())[0]!.notified_at).not.toBeNull();
  });

  it("no cambia nada del strike, sus reglas ni la auditoría: solo el registro del aviso", async () => {
    const strike = await communityStrike();
    const before = (
      await db.query<Obj>("select * from community_user_strikes where id=$1", [
        strike.strikeId,
      ])
    ).rows[0];
    const audit = Number(
      (await db.query<{ n: string }>("select count(*) n from moderation_audit_log"))
        .rows[0]!.n,
    );
    await ctx(strike.strikeId as string);
    await rec(strike.strikeId as string, true);
    expect(
      (
        await db.query<Obj>("select * from community_user_strikes where id=$1", [
          strike.strikeId,
        ])
      ).rows[0],
    ).toEqual(before);
    expect(
      Number(
        (await db.query<{ n: string }>("select count(*) n from moderation_audit_log"))
          .rows[0]!.n,
      ),
    ).toBe(audit);
  });

  it("Copyright sigue igual: un aviso por reclamación, mismo flujo de contexto y registro", async () => {
    const r = await purgedClaim();
    const out = await apply(r.id);
    const [row] = await notices();
    expect(row).toMatchObject({
      claim_id: r.id,
      strike_id: out.strikeId,
      notified_at: null,
    });
    await fails(
      () =>
        db.query(
          "insert into copyright_strike_notices(claim_id, strike_id) values ($1, $2)",
          [r.id, uid(777)],
        ),
      /duplicate key|copyright_strike_notices_claim_idx|foreign key/,
    );
    expect(
      (await one<Obj>("select copyright_strike_notice_context($1,$2) r", [MOD, r.id]))
        .strike,
    ).toMatchObject({ authorEmail: AUTHOR_EMAIL, level: 1 });
    expect(
      await one<Obj>("select copyright_strike_notice_record($1,$2,$3,$4) r", [
        MOD,
        r.id,
        true,
        null,
      ]),
    ).toMatchObject({ alreadyNotified: false });
    expect((await state(r.id)).notice).toMatchObject({ status: "sent" });
  });

  it("funciones privadas, SECURITY DEFINER con search_path fijo; el SQL no toca strikes ni auditoría", async () => {
    for (const fn of [
      "community_strike_notice_context(uuid,uuid)",
      "community_strike_notice_record(uuid,uuid,boolean,text)",
    ]) {
      const rows = (
        await db.query<{ r: string; ok: boolean }>(
          `select r, has_function_privilege(r, $1, 'execute') ok from unnest(array['public','anon','authenticated','service_role']) r`,
          [`public.${fn}`],
        )
      ).rows;
      expect(Object.fromEntries(rows.map((x) => [x.r, x.ok]))).toEqual({
        public: false,
        anon: false,
        authenticated: false,
        service_role: true,
      });
    }
    const meta = (
      await db.query<{ definer: boolean; cfg: string[]; owner: string }>(
        `select prosecdef definer, proconfig cfg, pg_get_userbyid(proowner) owner from pg_proc where proname like 'community_strike_notice_%'`,
      )
    ).rows;
    expect(meta).toHaveLength(2);
    for (const m of meta) {
      expect(m.definer).toBe(true);
      expect(m.cfg.join()).toContain("search_path=pg_catalog, public");
      expect(m.owner).toBe("postgres");
    }
    expect(COMMUNITY_NOTICE.replace(/^--.*$/gm, "")).not.toMatch(
      /community_strike_apply|community_strike_revoke|moderation_audit_log|update public\.community_user_strikes/,
    );
  });

  it("rollback: se niega con avisos de Community y, sin ellos, restaura la clave por reclamación", async () => {
    const strike = await communityStrike();
    await ctx(strike.strikeId as string);
    await fails(
      () => db.exec(COMMUNITY_NOTICE_ROLLBACK),
      /rollback_blocked_community_strike_notices_exist/,
    );
    await db.exec("rollback");
    await db.exec("begin");
    await db.exec(COMMUNITY_NOTICE_ROLLBACK);
    expect(
      (
        await db.query<{ is_nullable: string }>(
          "select is_nullable from information_schema.columns where table_name='copyright_strike_notices' and column_name='claim_id'",
        )
      ).rows[0]!.is_nullable,
    ).toBe("NO");
  });
});
