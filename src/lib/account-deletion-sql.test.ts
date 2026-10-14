// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { CLAIM_EVENT_KINDS, CLAIM_STATUSES } from "./copyright-contract";
import { parseModerationCase } from "./moderation-case-parser";
import {
  runAccountDeletionBatch,
  runDeletionJob,
  type AuthAdmin,
  type AuthAdminOutcome,
  type DeletionDb,
  type WorkerDeps,
} from "./account-deletion-worker";
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
const DEL = migration("20261113120000_account_deletion_foundation.sql");
const DEL2 = migration("20261114120000_account_deletion_runtime.sql");
const DEL2_ROLLBACK = read(
  "supabase/rollbacks/20261114120000_account_deletion_runtime.rollback.sql",
);
const DEL_ROLLBACK = read(
  "supabase/rollbacks/20261113120000_account_deletion_foundation.rollback.sql",
);
const MEDIA_PENDING = migration("20261115120000_account_deletion_media_pending.sql");
const MEDIA_PENDING_ROLLBACK = read(
  "supabase/rollbacks/20261115120000_account_deletion_media_pending.rollback.sql",
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
 create function public.upmina_lock_admin_roles() returns void language sql as 'select 1';
 alter table profiles add column username text,add column display_name text,add column avatar_path text;
 alter table media_assets add column storage_key text,add column width int,add column height int,
   add column duration_seconds numeric,add column private_original_key text,add column failure_code text;
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
  await db.exec(
    "alter table profiles add constraint profiles_username_key unique (username);",
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
  await db.exec(DEL);
  await db.exec(
    "create table auth.sessions(id uuid primary key default gen_random_uuid(), user_id uuid not null);",
  );
  await db.exec(DEL2);
  await db.exec(MEDIA_PENDING);
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

const reporters = [41, 42, 43].map((n) => uid(8000 + n));
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

// ---------------------------------------------------------------------------------------------------------------------------------
// DEL-1: eliminación definitiva de cuentas. SQL REAL (PGlite) de 20261113120000 sobre la cadena vigente + Copyright 2A/2B + strikes.
// Límites honestos: PGlite es una sola conexión (la concurrencia real se prueba por serialización lógica: lock + replay), no existe
// Auth/R2 reales (se simulan el borrado de identidad y el GC) y los endpoints son de DEL-2.
// ---------------------------------------------------------------------------------------------------------------------------------
const DEL_DEV = uid(4);
const DEL_ADMIN = uid(3);
let delN = 0;
const delHash = () => hex(`deletion-token-${++delN}`);
const STAGES = [
  "auth_block",
  "copyright_claims",
  "community_content",
  "profile",
  "media_gc",
  "auth_delete",
] as const;
const STAGE_FN: Record<string, string> = {
  copyright_claims: "account_deletion_stage_copyright",
  community_content: "account_deletion_stage_content",
  profile: "account_deletion_stage_profile",
  media_gc: "account_deletion_stage_media",
};
const requestDel = (user = ACTOR, ttl = 30) => {
  const token = delHash();
  return one<Obj>("select account_deletion_request($1,$2,$3) r", [user, token, ttl]).then(
    (r) => ({ token, r }),
  );
};
const confirmDel = (user: string, token: string) =>
  one<Obj>("select account_deletion_confirm($1,$2) r", [user, token]);
async function confirmed(user = ACTOR) {
  await db.query("update auth.users set email=$1 where id=$2", [AUTHOR_EMAIL, user]);
  const { token } = await requestDel(user);
  const c = await confirmDel(user, token);
  expect(c.outcome).toBe("confirmed");
  return { token, requestId: c.requestId as string };
}
const claimWork = (worker = "w1", lease = 300) =>
  one<Obj[]>("select account_deletion_claim($1,$2,5) r", [worker, lease]);
const startStage = (req: string, w: string, stage: string) =>
  one<Obj>("select account_deletion_step_start($1,$2,$3) r", [req, w, stage]);
const finishStage = (
  req: string,
  w: string,
  stage: string,
  ok: boolean,
  err: string | null = null,
  retry: number | null = null,
) =>
  one<Obj>("select account_deletion_step_finish($1,$2,$3,$4,$5,$6) r", [
    req,
    w,
    stage,
    ok,
    err,
    retry,
  ]);
async function runStage(req: string, w: string, stage: string) {
  await startStage(req, w, stage);
  return STAGE_FN[stage]
    ? one<Obj>(`select ${STAGE_FN[stage]}($1,$2) r`, [req, w])
    : ({} as Obj);
}
/** Ejecuta las seis etapas como lo hará el ejecutor de DEL-2 (el GC y el borrado de identidad se simulan). */
async function runAll(req: string, w = "w1", user = ACTOR) {
  const claimed = await claimWork(w);
  expect(claimed.map((c) => c.requestId)).toContain(req);
  for (const stage of STAGES) {
    if (stage === "media_gc")
      await db.exec("delete from media_assets where status = 'deleting'");
    await runStage(req, w, stage);
    if (stage === "auth_delete")
      await db.query("delete from auth.users where id=$1", [user]);
    await finishStage(req, w, stage, true);
  }
}
const closedCases = (page: Obj) => (page.cases as unknown[]).map(parseModerationCase);
const reqRow = async (id: string) =>
  (await db.query<Obj>("select * from account_deletion_requests where id=$1", [id]))
    .rows[0]!;
const gate = (user = ACTOR) => one<Obj>("select account_deletion_gate($1) r", [user]);
const countOf = async (table: string) =>
  Number((await db.query<{ n: string }>(`select count(*) n from ${table}`)).rows[0]!.n);
/** Rejuvenece/envejece una solicitud (created_at es identidad: solo se toca con el trigger desactivado, dentro del test). */
async function ageRequest(id: string, interval: string) {
  await db.exec(
    "alter table account_deletion_requests disable trigger account_deletion_requests_transitions",
  );
  await db.query(
    `update account_deletion_requests set created_at = created_at - interval '${interval}' where id=$1`,
    [id],
  );
  await db.exec(
    "alter table account_deletion_requests enable trigger account_deletion_requests_transitions",
  );
}

describe("DEL-1 · eliminación irreversible de cuentas", () => {
  beforeEach(async () => {
    await db.query("insert into admin_roles values($1,'developer')", [DEL_DEV]);
    await db.query("insert into admin_roles values($1,'admin')", [DEL_ADMIN]);
    for (const id of [DEL_DEV, DEL_ADMIN])
      await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
        id,
      ]);
    await db.query("update auth.users set email=$1 where id=$2", [AUTHOR_EMAIL, ACTOR]);
  });

  describe("solicitud, token y confirmación", () => {
    it("solo guarda el hash, la vista previa no tiene efectos y otra cuenta no puede usarlo", async () => {
      const { token, r } = await requestDel();
      expect(r.email).toBe(AUTHOR_EMAIL);
      const row = await reqRow(r.requestId as string);
      expect(row.status).toBe("pending_confirmation");
      expect(row.token_hash).toBe(token);
      expect(JSON.stringify(row)).not.toMatch(/plain|secret/i);
      const before = JSON.stringify(row);
      expect(
        await one("select account_deletion_preview($1,$2) r", [ACTOR, token]),
      ).toMatchObject({ state: "valid" });
      expect(
        await one("select account_deletion_preview($1,$2) r", [PENDING_USER, token]),
      ).toEqual({ state: "invalid" });
      expect(JSON.stringify(await reqRow(r.requestId as string))).toBe(before); // la vista previa no consumió ni cambió nada
      expect((await gate()).blocked).toBe(false);
      expect(await countOf("account_deletion_blocks")).toBe(0);
    });

    it("parámetros inválidos, cuenta inexistente, sin correo, límites y una solicitud nueva sustituye a la anterior", async () => {
      await fails(() => requestDel(ACTOR, 4), /invalid_argument/);
      await fails(
        () => one("select account_deletion_request($1,$2,30) r", [ACTOR, "no-es-hex"]),
        /invalid_argument/,
      );
      await fails(() => requestDel(uid(7777)), /user_not_found/);
      await db.query("update auth.users set email=null where id=$1", [ACTOR]);
      await fails(() => requestDel(), /no_email/);
      await db.query("update auth.users set email=$1 where id=$2", [AUTHOR_EMAIL, ACTOR]);
      const first = await requestDel();
      await fails(() => requestDel(), /request_too_soon/);
      await ageRequest(first.r.requestId as string, "2 minutes");
      const second = await requestDel();
      expect((await reqRow(first.r.requestId as string)).status).toBe("superseded");
      expect((await reqRow(first.r.requestId as string)).token_hash).toBeNull();
      expect((await confirmDel(ACTOR, first.token)).outcome).toBe("invalid_token"); // el enlace anterior ya no sirve
      expect((await confirmDel(ACTOR, second.token)).outcome).toBe("confirmed");
    });

    it("token caducado: se registra la caducidad, no se bloquea nada y no se puede usar después", async () => {
      const { token, r } = await requestDel();
      await db.query(
        "update account_deletion_requests set token_expires_at = now() - interval '1 second' where id=$1",
        [r.requestId],
      );
      expect(
        await one("select account_deletion_preview($1,$2) r", [ACTOR, token]),
      ).toEqual({ state: "expired" });
      expect(await confirmDel(ACTOR, token)).toEqual({ outcome: "expired" });
      const row = await reqRow(r.requestId as string);
      expect(row.status).toBe("expired");
      expect(row.token_hash).toBeNull();
      expect((await gate()).blocked).toBe(false);
      expect((await confirmDel(ACTOR, token)).outcome).toBe("invalid_token");
    });

    it("expire_pending caduca en lote solo lo vencido", async () => {
      const a = await requestDel();
      await db.query(
        "update account_deletion_requests set token_expires_at = now() - interval '1 minute' where id=$1",
        [a.r.requestId],
      );
      expect(await one("select account_deletion_expire_pending(10) r")).toBe(1);
      expect((await reqRow(a.r.requestId as string)).status).toBe("expired");
      expect(await one("select account_deletion_expire_pending(10) r")).toBe(0);
    });

    it("la sesión de otra cuenta no consume el token; el consumo es único y la repetición no duplica nada", async () => {
      const { token, r } = await requestDel();
      expect((await confirmDel(PENDING_USER, token)).outcome).toBe("invalid_token");
      expect((await reqRow(r.requestId as string)).status).toBe("pending_confirmation"); // intacto
      const ok = await confirmDel(ACTOR, token);
      expect(ok).toMatchObject({ outcome: "confirmed", requestId: r.requestId });
      const row = await reqRow(r.requestId as string);
      expect(row).toMatchObject({ status: "access_blocked", token_hash: null });
      expect(row.confirmed_at).not.toBeNull();
      expect(row.access_blocked_at).not.toBeNull();
      // Repetición / segunda pestaña / carrera serializada por el lock: mismo resultado, ninguna fila extra.
      expect(await confirmDel(ACTOR, token)).toMatchObject({
        outcome: "already_deleting",
        requestId: r.requestId,
      });
      expect(await confirmDel(ACTOR, delHash())).toMatchObject({
        outcome: "already_deleting",
      });
      expect(await countOf("account_deletion_blocks")).toBe(1);
      expect(await countOf("account_deletion_steps")).toBe(6);
      expect(
        Number(
          (
            await db.query<{ n: string }>(
              "select count(*) n from account_deletion_events where kind='confirmed'",
            )
          ).rows[0]!.n,
        ),
      ).toBe(1);
      await fails(() => requestDel(), /account_deletion_in_progress/);
    });

    it("una cuenta privilegiada no usa el flujo ordinario, ni antes ni si recibe el rol entre la solicitud y la confirmación", async () => {
      await db.query("update auth.users set email=$1 where id in ($2,$3)", [
        AUTHOR_EMAIL,
        DEL_ADMIN,
        DEL_DEV,
      ]);
      await fails(() => requestDel(DEL_ADMIN), /privileged_account_requires_procedure/);
      await fails(() => requestDel(DEL_DEV), /privileged_account_requires_procedure/);
      const { token, r } = await requestDel();
      await db.query(
        "insert into admin_roles values($1,'moderator') on conflict do nothing",
        [ACTOR],
      );
      expect(await confirmDel(ACTOR, token)).toEqual({ outcome: "privileged_account" });
      expect((await reqRow(r.requestId as string)).status).toBe("pending_confirmation");
      expect((await gate()).blocked).toBe(false);
    });
  });

  describe("barrera irreversible", () => {
    it("ninguna operación devuelve la cuenta a un estado activo ni borra la barrera", async () => {
      const { requestId } = await confirmed();
      const bad = [
        "update account_deletion_requests set status = 'pending_confirmation'",
        "update account_deletion_requests set status = 'expired'",
        "update account_deletion_requests set status = 'completed'",
        "update account_deletion_requests set confirmed_at = null, access_blocked_at = null",
        "update account_deletion_requests set user_id = gen_random_uuid()",
        "delete from account_deletion_requests",
        "truncate account_deletion_requests cascade",
        "update account_deletion_blocks set blocked_at = now()",
        "delete from account_deletion_blocks",
        "truncate account_deletion_blocks",
        "delete from account_deletion_events",
        "update account_deletion_events set kind = 'completed'",
      ];
      for (const sql of bad)
        await fails(
          () => db.exec(sql),
          /account_deletion_|permanent|immutable|transition/,
        );
      expect((await reqRow(requestId)).status).toBe("access_blocked");
      expect((await gate()).blocked).toBe(true);
      expect(await gate()).toMatchObject({
        blocked: true,
        requestId,
        status: "access_blocked",
      });
    });

    it("un JWT anterior no sirve: toda escritura de la cuenta bloqueada se rechaza, y la moderación y la limpieza siguen funcionando", async () => {
      const post = await newPost("antes de borrar");
      const asset = uid(9100);
      await db.query(
        "insert into media_assets(id,domain,status,kind,created_by) values ($1,'community','ready','image',$2)",
        [asset, ACTOR],
      );
      await confirmed();
      const writes: [string, unknown[]][] = [
        ["insert into community_posts(author_user_id,text) values($1,'nuevo')", [ACTOR]],
        ["update community_posts set text = 'editado' where id=$1", [post]],
        [
          "insert into community_post_likes(post_id,user_id) values($1,$2)",
          [post, ACTOR],
        ],
        [
          "insert into community_post_reports(reporter_user_id,post_id,reason) values($1,$2,'spam')",
          [ACTOR, post],
        ],
        [
          "insert into media_assets(id,domain,status,kind,created_by) values (gen_random_uuid(),'community','reserved','image',$1)",
          [ACTOR],
        ],
        [
          "insert into community_post_media(post_id,asset_id,position) values($1,$2,9)",
          [post, asset],
        ],
        ["update profiles set display_name = 'otro' where user_id=$1", [ACTOR]],
        ["insert into admin_roles values($1,'admin')", [ACTOR]],
      ];
      for (const [sql, params] of writes)
        await fails(() => db.query(sql, params), /account_deletion_blocked/);
      // La moderación sigue pudiendo ocultar la publicación (no cambia el texto) y la limpieza puede borrar.
      await db.query("update community_posts set status = 'hidden' where id=$1", [post]);
      expect((await postRow(post))!.status).toBe("hidden");
      await db.query("delete from community_posts where id=$1", [post]);
      // Otras cuentas no se ven afectadas.
      await db.query(
        "insert into community_posts(author_user_id,text) values($1,'ajeno')",
        [PENDING_USER],
      );
    });
  });

  describe("limpieza idempotente y recuperable", () => {
    it("un fallo parcial NO devuelve el acceso, deja alerta persistente y se reanuda sin repetir lo hecho", async () => {
      const { requestId } = await confirmed();
      await claimWork("w1");
      await runStage(requestId, "w1", "auth_block");
      await finishStage(requestId, "w1", "auth_block", true);
      await runStage(requestId, "w1", "copyright_claims");
      const failed = await finishStage(
        requestId,
        "w1",
        "copyright_claims",
        false,
        "db_error",
      );
      expect(failed).toMatchObject({ manualRequired: false, retryInSeconds: 30 });
      const row = await reqRow(requestId);
      expect(row).toMatchObject({
        status: "cleanup_retry_pending",
        failed_stage: "copyright_claims",
        last_error_code: "db_error",
        alert_open: true,
        consecutive_failures: 1,
      });
      expect(row.lease_owner).toBeNull();
      expect((await gate()).blocked).toBe(true); // el error de limpieza no abre la cuenta
      await fails(
        () =>
          db.query("insert into community_posts(author_user_id,text) values($1,'x')", [
            ACTOR,
          ]),
        /account_deletion_blocked/,
      );
      expect(await claimWork("w2")).toEqual([]); // aún no toca el reintento
      await db.query(
        "update account_deletion_requests set next_retry_at = now() - interval '1 second' where id=$1",
        [requestId],
      );
      const again = await claimWork("w2");
      expect(again).toHaveLength(1);
      expect(again[0]).toMatchObject({
        requestId,
        resumed: true,
        nextStage: "copyright_claims",
      });
      expect(await startStage(requestId, "w2", "auth_block")).toEqual({
        stage: "auth_block",
        alreadyDone: true,
      }); // no repite
      for (const stage of [
        "copyright_claims",
        "community_content",
        "profile",
        "media_gc",
        "auth_delete",
      ]) {
        if (stage === "media_gc")
          await db.exec("delete from media_assets where status = 'deleting'");
        await runStage(requestId, "w2", stage);
        const mid = await reqRow(requestId);
        if (stage !== "auth_delete") expect(mid.alert_open).toBe(true); // nada la resuelve hasta COMPLETAR
        await finishStage(requestId, "w2", stage, true);
      }
      const done = await reqRow(requestId);
      expect(done).toMatchObject({
        status: "completed",
        alert_open: false,
        lease_owner: null,
      });
      expect(done.completed_at).not.toBeNull();
      const kinds = (
        await db.query<{ kind: string }>(
          "select kind from account_deletion_events where request_id=$1 order by created_at, id",
          [requestId],
        )
      ).rows.map((e) => e.kind);
      expect(kinds.filter((k) => k === "completed")).toHaveLength(1);
      expect(kinds).toEqual(
        expect.arrayContaining(["stage_failed", "retry_scheduled", "cleanup_claimed"]),
      );
      await fails(
        () =>
          db.query(
            "update account_deletion_requests set status='access_blocked' where id=$1",
            [requestId],
          ),
        /terminal|transition/,
      );
    });

    it("dos ejecutores a la vez: el lease serializa, un worker caído se recupera y el lease perdido no puede escribir", async () => {
      const { requestId } = await confirmed();
      expect(await claimWork("w1")).toHaveLength(1);
      expect(await claimWork("w2")).toEqual([]); // ya reclamada
      await startStage(requestId, "w1", "auth_block");
      await fails(() => startStage(requestId, "w2", "auth_block"), /lease_lost/);
      await fails(() => startStage(requestId, "w1", "profile"), /stage_out_of_order/);
      await db.query(
        "update account_deletion_requests set lease_until = now() - interval '1 second' where id=$1",
        [requestId],
      );
      const rescued = await claimWork("w2");
      expect(rescued[0]).toMatchObject({ resumed: true, nextStage: "auth_block" });
      const step = (
        await db.query<Obj>(
          "select status from account_deletion_steps where request_id=$1 and stage='auth_block'",
          [requestId],
        )
      ).rows[0]!;
      expect(step.status).toBe("pending"); // la etapa interrumpida se repite
      await fails(() => finishStage(requestId, "w1", "auth_block", true), /lease_lost/);
      await fails(
        () => finishStage(requestId, "w2", "auth_block", true),
        /stage_not_running/,
      );
      await runStage(requestId, "w2", "auth_block");
      await finishStage(requestId, "w2", "auth_block", true);
      await fails(
        () => finishStage(requestId, "w2", "profile", false, "texto-libre"),
        /invalid_argument/,
      );
    });

    it("un lease caducado del mismo worker tampoco puede cerrar etapas, y una solicitud en curso no vuelve a «bloqueada»", async () => {
      const { requestId } = await confirmed();
      await claimWork("w1");
      await startStage(requestId, "w1", "auth_block");
      await fails(
        () =>
          db.query(
            "update account_deletion_requests set status='access_blocked', lease_owner=null, lease_until=null where id=$1",
            [requestId],
          ),
        /transition/,
      );
      await db.query(
        "update account_deletion_requests set lease_until = now() - interval '1 second' where id=$1",
        [requestId],
      );
      await fails(() => finishStage(requestId, "w1", "auth_block", true), /lease_lost/);
    });

    it("liberar devuelve la solicitud a la cola sin contar fallo ni abrir alerta", async () => {
      const { requestId } = await confirmed();
      await claimWork("w1");
      await startStage(requestId, "w1", "auth_block");
      await db.query("select account_deletion_release($1,$2)", [requestId, "w1"]);
      const row = await reqRow(requestId);
      expect(row).toMatchObject({
        status: "cleanup_retry_pending",
        consecutive_failures: 0,
        alert_open: false,
      });
      expect(await claimWork("w3")).toHaveLength(1);
    });

    it("agotados los reintentos (o un error no reintentable) queda en intervención manual con la alerta abierta", async () => {
      const { requestId } = await confirmed();
      await claimWork("w1");
      for (let i = 1; i <= 8; i += 1) {
        await runStage(requestId, "w1", "auth_block");
        const out = await finishStage(
          requestId,
          "w1",
          "auth_block",
          false,
          "auth_unavailable",
        );
        if (i < 8) {
          expect(out.manualRequired).toBe(false);
          await db.query(
            "update account_deletion_requests set next_retry_at = now() where id=$1",
            [requestId],
          );
          await claimWork("w1");
        } else expect(out).toMatchObject({ manualRequired: true, retryInSeconds: null });
      }
      expect(await reqRow(requestId)).toMatchObject({
        status: "cleanup_manual_required",
        alert_open: true,
        consecutive_failures: 8,
        next_retry_at: null,
      });
      expect(await claimWork("w1")).toEqual([]); // no hay bucle infinito
      expect((await gate()).blocked).toBe(true);
    });

    it("backoff exponencial con tope y petición del proveedor acotada", async () => {
      const { requestId } = await confirmed();
      await claimWork("w1");
      await runStage(requestId, "w1", "auth_block");
      expect(
        (await finishStage(requestId, "w1", "auth_block", false, "timeout", 100000))
          .retryInSeconds,
      ).toBe(21600);
      await db.query(
        "update account_deletion_requests set next_retry_at = now() where id=$1",
        [requestId],
      );
      await claimWork("w1");
      await runStage(requestId, "w1", "auth_block");
      expect(
        (await finishStage(requestId, "w1", "auth_block", false, "timeout"))
          .retryInSeconds,
      ).toBe(60);
    });
  });

  describe("Developer: alertas y reintento manual", () => {
    async function manual(code = "last_admin_protected") {
      const { requestId } = await confirmed();
      await claimWork("w1");
      await runStage(requestId, "w1", "auth_block");
      await finishStage(requestId, "w1", "auth_block", false, code);
      return requestId;
    }
    it("last_admin_protected no se reintenta solo; la alerta la ve solo un developer, sin identidades, y persiste al leerla", async () => {
      const requestId = await manual();
      expect((await reqRow(requestId)).status).toBe("cleanup_manual_required");
      const seen = await one<Obj[]>("select account_deletion_alerts($1) r", [DEL_DEV]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        requestId,
        status: "cleanup_manual_required",
        accessBlocked: true,
        failedStage: "auth_block",
        errorCode: "last_admin_protected",
        manualRequired: true,
        totalAttempts: 1,
      });
      expect(seen[0]!.pendingStages).toHaveLength(6);
      expect(JSON.stringify(seen)).not.toContain(ACTOR);
      expect(JSON.stringify(seen)).not.toContain(AUTHOR_EMAIL);
      expect(
        await one<Obj[]>("select account_deletion_alerts($1) r", [DEL_DEV]),
      ).toHaveLength(1); // leer no la resuelve
      for (const who of [MOD, DEL_ADMIN, ACTOR, uid(9999)]) {
        await fails(
          () => one("select account_deletion_alerts($1) r", [who]),
          /actor_not_developer/,
        );
        await fails(
          () => one("select account_deletion_developer_retry($1,$2) r", [who, requestId]),
          /actor_not_developer/,
        );
      }
    });

    it("el reintento del developer solo reprograma las etapas incompletas, deja la barrera y no es aplicable a lo demás", async () => {
      const requestId = await manual("avatar_not_supported");
      const retried = await one<Obj>("select account_deletion_developer_retry($1,$2) r", [
        DEL_DEV,
        requestId,
      ]);
      expect(retried).toEqual({ requestId, status: "cleanup_retry_pending" });
      expect(await reqRow(requestId)).toMatchObject({
        status: "cleanup_retry_pending",
        manual_retry_count: 1,
        consecutive_failures: 0,
        alert_open: true,
      });
      expect((await gate()).blocked).toBe(true);
      const ev = (
        await db.query<Obj>(
          "select actor_kind, actor_user_id from account_deletion_events where kind='developer_retry'",
        )
      ).rows;
      expect(ev).toEqual([{ actor_kind: "human", actor_user_id: DEL_DEV }]);
      await claimWork("w1");
      await fails(
        () =>
          one("select account_deletion_developer_retry($1,$2) r", [DEL_DEV, requestId]),
        /retry_not_applicable/,
      ); // en curso
      await fails(
        () => one("select account_deletion_developer_retry($1,$2) r", [DEL_DEV, uid(1)]),
        /request_not_found/,
      );
      await fails(
        () => one("select account_deletion_developer_retry($1,$2) r", [DEL_DEV, null]),
        /invalid_argument|request_not_found/,
      );
    });

    it("una solicitud completada no se puede reintentar ni reabrir, y ya no genera alertas", async () => {
      const { requestId } = await confirmed();
      await runAll(requestId);
      expect(await one<Obj[]>("select account_deletion_alerts($1) r", [DEL_DEV])).toEqual(
        [],
      );
      await fails(
        () =>
          one("select account_deletion_developer_retry($1,$2) r", [DEL_DEV, requestId]),
        /already_completed/,
      );
    });

    it("un worker detenido (access_blocked sin reclamar durante 15 min) aparece como alerta 'stalled'", async () => {
      const { requestId } = await confirmed();
      expect(await one<Obj[]>("select account_deletion_alerts($1) r", [DEL_DEV])).toEqual(
        [],
      );
      await db.exec(
        "alter table account_deletion_requests disable trigger account_deletion_requests_transitions",
      );
      await db.query(
        "update account_deletion_requests set access_blocked_at = now() - interval '20 minutes', confirmed_at = now() - interval '20 minutes' where id=$1",
        [requestId],
      );
      await db.exec(
        "alter table account_deletion_requests enable trigger account_deletion_requests_transitions",
      );
      const seen = await one<Obj[]>("select account_deletion_alerts($1) r", [DEL_DEV]);
      expect(seen[0]).toMatchObject({
        requestId,
        stalled: true,
        status: "access_blocked",
      });
    });
  });

  describe("integridad con Community y Copyright", () => {
    it("un strike activo no bloquea la eliminación y strikes, casos, decisiones, reportes y auditoría quedan intactos", async () => {
      const strike = await communityStrike();
      expect(strike).toBeTruthy();
      const snapshot = async () =>
        JSON.stringify([
          (await db.query("select * from community_user_strikes order by id")).rows,
          (await db.query("select * from community_moderation_cases order by id")).rows,
          (await db.query("select * from community_moderation_cycles order by id")).rows,
          (await db.query("select * from community_moderation_decisions order by id"))
            .rows,
          (await db.query("select * from community_post_reports order by id")).rows,
          (await db.query("select * from moderation_audit_log order by id")).rows,
        ]);
      const before = await snapshot();
      expect(await countOf("community_user_strikes")).toBe(1);
      const { requestId } = await confirmed(); // con el strike activo: se acepta
      await runAll(requestId);
      expect(await snapshot()).toBe(before); // evidencia 100 % intacta, con el UUID original
      expect(
        (await db.query("select * from community_posts where author_user_id=$1", [ACTOR]))
          .rows,
      ).toEqual([]);
      expect(
        (await db.query("select * from profiles where user_id=$1", [ACTOR])).rows,
      ).toEqual([]);
    });

    it("reclamación retirada: se cierra técnicamente ANTES de borrar la publicación; conserva la evidencia y deja de ser operable", async () => {
      await db.exec(
        "delete from community_post_media; delete from community_posts where author_user_id = '" +
          ACTOR +
          "'; delete from media_assets",
      );
      const r = await removedAndNotified();
      const claimBefore = await claimRow(r.id);
      const { requestId } = await confirmed();
      await claimWork("w1");
      await runStage(requestId, "w1", "auth_block");
      await finishStage(requestId, "w1", "auth_block", true);
      // Saltarse la etapa de Copyright no es posible: el orden lo impide...
      await fails(
        () => startStage(requestId, "w1", "community_content"),
        /stage_out_of_order/,
      );
      // ...y aunque se llamara a la función, la publicación protegida lo detecta.
      await db.query(
        "update account_deletion_steps set status='running' where request_id=$1 and stage='community_content'",
        [requestId],
      );
      await fails(
        () => one("select account_deletion_stage_content($1,$2) r", [requestId, "w1"]),
        /copyright_stage_incomplete/,
      );
      await db.query(
        "update account_deletion_steps set status='pending' where request_id=$1 and stage='community_content'",
        [requestId],
      );
      expect(await runStage(requestId, "w1", "copyright_claims")).toEqual({
        claimsClosed: 1,
      });
      await finishStage(requestId, "w1", "copyright_claims", true);
      const claim = await claimRow(r.id);
      expect(claim).toMatchObject({
        status: "author_deleted",
        appeal_token_hash: null,
        resolution_notice_pending: false,
      });
      expect(claim.version).toBe((claimBefore.version as number) + 1);
      for (const k of [
        "claimant_email",
        "claimant_name",
        "post_text_snapshot",
        "removed_at",
        "removal_reason",
        "post_id",
        "post_author_user_id",
        "reference",
      ])
        expect(claim[k]).toEqual(claimBefore[k]); // evidencia mínima intacta
      const ev = (
        await db.query<Obj>(
          "select kind, actor_kind, actor_user_id, from_status, to_status from copyright_claim_events where claim_id=$1 order by created_at, id",
          [r.id],
        )
      ).rows;
      expect(ev.at(-1)).toEqual({
        kind: "author_deleted",
        actor_kind: "system",
        actor_user_id: null,
        from_status: "removed",
        to_status: "author_deleted",
      });
      // Ya no es operable por el circuito de Copyright.
      await fails(
        () => purge(r.id, r.reference, claim.version as number),
        /purge_blocked|invalid_transition|not_removed/,
      );
      await fails(() => appeal(r.token), /./);
      const content = await runStage(requestId, "w1", "community_content");
      expect(content).toMatchObject({
        postsDeleted: 1,
        assetsMarked: 2,
        assetsRetained: 0,
      });
      expect(
        (
          await db.query("select status from media_assets where id = any($1::uuid[])", [
            r.ids,
          ])
        ).rows,
      ).toEqual([{ status: "deleting" }, { status: "deleting" }]);
      expect(await postRow(r.post)).toBeUndefined();
      expect(await countOf("community_user_strikes")).toBe(0);
    });

    it("apelación pendiente: la reclamación se cierra sin inventar una decisión; el resto de estados finales no se tocan", async () => {
      const r = await removedAndNotified();
      await appeal(r.token);
      expect((await claimRow(r.id)).status).toBe("appeal_pending");
      const purgedOne = await purgedClaim(); // otra reclamación ya purged (misma autora)
      const { requestId } = await confirmed();
      await claimWork("w1");
      await runStage(requestId, "w1", "auth_block");
      await finishStage(requestId, "w1", "auth_block", true);
      expect(await runStage(requestId, "w1", "copyright_claims")).toEqual({
        claimsClosed: 1,
      });
      expect((await claimRow(r.id)).status).toBe("author_deleted");
      expect((await claimRow(purgedOne.id)).status).toBe("purged");
      const ap = (
        await db.query<Obj>(
          "select status, resolved_at, resolved_by from copyright_appeals where claim_id=$1",
          [r.id],
        )
      ).rows[0]!;
      expect(ap).toEqual({ status: "pending", resolved_at: null, resolved_by: null }); // no se resuelve en nombre de nadie
      // Idempotente: repetir la etapa no cierra nada más.
      await db.query(
        "update account_deletion_steps set status='running' where request_id=$1 and stage='copyright_claims'",
        [requestId],
      );
      expect(
        await one("select account_deletion_stage_copyright($1,$2) r", [requestId, "w1"]),
      ).toEqual({ claimsClosed: 0 });
    });

    it("contenido: solo se marcan los archivos exclusivos, los compartidos se conservan, se borran los me gusta y no se toca a otras cuentas", async () => {
      // El arnés siembra contenido de ACTOR: se parte de una cuenta sin contenido previo.
      await db.exec(
        "delete from community_post_media; delete from community_posts where author_user_id = '" +
          ACTOR +
          "'; delete from media_assets",
      );
      const mine = await postWithMedia("mía", 2);
      const shared = uid(9200);
      await db.query(
        "insert into media_assets(id,domain,status,kind,created_by) values ($1,'community','ready','image',$2)",
        [shared, ACTOR],
      );
      await db.query(
        "insert into community_post_media(post_id,asset_id,position) values ($1,$2,5)",
        [mine.post, shared],
      );
      await db.query("insert into cosplay_post_images(asset_id) values ($1)", [shared]);
      const foreign = uid(9300);
      await db.query(
        "insert into community_posts(id,author_user_id,text) values ($1,$2,'ajena')",
        [foreign, PENDING_USER],
      );
      await db.query("insert into community_post_likes(post_id,user_id) values ($1,$2)", [
        foreign,
        ACTOR,
      ]);
      await db.query("insert into community_post_likes(post_id,user_id) values ($1,$2)", [
        mine.post,
        PENDING_USER,
      ]);
      const { requestId } = await confirmed();
      await claimWork("w1");
      for (const s of ["auth_block", "copyright_claims"]) {
        await runStage(requestId, "w1", s);
        await finishStage(requestId, "w1", s, true);
      }
      const out = await runStage(requestId, "w1", "community_content");
      expect(out).toEqual({
        casesClosed: 0,
        postsDeleted: 1,
        likesDeleted: 1,
        assetsMarked: 2,
        assetsRetained: 1,
      });
      expect(
        (await db.query("select id, status from media_assets order by id")).rows,
      ).toEqual(expect.arrayContaining([{ id: shared, status: "ready" }]));
      expect(await postRow(foreign)).toBeDefined();
      expect(
        Number(
          (
            await db.query<{ n: string }>(
              "select like_count n from community_posts where id=$1",
              [foreign],
            )
          ).rows[0]!.n,
        ),
      ).toBe(0);
      await finishStage(requestId, "w1", "community_content", true);
      // Archivos exclusivos aún en 'deleting' => el GC todavía no terminó: la etapa de medios informa pendiente.
      await runStage(requestId, "w1", "profile");
      await finishStage(requestId, "w1", "profile", true);
      await startStage(requestId, "w1", "media_gc");
      expect(
        await one("select account_deletion_stage_media($1,$2) r", [requestId, "w1"]),
      ).toEqual({ pending: 2 });
      expect(
        (await finishStage(requestId, "w1", "media_gc", false, "media_gc_pending", 300))
          .retryInSeconds,
      ).toBe(300);
      await db.query(
        "update account_deletion_requests set next_retry_at = now() where id=$1",
        [requestId],
      );
      await claimWork("w1");
      await db.exec("delete from media_assets where status = 'deleting'"); // GC existente de R2
      await startStage(requestId, "w1", "media_gc");
      expect(
        await one("select account_deletion_stage_media($1,$2) r", [requestId, "w1"]),
      ).toEqual({ pending: 0 });
    });

    it("subida reservada y abandonada: media_gc la lleva a 'deleting' (solo las propias, sin referencias) y no bloquea para siempre", async () => {
      await db.exec(
        "delete from community_post_media; delete from community_posts where author_user_id = '" +
          ACTOR +
          "'; delete from media_assets",
      );
      const ids = {
        reserved: uid(9401),
        uploaded: uid(9402),
        verifying: uid(9403),
        processing: uid(9404),
        foreignReserved: uid(9405),
        cosplayReserved: uid(9406),
      };
      for (const [status, id] of [
        ["reserved", ids.reserved],
        ["uploaded", ids.uploaded],
        ["verifying", ids.verifying],
        ["processing", ids.processing],
      ])
        await db.query(
          "insert into media_assets(id,domain,status,kind,created_by) values ($1,'community',$2,'image',$3)",
          [id, status, ACTOR],
        );
      await db.query(
        "insert into media_assets(id,domain,status,kind,created_by) values ($1,'community','reserved','image',$2)",
        [ids.foreignReserved, PENDING_USER],
      );
      await db.query(
        "insert into media_assets(id,domain,status,kind,created_by) values ($1,'community','reserved','image',$2)",
        [ids.cosplayReserved, ACTOR],
      );
      await db.query("insert into cosplay_post_images(asset_id) values ($1)", [
        ids.cosplayReserved,
      ]);
      const { requestId } = await confirmed();
      await claimWork("w1");
      for (const s of [
        "auth_block",
        "copyright_claims",
        "community_content",
        "profile",
      ]) {
        await runStage(requestId, "w1", s);
        await finishStage(requestId, "w1", s, true);
      }
      await startStage(requestId, "w1", "media_gc");
      expect(
        await one("select account_deletion_stage_media($1,$2) r", [requestId, "w1"]),
      ).toEqual({ pending: 4 });
      const status = async (id: string) =>
        (
          await db.query<{ s: string }>("select status s from media_assets where id=$1", [
            id,
          ])
        ).rows[0]?.s;
      for (const id of [ids.reserved, ids.uploaded, ids.verifying, ids.processing])
        expect(await status(id)).toBe("deleting");
      expect(await status(ids.foreignReserved)).toBe("reserved"); // ajena: intacta
      expect(await status(ids.cosplayReserved)).toBe("reserved"); // referenciada por Cosplay: intacta
      // El GC existente borra lo 'deleting' => la etapa termina sin intervención.
      await finishStage(requestId, "w1", "media_gc", false, "media_gc_pending", 300);
      await db.query(
        "update account_deletion_requests set next_retry_at = now() where id=$1",
        [requestId],
      );
      await claimWork("w1");
      await db.exec("delete from media_assets where status = 'deleting'");
      await startStage(requestId, "w1", "media_gc");
      expect(
        await one("select account_deletion_stage_media($1,$2) r", [requestId, "w1"]),
      ).toEqual({ pending: 0 });
    });

    it("migración de media_gc: conserva propietario y EXECUTE restringido, y el rollback restaura el comportamiento anterior", async () => {
      const privs = await db.query<{ a: boolean; s: boolean }>(
        `select has_function_privilege('anon','account_deletion_stage_media(uuid,text)','execute') a,
                has_function_privilege('service_role','account_deletion_stage_media(uuid,text)','execute') s`,
      );
      expect(privs.rows[0]).toEqual({ a: false, s: true });
      expect(MEDIA_PENDING).toContain("'reserved'");
      expect(MEDIA_PENDING_ROLLBACK).not.toContain("'reserved'");
      expect(MEDIA_PENDING).not.toMatch(/\b(drop|delete|truncate)\b/i);
    });

    it("avatar presente: la etapa de perfil falla cerrada (nunca borra a ciegas) y pasa a intervención manual", async () => {
      await db.query("update profiles set avatar_path = 'a/b.png' where user_id=$1", [
        ACTOR,
      ]);
      const { requestId } = await confirmed();
      await claimWork("w1");
      for (const s of ["auth_block", "copyright_claims", "community_content"]) {
        await runStage(requestId, "w1", s);
        await finishStage(requestId, "w1", s, true);
      }
      await startStage(requestId, "w1", "profile");
      await fails(
        () => one("select account_deletion_stage_profile($1,$2) r", [requestId, "w1"]),
        /avatar_not_supported/,
      );
      expect(
        (await finishStage(requestId, "w1", "profile", false, "avatar_not_supported"))
          .manualRequired,
      ).toBe(true);
      expect(
        (await db.query("select 1 from profiles where user_id=$1", [ACTOR])).rows,
      ).toHaveLength(1);
    });
  });

  describe("D15 · cierre administrativo de casos de Community", () => {
    /** Publicación de ACTOR con un caso PENDIENTE (dos denunciantes distintos), sin decidir nada. */
    async function pendingCase(offset = 0) {
      const post = await newPost("publicación denunciada y pendiente");
      let ctx!: Obj;
      for (const i of [0, 1]) {
        const rid = uid(8100 + offset * 10 + i);
        await db.query(
          "insert into auth.users(id,email_confirmed_at) values($1,now()) on conflict do nothing",
          [rid],
        );
        await db.query(
          "insert into profiles(user_id,username) values($1,$2) on conflict do nothing",
          [rid, `rep_${offset}_${i}`],
        );
        ctx = await one<Obj>("select community_post_report_submit($1,$2,'spam',null) r", [
          rid,
          post,
        ]);
      }
      return { post, ctx };
    }
    const evidence = async () =>
      JSON.stringify([
        (await db.query("select * from community_user_strikes order by id")).rows,
        (await db.query("select * from community_moderation_decisions order by id")).rows,
        (await db.query("select * from community_post_reports order by id")).rows,
        (await db.query("select * from moderation_audit_log order by id")).rows,
      ]);
    const pendingCount = () =>
      one<number>("select community_moderation_pending_count($1) r", [MOD]);
    const closedEvents = async () =>
      Number(
        (
          await db.query<{ n: string }>(
            "select count(*) n from account_deletion_events where kind='case_closed'",
          )
        ).rows[0]!.n,
      );
    async function toContent(requestId: string, w = "w1") {
      await claimWork(w);
      for (const s of ["auth_block", "copyright_claims"]) {
        await runStage(requestId, w, s);
        await finishStage(requestId, w, s, true);
      }
    }

    it("cierra el caso pendiente sin decisión, strike, aviso ni cambio de reportes; sale de la cola y conserva ciclo e identidad histórica", async () => {
      const { ctx, post } = await pendingCase();
      const before = await evidence();
      expect(await pendingCount()).toBe(1);
      const { requestId } = await confirmed();
      await runAll(requestId);
      expect(await evidence()).toBe(before); // decisiones, strikes, reportes y auditoría de moderación: idénticos
      const c = (
        await db.query<Obj>("select * from community_moderation_cases where id=$1", [
          ctx.caseId,
        ])
      ).rows[0]!;
      expect(c).toMatchObject({
        status: "closed",
        target_author_user_id: ACTOR,
        post_id: post,
        version: (ctx.caseVersion as number) + 1,
      });
      expect(c.closed_at).not.toBeNull();
      const y = (
        await db.query<Obj>(
          "select status, closure_kind, closed_at from community_moderation_cycles where case_id=$1",
          [ctx.caseId],
        )
      ).rows;
      expect(y).toEqual([
        { status: "closed", closure_kind: "author_deleted", closed_at: c.closed_at },
      ]);
      expect(await pendingCount()).toBe(0); // fuera de la cola «Activos» y del contador
      const closed = closedCases(
        await one<Obj>("select community_moderation_cases_read($1,'closed') r", [MOD]),
      );
      expect(closed.find((k) => k.caseId === ctx.caseId)).toMatchObject({
        caseStatus: "closed",
        closureKind: "author_deleted",
      });
      expect(await postRow(post)).toBeUndefined();
      const ev = (
        await db.query<Obj>(
          "select actor_kind, actor_user_id, stage, metadata from account_deletion_events where kind='case_closed'",
        )
      ).rows;
      expect(ev).toEqual([
        {
          actor_kind: "system",
          actor_user_id: null,
          stage: "community_content",
          metadata: { caseId: ctx.caseId, closureKind: "author_deleted" },
        },
      ]);
    });

    it("un caso ya cerrado por una decisión no se toca ni se reabre; repetir la etapa no duplica nada", async () => {
      await communityStrike(); // caso cerrado por decisión humana + strike activo
      const snap = async (excluded: string) =>
        JSON.stringify(
          (
            await db.query(
              "select * from community_moderation_cases where id <> $1 order by id",
              [excluded],
            )
          ).rows,
        ) +
        JSON.stringify(
          (
            await db.query(
              "select * from community_moderation_cycles where case_id <> $1 order by id",
              [excluded],
            )
          ).rows,
        );
      const { ctx } = await pendingCase(1);
      const decided = await snap(ctx.caseId as string);
      const { requestId } = await confirmed();
      await toContent(requestId);
      expect(await runStage(requestId, "w1", "community_content")).toMatchObject({
        casesClosed: 1,
      });
      expect(await snap(ctx.caseId as string)).toBe(decided);
      await db.query(
        "update account_deletion_steps set status='pending' where request_id=$1 and stage='community_content'",
        [requestId],
      );
      expect(await runStage(requestId, "w1", "community_content")).toMatchObject({
        casesClosed: 0,
        postsDeleted: 0,
      });
      expect(await closedEvents()).toBe(1);
      expect(await countOf("community_user_strikes")).toBe(1); // ni nuevos strikes ni revocación del histórico
      expect(
        (
          await db.query(
            "select 1 from community_user_strikes where revoked_at is not null",
          )
        ).rows,
      ).toEqual([]);
    });

    it("un caso pendiente cuya publicación ya no existe (borrada antes por la autora) también se cierra por su autora objetivo", async () => {
      const { ctx, post } = await pendingCase(4);
      await db.exec("delete from community_post_media");
      await db.query("delete from community_posts where id=$1", [post]);
      expect(await pendingCount()).toBe(1);
      const { requestId } = await confirmed();
      await toContent(requestId);
      expect(await runStage(requestId, "w1", "community_content")).toMatchObject({
        casesClosed: 1,
      });
      expect(await pendingCount()).toBe(0);
      expect(
        (
          await db.query<Obj>(
            "select status from community_moderation_cases where id=$1",
            [ctx.caseId],
          )
        ).rows[0],
      ).toEqual({ status: "closed" });
    });

    it("un fallo a mitad de la etapa deshace TODO (caso, ciclo, auditoría, publicación) y el reintento la completa sin duplicados", async () => {
      const { ctx, post } = await pendingCase(2);
      const { requestId } = await confirmed();
      await toContent(requestId);
      await db.exec(`create function public.zz_boom() returns trigger language plpgsql as $f$ begin raise exception 'boom'; end $f$;
        create trigger zz_boom before delete on public.community_posts for each row execute function public.zz_boom();`);
      await startStage(requestId, "w1", "community_content");
      await fails(
        () => one("select account_deletion_stage_content($1,$2) r", [requestId, "w1"]),
        /boom/,
      );
      const caseStatus = async () =>
        (
          await db.query<Obj>(
            "select status from community_moderation_cases where id=$1",
            [ctx.caseId],
          )
        ).rows[0];
      expect(await caseStatus()).toEqual({ status: "pending" });
      expect(await postRow(post)).toBeDefined();
      expect(await closedEvents()).toBe(0);
      expect(
        (await finishStage(requestId, "w1", "community_content", false, "db_error"))
          .manualRequired,
      ).toBe(false);
      expect((await gate()).blocked).toBe(true);
      await db.exec("drop trigger zz_boom on public.community_posts");
      await db.query(
        "update account_deletion_requests set next_retry_at = now() where id=$1",
        [requestId],
      );
      await claimWork("w2");
      await runStage(requestId, "w2", "community_content");
      expect(await caseStatus()).toEqual({ status: "closed" });
      expect(await postRow(post)).toBeUndefined();
      expect(await closedEvents()).toBe(1);
    });

    it("convive con el cierre de Copyright sin mezclar semánticas: reclamación author_deleted y ciclo author_deleted, cada uno por su vía", async () => {
      const r = await removedAndNotified();
      const { ctx } = await pendingCase(3);
      const { requestId } = await confirmed();
      await runAll(requestId);
      expect((await claimRow(r.id)).status).toBe("author_deleted");
      expect(
        (
          await db.query<Obj>(
            "select closure_kind from community_moderation_cycles where case_id=$1",
            [ctx.caseId],
          )
        ).rows[0],
      ).toEqual({ closure_kind: "author_deleted" });
      expect(
        (
          await db.query(
            "select 1 from account_deletion_events where kind='case_closed' and metadata ? 'claimId'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await db
            .query(
              "select 1 from copyright_claim_events where claim_id=$1 and kind='case_closed'",
              [r.id],
            )
            .catch(() => ({ rows: [] }))
        ).rows,
      ).toEqual([]);
    });
  });

  describe("D16 · datos personales y liberación del username", () => {
    const NEW_USER = uid(9700);
    it("el username sigue reservado hasta borrar el perfil, solo se libera tras retirar lo público y la identidad nueva no hereda nada", async () => {
      await communityStrike(); // strike + caso + decisión históricos de ACTOR
      const mine = await postWithMedia("pública", 1);
      const { requestId } = await confirmed();
      await claimWork("w1");
      for (const s of ["auth_block", "copyright_claims"]) {
        await runStage(requestId, "w1", s);
        await finishStage(requestId, "w1", s, true);
      }
      const dup = (id: string) =>
        db.query("insert into profiles(user_id,username) values($1,'actor_user')", [id]);
      await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
        NEW_USER,
      ]);
      await fails(() => dup(NEW_USER), /unique|duplicate/i); // reservado mientras exista el perfil
      // Fuera de orden: el perfil NO se borra mientras quede contenido público.
      await db.query(
        "update account_deletion_steps set status='running' where request_id=$1 and stage='profile'",
        [requestId],
      );
      await fails(
        () => one("select account_deletion_stage_profile($1,$2) r", [requestId, "w1"]),
        /content_stage_incomplete/,
      );
      await db.query(
        "update account_deletion_steps set status='pending' where request_id=$1 and stage='profile'",
        [requestId],
      );
      await runStage(requestId, "w1", "community_content");
      await finishStage(requestId, "w1", "community_content", true);
      await fails(() => dup(NEW_USER), /unique|duplicate/i); // aún reservado: falta la etapa de perfil
      expect(await postRow(mine.post)).toBeUndefined();
      expect(await runStage(requestId, "w1", "profile")).toEqual({
        profileDeleted: true,
        usernameReleased: true,
      });
      await finishStage(requestId, "w1", "profile", true);
      // La cuenta antigua (bloqueada, con Auth aún vivo) no puede recuperar el username...
      await fails(
        () =>
          db.query("insert into profiles(user_id,username) values($1,'actor_user')", [
            ACTOR,
          ]),
        /account_deletion_blocked/,
      );
      // ...y otra persona sí puede registrarlo, con un UUID distinto.
      await dup(NEW_USER);
      expect(
        (await db.query("select user_id from profiles where username='actor_user'")).rows,
      ).toEqual([{ user_id: NEW_USER }]);
      const heredado = async (table: string, col: string) =>
        Number(
          (
            await db.query<{ n: string }>(
              `select count(*) n from ${table} where ${col}=$1`,
              [NEW_USER],
            )
          ).rows[0]!.n,
        );
      expect(await heredado("community_user_strikes", "user_id")).toBe(0);
      expect(await heredado("community_moderation_cases", "target_author_user_id")).toBe(
        0,
      );
      expect(await heredado("community_post_reports", "reporter_user_id")).toBe(0);
      expect(await heredado("copyright_claims", "post_author_user_id")).toBe(0);
      expect(await heredado("community_posts", "author_user_id")).toBe(0);
      expect(await heredado("media_assets", "created_by")).toBe(0);
      expect(await heredado("admin_roles", "user_id")).toBe(0);
      expect(await heredado("account_deletion_blocks", "user_id")).toBe(0);
      expect(await gate(NEW_USER)).toEqual({ blocked: false });
      expect(await countOf("community_user_strikes")).toBe(1); // el histórico sigue con el UUID original
      expect(
        (await db.query("select 1 from community_user_strikes where user_id=$1", [ACTOR]))
          .rows,
      ).toHaveLength(1);
      // Nada histórico se atribuye por username: el nombre solo se lee en vivo desde profiles y no hay copias.
      const closed = JSON.stringify(
        closedCases(
          await one<Obj>("select community_moderation_cases_read($1,'closed') r", [MOD]),
        ),
      );
      expect(closed).not.toContain("actor_user");
    });

    it("ninguna función ni vista de ninguna migración une el historial con profiles por username", () => {
      const dir = "supabase/migrations/";
      for (const f of readdirSync(dir)) {
        const sql = read(dir + f).replace(/--.*$/gm, "");
        expect(sql, f).not.toMatch(/join\s+public\.profiles[^;]*?on[^;]*?username\s*=/i);
        expect(sql, f).not.toMatch(/\.username\s*=\s*\w+\.username/i);
      }
    });

    it("unicidad y concurrencia: una sola solicitud pendiente y una sola eliminación confirmada por cuenta", async () => {
      const first = await requestDel();
      await fails(
        () =>
          db.query(
            "insert into account_deletion_requests(user_id,token_hash,token_expires_at) values($1,$2,now()+interval '1 hour')",
            [ACTOR, delHash()],
          ),
        /duplicate|unique/i,
      );
      await confirmDel(ACTOR, first.token);
      await fails(
        () =>
          db.query(
            "insert into account_deletion_requests(user_id,status,confirmed_at,access_blocked_at,token_expires_at) values($1,'access_blocked',now(),now(),now())",
            [ACTOR],
          ),
        /duplicate|unique/i,
      );
      await fails(
        () =>
          db.query(
            "insert into account_deletion_blocks(user_id,request_id) values($1,$2)",
            [uid(9701), first.r.requestId],
          ),
        /duplicate|unique/i,
      );
    });

    it("los datos históricos restringidos no son legibles por los roles de API y la cuenta eliminada conserva solo su UUID", async () => {
      for (const t of [
        "community_user_strikes",
        "community_moderation_cases",
        "community_moderation_decisions",
        "community_post_reports",
        "moderation_audit_log",
        "copyright_claims",
        "copyright_claim_events",
        "copyright_appeals",
        "copyright_strike_notices",
      ])
        for (const role of ["anon", "authenticated"])
          expect(
            await one<boolean>(
              "select has_table_privilege($1,$2,'select,insert,update,delete') r",
              [role, `public.${t}`],
            ),
            `${role} ${t}`,
          ).toBe(false);
      await communityStrike();
      const { requestId } = await confirmed();
      await runAll(requestId);
      expect(
        (await db.query("select * from profiles where user_id=$1", [ACTOR])).rows,
      ).toEqual([]);
      expect(
        (await db.query("select * from auth.users where id=$1", [ACTOR])).rows,
      ).toEqual([]);
      const strike = (await db.query<Obj>("select user_id from community_user_strikes"))
        .rows[0]!;
      expect(strike.user_id).toBe(ACTOR); // evidencia con UUID original, sin nombre ni correo
      expect(
        JSON.stringify((await db.query("select * from community_user_strikes")).rows),
      ).not.toMatch(/actor_user|@/);
    });
  });

  describe("DEL-2 · ejecutor real (TypeScript) sobre el SQL real", () => {
    // Auth y R2 son DOBLES (sin red): el ejecutor, las RPC, los triggers, los FK y la barrera son REALES.
    function sqlDb(): DeletionDb {
      return {
        rpc: async (fn, args = {}) => {
          const keys = Object.keys(args);
          const sql = `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`;
          await db.exec("savepoint rpc_call");
          try {
            const out = await db.query<{ r: unknown }>(
              sql,
              keys.map((k) => args[k]),
            );
            await db.exec("release savepoint rpc_call");
            return { data: out.rows[0]?.r ?? null, error: null };
          } catch (e) {
            await db.exec("rollback to savepoint rpc_call");
            return { data: null, error: { message: (e as Error).message } };
          }
        },
      };
    }
    function authFake(
      script: { ban?: AuthAdminOutcome[]; del?: AuthAdminOutcome[] } = {},
    ) {
      const calls: string[] = [];
      const authAdmin: AuthAdmin = {
        banUser: async () => {
          calls.push("ban");
          return script.ban?.shift() ?? { outcome: "ok" };
        },
        deleteUser: async (userId) => {
          calls.push("delete");
          const forced = script.del?.shift();
          if (forced) return forced;
          try {
            await db.exec("savepoint del_user");
            await db.query("delete from auth.users where id=$1", [userId]);
            await db.exec("release savepoint del_user");
            return { outcome: "ok" };
          } catch {
            await db.exec("rollback to savepoint del_user");
            return { outcome: "error" };
          }
        },
      };
      return { calls, authAdmin };
    }
    const worker = (authAdmin: AuthAdmin, workerId = "w1"): WorkerDeps => ({
      db: sqlDb(),
      authAdmin,
      workerId,
    });
    const due = (requestId: string) =>
      db.query("update account_deletion_requests set next_retry_at = now() where id=$1", [
        requestId,
      ]);
    const gc = () => db.exec("delete from media_assets where status = 'deleting'");
    const alerts = () => one<Obj[]>("select account_deletion_alerts($1) r", [DEL_DEV]);
    const NEW = uid(9800);
    /** El arnés siembra contenido de ACTOR: estas pruebas parten de una cuenta sin archivos propios pendientes. */
    const clean = () =>
      db.exec(
        "delete from community_post_media; delete from community_posts where author_user_id = '" +
          ACTOR +
          "'; delete from media_assets",
      );

    it("extremo a extremo: bloquea, cierra casos y reclamaciones, borra contenido y perfil, espera al GC, borra la identidad y NO reactiva nada", async () => {
      await communityStrike();
      const claim = await removedAndNotified();
      await db.query("insert into auth.sessions(user_id) values ($1),($1)", [ACTOR]);
      await db.query(
        "insert into community_posts(id,author_user_id,text) values ($1,$2,'ajena')",
        [uid(9801), PENDING_USER],
      );
      const strikes = JSON.stringify(
        (await db.query("select * from community_user_strikes order by id")).rows,
      );
      const { requestId } = await confirmed();
      const { calls, authAdmin } = authFake();

      // Lote 1: llega hasta media_gc; el GC de R2 aún no ha borrado los archivos => NO se borra la identidad.
      const one1 = await runAccountDeletionBatch(worker(authAdmin));
      expect(one1).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
      expect(calls).toEqual(["ban"]);
      expect(await reqRow(requestId)).toMatchObject({
        status: "cleanup_retry_pending",
        failed_stage: "media_gc",
        last_error_code: "media_gc_pending",
        alert_open: true,
      });
      expect(
        (await db.query("select * from auth.sessions where user_id=$1", [ACTOR])).rows,
      ).toEqual([]);
      expect((await gate()).blocked).toBe(true);
      expect((await claimRow(claim.id)).status).toBe("author_deleted");
      const seen = await alerts();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        failedStage: "media_gc",
        errorCode: "media_gc_pending",
      });

      // El GC existente borra los archivos; el reintento programado completa.
      await gc();
      await due(requestId);
      const two = await runAccountDeletionBatch(worker(authAdmin, "w2"));
      expect(two).toMatchObject({ claimed: 1, completed: 1 });
      expect(calls).toEqual(["ban", "delete"]); // el bloqueo no se repite; la identidad se borra una sola vez y la última
      expect(await reqRow(requestId)).toMatchObject({
        status: "completed",
        alert_open: false,
      });
      expect(await alerts()).toEqual([]);
      expect(
        (await db.query("select * from auth.users where id=$1", [ACTOR])).rows,
      ).toEqual([]);
      expect(await gate()).toMatchObject({ blocked: true, status: "completed" }); // sin Auth, sigue bloqueada
      expect(
        JSON.stringify(
          (await db.query("select * from community_user_strikes order by id")).rows,
        ),
      ).toBe(strikes);
      expect(await postRow(uid(9801))).toBeDefined(); // otra cuenta intacta
      // Username libre y sin herencia.
      await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
        NEW,
      ]);
      await db.query("insert into profiles(user_id,username) values($1,'actor_user')", [
        NEW,
      ]);
      expect(
        (await db.query("select 1 from community_user_strikes where user_id=$1", [NEW]))
          .rows,
      ).toEqual([]);
      // Una tercera pasada no hace nada.
      expect(await runAccountDeletionBatch(worker(authAdmin, "w3"))).toMatchObject({
        claimed: 0,
      });
      expect(calls).toEqual(["ban", "delete"]);
    });

    it("fallo de Auth al bloquear: etapa fallida, cuenta bloqueada, nada se borra; al recuperarse, continúa", async () => {
      const post = await newPost("sigue ahí hasta que Auth responda");
      const { requestId } = await confirmed();
      const { calls, authAdmin } = authFake({ ban: [{ outcome: "error" }] });
      expect(await runAccountDeletionBatch(worker(authAdmin))).toMatchObject({
        claimed: 1,
        failed: 1,
      });
      expect(await reqRow(requestId)).toMatchObject({
        status: "cleanup_retry_pending",
        failed_stage: "auth_block",
        last_error_code: "auth_unavailable",
      });
      expect(await postRow(post)).toBeDefined(); // ni siquiera se tocó el contenido
      expect((await gate()).blocked).toBe(true);
      await fails(
        () =>
          db.query("insert into community_posts(author_user_id,text) values($1,'x')", [
            ACTOR,
          ]),
        /account_deletion_blocked/,
      );
      await db.exec("delete from media_assets where status='deleting'");
      await due(requestId);
      expect(await runAccountDeletionBatch(worker(authAdmin, "w2"))).toMatchObject({
        claimed: 1,
      });
      expect(calls.slice(0, 2)).toEqual(["ban", "ban"]);
    });

    it("identidad ya inexistente en Auth equivale a éxito; fallo al borrarla deja la etapa pendiente con la cuenta bloqueada", async () => {
      await clean();
      const { requestId } = await confirmed();
      const { calls, authAdmin } = authFake({
        del: [{ outcome: "error" }, { outcome: "not_found" }],
      });
      await gc();
      expect(await runAccountDeletionBatch(worker(authAdmin))).toMatchObject({
        failed: 1,
      });
      expect(await reqRow(requestId)).toMatchObject({
        failed_stage: "auth_delete",
        last_error_code: "auth_unavailable",
      });
      expect(
        (await db.query("select 1 from auth.users where id=$1", [ACTOR])).rows,
      ).toHaveLength(1);
      expect((await gate()).blocked).toBe(true);
      await due(requestId);
      expect(await runAccountDeletionBatch(worker(authAdmin, "w2"))).toMatchObject({
        completed: 1,
      });
      expect(calls.filter((c) => c === "delete")).toHaveLength(2);
      expect((await reqRow(requestId)).status).toBe("completed");
    });

    it("worker interrumpido: sin tiempo se libera, otro worker reanuda sin repetir lo hecho; con lease vencido también", async () => {
      await clean();
      const post = await newPost("contenido");
      const { requestId } = await confirmed();
      const { calls, authAdmin } = authFake();
      // 1) El primer worker solo tiene tiempo para la primera etapa.
      let t = 0;
      const w1 = { ...worker(authAdmin), now: () => (t += 1000) };
      const claimed = await claimWork("w1");
      const summary = await runDeletionJob(w1, { requestId, userId: ACTOR }, 2500);
      expect(summary.released).toBe(true);
      expect(claimed).toHaveLength(1);
      expect(await reqRow(requestId)).toMatchObject({
        status: "cleanup_retry_pending",
        consecutive_failures: 0,
        alert_open: false,
      });
      // 2) Otro worker reanuda; mientras tiene el lease, un tercero no puede.
      await gc();
      await claimWork("w2");
      expect(await runAccountDeletionBatch(worker(authAdmin, "w3"))).toMatchObject({
        claimed: 0,
      });
      await db.query(
        "update account_deletion_requests set lease_until = now() - interval '1 second' where id=$1",
        [requestId],
      );
      expect(await runAccountDeletionBatch(worker(authAdmin, "w3"))).toMatchObject({
        claimed: 1,
        completed: 1,
      });
      expect(await postRow(post)).toBeUndefined();
      expect(calls.filter((c) => c === "ban")).toHaveLength(1);
    });

    it("8 fallos seguidos => intervención manual con alerta; el reintento del developer reprograma y el MISMO ejecutor completa", async () => {
      await clean();
      const { requestId } = await confirmed();
      const failing = authFake({
        ban: Array.from({ length: 8 }, () => ({ outcome: "error" as const })),
      });
      for (let i = 0; i < 8; i += 1) {
        await runAccountDeletionBatch(worker(failing.authAdmin, `w${i}`));
        if (i < 7) await due(requestId);
      }
      expect(await reqRow(requestId)).toMatchObject({
        status: "cleanup_manual_required",
        consecutive_failures: 8,
        alert_open: true,
      });
      expect(
        await runAccountDeletionBatch(worker(failing.authAdmin, "wx")),
      ).toMatchObject({ claimed: 0 });
      expect((await alerts())[0]).toMatchObject({
        manualRequired: true,
        errorCode: "auth_unavailable",
      });
      await fails(
        () =>
          one("select account_deletion_developer_retry($1,$2) r", [DEL_ADMIN, requestId]),
        /actor_not_developer/,
      );
      await one("select account_deletion_developer_retry($1,$2) r", [DEL_DEV, requestId]);
      expect((await gate()).blocked).toBe(true); // el reintento no toca la barrera
      await gc();
      expect(
        await runAccountDeletionBatch(worker(failing.authAdmin, "wy")),
      ).toMatchObject({ claimed: 1, completed: 1 });
      expect(await alerts()).toEqual([]);
    });

    it("last_admin_protected al borrar la identidad: manual de inmediato, cuenta bloqueada y el developer puede reintentar", async () => {
      await clean();
      const { requestId } = await confirmed();
      await gc();
      const { authAdmin } = authFake({
        del: [{ outcome: "error", lastAdminProtected: true }],
      });
      expect(await runAccountDeletionBatch(worker(authAdmin))).toMatchObject({
        failed: 1,
      });
      expect(await reqRow(requestId)).toMatchObject({
        status: "cleanup_manual_required",
        last_error_code: "last_admin_protected",
      });
      expect((await gate()).blocked).toBe(true);
      await one("select account_deletion_developer_retry($1,$2) r", [DEL_DEV, requestId]);
      expect(await runAccountDeletionBatch(worker(authAdmin, "w2"))).toMatchObject({
        completed: 1,
      });
    });

    it("las sesiones se revocan en la etapa de bloqueo y la tabla de sesiones de otra cuenta no se toca", async () => {
      await db.query("insert into auth.sessions(user_id) values ($1),($2)", [
        ACTOR,
        PENDING_USER,
      ]);
      await confirmed();
      await runAccountDeletionBatch(worker(authFake().authAdmin));
      expect((await db.query("select user_id from auth.sessions")).rows).toEqual([
        { user_id: PENDING_USER },
      ]);
    });
  });

  describe("permisos, retención y rollback", () => {
    const RPC = [
      "account_deletion_gate(uuid)",
      "account_deletion_request(uuid,text,integer)",
      "account_deletion_preview(uuid,text)",
      "account_deletion_confirm(uuid,text)",
      "account_deletion_expire_pending(integer)",
      "account_deletion_claim(text,integer,integer)",
      "account_deletion_step_start(uuid,text,text)",
      "account_deletion_step_finish(uuid,text,text,boolean,text,integer)",
      "account_deletion_release(uuid,text)",
      "account_deletion_stage_copyright(uuid,text)",
      "account_deletion_stage_content(uuid,text)",
      "account_deletion_stage_profile(uuid,text)",
      "account_deletion_stage_media(uuid,text)",
      "account_deletion_alerts(uuid)",
      "account_deletion_developer_retry(uuid,uuid)",
    ];
    const INTERNAL = [
      "account_deletion_is_blocked(uuid)",
      "account_deletion_assert_running(uuid,text,text)",
      "account_deletion_write_guard()",
      "account_deletion_post_media_guard()",
      "account_deletion_requests_guard()",
      "account_deletion_steps_guard()",
      "account_deletion_permanent_guard()",
    ];
    it("solo service_role ejecuta las RPC; los guards y auxiliares no los ejecuta nadie; las tablas son privadas con RLS forzada", async () => {
      for (const fn of RPC) {
        for (const role of ["anon", "authenticated", "public"])
          expect(
            await one<boolean>("select has_function_privilege($1,$2,'execute') r", [
              role,
              fn,
            ]),
            `${role} ${fn}`,
          ).toBe(false);
        expect(
          await one<boolean>(
            "select has_function_privilege('service_role',$1,'execute') r",
            [fn],
          ),
          fn,
        ).toBe(true);
        expect(
          await one<string>(
            "select pg_get_userbyid(proowner) r from pg_proc where oid = $1::regprocedure",
            [fn],
          ),
        ).toBe("postgres");
        expect(
          await one<boolean>(
            "select prosecdef r from pg_proc where oid = $1::regprocedure",
            [fn],
          ),
        ).toBe(true);
      }
      for (const fn of INTERNAL)
        for (const role of ["anon", "authenticated", "public", "service_role"])
          expect(
            await one<boolean>("select has_function_privilege($1,$2,'execute') r", [
              role,
              fn,
            ]),
            `${role} ${fn}`,
          ).toBe(false);
      for (const t of ["requests", "blocks", "steps", "events", "retention_catalog"]) {
        const table = `public.account_deletion_${t}`;
        for (const role of ["anon", "authenticated", "service_role"])
          expect(
            await one<boolean>(
              "select has_table_privilege($1,$2,'select,insert,update,delete,truncate') r",
              [role, table],
            ),
            `${role} ${t}`,
          ).toBe(false);
        const rls = (
          await db.query<Obj>(
            "select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass",
            [table],
          )
        ).rows[0]!;
        expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      }
    });

    it("DEL-2: revoke_sessions solo para service_role; backlog y tick no los ejecuta nadie salvo postgres; el tick sin trabajo solo expira y no llama a nadie", async () => {
      expect(
        await one<boolean>(
          "select has_function_privilege('service_role','account_deletion_revoke_sessions(uuid,text)','execute') r",
        ),
      ).toBe(true);
      for (const role of ["anon", "authenticated", "public"])
        expect(
          await one<boolean>(
            "select has_function_privilege($1,'account_deletion_revoke_sessions(uuid,text)','execute') r",
            [role],
          ),
        ).toBe(false);
      for (const fn of ["account_deletion_backlog()", "account_deletion_tick()"])
        for (const role of ["anon", "authenticated", "public", "service_role"])
          expect(
            await one<boolean>("select has_function_privilege($1,$2,'execute') r", [
              role,
              fn,
            ]),
            `${role} ${fn}`,
          ).toBe(false);
      const { token, r } = await requestDel();
      await db.query(
        "update account_deletion_requests set token_expires_at = now() - interval '1 minute' where id=$1",
        [r.requestId],
      );
      expect(token).toBeTruthy();
      expect(await one("select account_deletion_tick() r")).toEqual({
        status: "idle",
        expired: 1,
        backlog: 0,
      });
      expect((await reqRow(r.requestId as string)).status).toBe("expired");
      await confirmed();
      expect(await one<number>("select account_deletion_backlog() r")).toBe(1);
    });

    it("la retención no inventa plazos: todo está pendiente de revisión legal y ningún dataset aprobado puede carecer de plazo", async () => {
      const rows = (
        await db.query<Obj>(
          "select dataset, class, retention_days, basis_status from account_deletion_retention_catalog",
        )
      ).rows;
      expect(rows.length).toBeGreaterThanOrEqual(10);
      expect(
        rows.every(
          (x) => x.retention_days === null && x.basis_status === "pending_legal_review",
        ),
      ).toBe(true);
      expect(new Set(rows.map((x) => x.class))).toEqual(
        new Set([
          "delete",
          "retain_justified",
          "retain_pending_process",
          "anonymize_when_possible",
          "restricted_evidence",
        ]),
      );
      await fails(
        () =>
          db.exec(
            "update account_deletion_retention_catalog set basis_status='approved' where dataset='community_strikes'",
          ),
        /check/i,
      );
    });

    it("las listas cerradas que redefine la migración coinciden con el contrato vigente (no pierden valores que ya existen en DEV)", () => {
      // Regresión real: una versión previa redefinió el CHECK de eventos SIN los tipos de strike y falló en DEV por filas existentes.
      const list = (sql: string, name: string) =>
        [
          ...(
            sql
              .replace(/--.*$/gm, "")
              .match(new RegExp(`${name}[\\s\\S]*?\\(([\\s\\S]*?)\\)\\);`))?.[1] ?? ""
          ).matchAll(/'([a-z_]+)'/g),
        ].map((m) => m[1]);
      const kinds = list(DEL, "copyright_claim_events_kind_check\\s+check \\(kind in");
      const statuses = list(DEL, "copyright_claims_status_check check \\(status in");
      expect(new Set(kinds)).toEqual(new Set(CLAIM_EVENT_KINDS));
      expect(new Set(statuses)).toEqual(new Set(CLAIM_STATUSES));
      const back = DEL_ROLLBACK.replace(/--.*$/gm, "");
      for (const k of CLAIM_EVENT_KINDS.filter((k) => k !== "author_deleted"))
        expect(back, k).toContain(`'${k}'`);
    });

    it("la migración no contiene reactivación ni borrados directos de identidad, y los eventos no admiten secretos", async () => {
      const sql = DEL.replace(/--.*$/gm, "");
      expect(sql).not.toMatch(/delete\s+from\s+auth\./i);
      expect(sql).not.toMatch(/delete\s+from\s+public\.account_deletion_blocks/i);
      expect(sql).not.toMatch(/update\s+public\.account_deletion_blocks/i);
      expect(sql).not.toMatch(/'active'|reactivat|unblock|restore_account/i);
      expect(sql).not.toMatch(/grant\s+(all|select|insert|update|delete)\b/i);
      const { requestId } = await confirmed();
      await fails(
        () =>
          db.query(
            "insert into account_deletion_events(request_id,kind,actor_kind,metadata) values($1,'released','system','{\"token\":\"x\"}')",
            [requestId],
          ),
        /./,
      );
    });

    it("el rollback se rechaza con una eliminación en curso y, sin ellas, deja Copyright como antes", async () => {
      const { requestId } = await confirmed();
      await fails(
        () => db.exec(DEL_ROLLBACK),
        /rollback_refused_account_deletion_in_use/,
      );
      expect(requestId).toBeTruthy();
    });

    it("el rollback sin eliminaciones elimina los objetos nuevos y restaura las listas de Copyright", async () => {
      await db.exec(DEL2_ROLLBACK);
      await db.exec(DEL_ROLLBACK);
      expect(
        await one<number>(
          "select count(*)::int r from pg_proc where proname like 'account_deletion_%'",
        ),
      ).toBe(0);
      expect(
        await one<number>(
          "select count(*)::int r from pg_class where relname like 'account_deletion_%'",
        ),
      ).toBe(0);
      expect(
        await one<boolean>(
          "select exists(select 1 from pg_constraint where conname='copyright_claims_status_check' and pg_get_constraintdef(oid) like '%author_deleted%') r",
        ),
      ).toBe(false);
    });
  });
});
