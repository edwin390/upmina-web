// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// COPY-1 fase 2B: SQL REAL (PGlite) de 20261110120000 (retirada, apelación, restauración y eliminación manual) sobre 2A. Base: 2A
// COPY-1 fase 2A: SQL REAL (PGlite) de la migración PROPUESTA 20261107120000 (reclamaciones de copyright) sobre la cadena vigente,
// y de su rollback. No se aplica en ningún entorno remoto. Una reclamación NO oculta, retira ni toca nada del circuito ordinario.

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const migration = (n: string) => read(`supabase/migrations/${n}`);
const MIG = migration("20261107120000_copyright_claims.sql");
const REVOKE_MIG = migration("20261108120000_copyright_events_immutable_revoke.sql");
const REM = migration("20261110120000_copyright_removal_appeals.sql");
const REM_ROLLBACK = read(
  "supabase/rollbacks/20261110120000_copyright_removal_appeals.rollback.sql",
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
const ordinaryState = async () =>
  (
    await db.query<Obj>(
      `select (select count(*) from community_posts)::int posts,
              (select string_agg(id::text||status||version::text, ',' order by id) from community_posts) post_state,
              (select count(*) from community_post_reports)::int reports,
              (select count(*) from community_moderation_cases)::int cases,
              (select count(*) from community_moderation_decisions)::int decisions,
              (select count(*) from moderation_audit_log where target_type <> 'copyright_claim')::int audit`,
    )
  ).rows[0]!;

// ---------------------------------------------------------------------------------------------------------------------------------
// Fase 2B: retirada, apelación, restauración y eliminación manual. SQL REAL sobre la cadena vigente + 2A + 2B (nada remoto).
// ---------------------------------------------------------------------------------------------------------------------------------
const AUTHOR_EMAIL = "autor@example.com";
const OTHER_USER = uid(77);
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
const appealContext = (token: string, user = ACTOR) =>
  one<Obj>("select copyright_appeal_context($1,$2) r", [user, token]);
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
const detail = async (id: string) =>
  (await one<Obj>("select copyright_claims_read($1,'open',null,null,$2) r", [MOD, id]))
    .item as Obj;
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

describe("2B · retirada", () => {
  it("oculta la publicación SIN tocar sus archivos y deja el expediente en «removed» con aviso para el autor", async () => {
    await db.query("update auth.users set email=$1 where id=$2", [AUTHOR_EMAIL, ACTOR]);
    const { post, ids } = await postWithMedia();
    const claim = await inReview(post);
    const token = tok();
    const out = await removeClaim(claim.id, claim.reference, { token });
    expect(out).toMatchObject({ status: "removed", reference: claim.reference });
    expect(out.notice).toEqual({
      kind: "removal",
      authorEmail: AUTHOR_EMAIL,
      reason: REASON,
      windowMinutes: 60,
    });
    expect(await postRow(post)).toMatchObject({ status: "hidden", version: 3 });
    const assets = (
      await db.query<Obj>("select status from media_assets where id = any($1)", [ids])
    ).rows;
    expect(assets.every((a) => a.status === "ready")).toBe(true);
    expect(
      (await db.query("select 1 from community_post_media where post_id=$1", [post]))
        .rows,
    ).toHaveLength(2);
    expect(await claimRow(claim.id)).toMatchObject({
      status: "removed",
      removed_by: MOD,
      removed_post_version: 3,
      removal_window_minutes: 60,
      appeal_token_hash: token,
      notified_at: null,
      appeal_deadline: null,
    });
    const audit = (
      await db.query<Obj>(
        "select actor_kind, actor_user_id, metadata from moderation_audit_log where action='copyright_post_removed'",
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: "human", actor_user_id: MOD });
    const metadata = JSON.stringify(audit[0]!.metadata);
    expect(metadata).not.toContain(REASON);
    expect(metadata).not.toContain(token);
    expect(metadata).not.toContain(AUTHOR_EMAIL);
  });

  it("exige una reclamación en revisión, la confirmación vista, las versiones vigentes y una publicación publicada", async () => {
    const { post } = await postWithMedia();
    const made = await create({ postId: post });
    const id = await claimId(made.reference as string);
    const ref = made.reference as string;
    await fails(() => removeClaim(id, ref, { version: 1 }), /invalid_transition/);
    await review(id, "start_review", 1);
    await fails(
      () => removeClaim(id, ref, { confirm: "CPY-2026-999999" }),
      /confirmation_mismatch/,
    );
    await fails(() => removeClaim(id, ref, { confirm: null }), /confirmation_mismatch/);
    await fails(() => removeClaim(id, ref, { version: 1 }), /version_conflict/);
    await fails(() => removeClaim(id, ref, { postVersion: 1 }), /post_version_conflict/);
    await fails(() => removeClaim(id, ref, { reason: null }), /note_required/);
    await fails(() => removeClaim(id, ref, { reason: "corto" }), /invalid_argument/);
    await fails(
      () => removeClaim(id, ref, { token: "no-es-un-hash" }),
      /invalid_argument/,
    );
    await fails(() => removeClaim(id, ref, { token: null }), /invalid_argument/);
    await fails(() => removeClaim(id, ref, { window: 120 }), /invalid_argument/);
    await fails(() => removeClaim(id, ref, { window: 30 }), /invalid_argument/);
    await fails(
      () => removeClaim(id, ref, { actor: PENDING_USER }),
      /actor_not_moderator/,
    );
    expect((await claimRow(id)).status).toBe("in_review");
    expect(await postRow(post)).toMatchObject({ status: "published", version: 2 });
    await db.query("update community_posts set status='hidden' where id=$1", [post]);
    await fails(() => removeClaim(id, ref), /post_state_conflict/);
    await db.query("delete from community_posts where id=$1", [post]);
    await fails(() => removeClaim(id, ref), /post_not_found/);
  });

  it("una reclamación sin publicación localizada no se puede retirar", async () => {
    const claim = await inReview(null);
    await fails(() => removeClaim(claim.id, claim.reference), /post_not_found/);
  });

  it("acepta los dos plazos permitidos (60 y 1440 minutos) y los guarda", async () => {
    const a = await removedAndNotified(60);
    expect((await claimRow(a.id)).removal_window_minutes).toBe(60);
    const b = await removedAndNotified(1440);
    expect((await claimRow(b.id)).removal_window_minutes).toBe(1440);
  });

  it("NO toca otros posts, reportes, casos, decisiones ni el historial ordinario", async () => {
    const other = await newPost("otra publicación");
    const before = await ordinaryState();
    await removedAndNotified();
    const after = await ordinaryState();
    expect(after.reports).toBe(before.reports);
    expect(after.cases).toBe(before.cases);
    expect(after.decisions).toBe(before.decisions);
    expect(after.audit).toBe(before.audit);
    expect(await postRow(other)).toMatchObject({ status: "published", version: 2 });
  });
});

describe("2B · aviso al autor y plazo", () => {
  it("el plazo empieza al CONFIRMARSE el envío y es exactamente el elegido; un segundo registro no lo mueve", async () => {
    await db.query("update auth.users set email=$1 where id=$2", [AUTHOR_EMAIL, ACTOR]);
    const { post } = await postWithMedia();
    const claim = await inReview(post);
    await removeClaim(claim.id, claim.reference, { window: 60 });
    let row = await claimRow(claim.id);
    expect(row.notified_at).toBeNull();
    expect(row.appeal_deadline).toBeNull();
    const first = await record(claim.id, "removal", true);
    expect(first.alreadyNotified).toBe(false);
    row = await claimRow(claim.id);
    const minutes = (
      await db.query<{ m: number }>(
        "select extract(epoch from (appeal_deadline - notified_at))/60 m from copyright_claims where id=$1",
        [claim.id],
      )
    ).rows[0]!.m;
    expect(Number(minutes)).toBe(60);
    const deadline = row.appeal_deadline;
    const second = await record(claim.id, "removal", true);
    expect(second.alreadyNotified).toBe(true);
    expect((await claimRow(claim.id)).appeal_deadline).toEqual(deadline);
  });

  it("un fallo se registra (clase, intentos, historial y auditoría) y no inicia el plazo", async () => {
    const { post } = await postWithMedia();
    const claim = await inReview(post);
    await removeClaim(claim.id, claim.reference);
    await record(claim.id, "removal", false, "provider_unavailable");
    await record(claim.id, "removal", false, "timeout");
    const row = await claimRow(claim.id);
    expect(row).toMatchObject({
      notified_at: null,
      appeal_deadline: null,
      notify_attempts: 2,
      notify_last_error: "timeout",
    });
    const kinds = (
      await db.query<Obj>(
        "select kind, note from copyright_claim_events where claim_id=$1 and kind='notification_failed' order by created_at,id",
        [claim.id],
      )
    ).rows;
    expect(kinds.map((k) => k.note)).toEqual(["provider_unavailable", "timeout"]);
    expect(
      (
        await db.query<Obj>(
          "select metadata from moderation_audit_log where action='copyright_notification_failed' and target_id=$1",
          [claim.id],
        )
      ).rows,
    ).toHaveLength(2);
    // Tras el reintento correcto, el error desaparece y empieza el plazo.
    await record(claim.id, "removal", true);
    expect(await claimRow(claim.id)).toMatchObject({ notify_last_error: null });
    expect((await claimRow(claim.id)).appeal_deadline).not.toBeNull();
  });

  it("rechaza clases de error desconocidas, combinaciones incoherentes y actores sin rol", async () => {
    const { post } = await postWithMedia();
    const claim = await inReview(post);
    await removeClaim(claim.id, claim.reference);
    await fails(() => record(claim.id, "removal", false, "otro"), /invalid_argument/);
    await fails(() => record(claim.id, "removal", false, null), /invalid_argument/);
    await fails(() => record(claim.id, "removal", true, "timeout"), /invalid_argument/);
    await fails(() => record(claim.id, "otro", true), /invalid_argument/);
    await fails(
      () => record(claim.id, "removal", true, null, PENDING_USER),
      /actor_not_moderator/,
    );
  });

  it("el reintento del aviso inicial reemite el token (el anterior deja de valer) y solo mientras no se haya confirmado", async () => {
    await db.query("update auth.users set email=$1 where id=$2", [AUTHOR_EMAIL, ACTOR]);
    const { post } = await postWithMedia();
    const claim = await inReview(post);
    const first = tok();
    await removeClaim(claim.id, claim.reference, { token: first });
    const next = tok();
    const ctx = await one<Obj>(
      "select copyright_claim_notice_context($1,$2,'removal',$3) r",
      [MOD, claim.id, next],
    );
    expect(ctx.notice).toMatchObject({
      kind: "removal",
      authorEmail: AUTHOR_EMAIL,
      reason: REASON,
    });
    expect((await claimRow(claim.id)).appeal_token_hash).toBe(next);
    await record(claim.id, "removal", true);
    await fails(
      () =>
        one("select copyright_claim_notice_context($1,$2,'removal',$3) r", [
          MOD,
          claim.id,
          tok(),
        ]),
      /invalid_transition/,
    );
    await fails(
      () =>
        one("select copyright_claim_notice_context($1,$2,'removal',null) r", [
          MOD,
          claim.id,
        ]),
      /invalid_argument/,
    );
  });

  it("sin correo en la cuenta del autor el contexto devuelve authorEmail nulo (el backend lo registra como «no_recipient»)", async () => {
    const { post } = await postWithMedia();
    const claim = await inReview(post);
    const out = await removeClaim(claim.id, claim.reference);
    expect((out.notice as Obj).authorEmail).toBeNull();
    await record(claim.id, "removal", false, "no_recipient");
    expect((await claimRow(claim.id)).notify_last_error).toBe("no_recipient");
  });
});

describe("2B · apelación", () => {
  it("el autor con el token presenta una apelación en una operación atómica y queda bloqueada la eliminación", async () => {
    const r = await removedAndNotified();
    expect((await appealContext(r.token)).state).toBe("open");
    const out = await appeal(r.token);
    expect(out).toMatchObject({ reference: r.reference, state: "submitted" });
    const row = await claimRow(r.id);
    expect(row.status).toBe("appeal_pending");
    expect(row.version).toBe(r.version + 1);
    const stored = (
      await db.query<Obj>("select * from copyright_appeals where claim_id=$1", [r.id])
    ).rows[0]!;
    expect(stored).toMatchObject({
      author_user_id: ACTOR,
      contact_email: "autor@example.com",
      reason: "own_work",
      status: "pending",
      statement_accepted: true,
    });
    expect(
      (
        await db.query<Obj>(
          "select kind from copyright_claim_events where claim_id=$1 and kind='appeal_submitted'",
          [r.id],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query<Obj>(
          "select actor_user_id from moderation_audit_log where action='copyright_appeal_submitted' and target_id=$1",
          [r.id],
        )
      ).rows[0],
    ).toMatchObject({ actor_user_id: ACTOR });
    await expire(r.id);
    await fails(() => purge(r.id, r.reference, row.version as number), /purge_blocked/);
    expect((await appealContext(r.token)).state).toBe("submitted");
  });

  it("una segunda apelación, o una concurrente que llegue después, no duplica nada", async () => {
    const r = await removedAndNotified();
    await appeal(r.token);
    await fails(() => appeal(r.token), /appeal_already_submitted/);
    await fails(
      () =>
        db.query(
          "insert into copyright_appeals(claim_id,author_user_id,contact_name,contact_email,reason,explanation,evidence_text,statement_version,statement_accepted) values ($1,$2,'Autor Dos','a@example.com','other','explicación suficiente','texto','v1',true)",
          [r.id, ACTOR],
        ),
      /duplicate key|copyright_appeals_claim_id_key/,
    );
    expect(
      (await db.query("select 1 from copyright_appeals where claim_id=$1", [r.id])).rows,
    ).toHaveLength(1);
  });

  it("solo la cuenta autora original con el token vigente puede ver o presentar la apelación; los demás casos responden igual", async () => {
    const r = await removedAndNotified();
    await fails(() => appeal(r.token, {}, OTHER_USER), /appeal_not_available/);
    await fails(() => appealContext(r.token, OTHER_USER), /appeal_not_available/);
    await fails(() => appeal(tok()), /appeal_not_available/);
    await fails(() => appealContext(tok()), /appeal_not_available/);
    await fails(() => appeal("no-es-un-hash"), /appeal_not_available/);
    expect((await claimRow(r.id)).status).toBe("removed");
  });

  it("fuera de plazo, o antes de confirmarse el aviso, no se admite; vencer NO cambia nada por sí solo", async () => {
    const r = await removedAndNotified();
    await expire(r.id);
    expect((await appealContext(r.token)).state).toBe("expired");
    await fails(() => appeal(r.token), /appeal_window_closed/);
    const row = await claimRow(r.id);
    expect(row.status).toBe("removed");
    expect(await postRow(r.post)).toMatchObject({ status: "hidden" });
    const { post } = await postWithMedia();
    const claim = await inReview(post);
    const token = tok();
    await removeClaim(claim.id, claim.reference, { token });
    await fails(() => appeal(token), /appeal_not_available/);
  });

  it("valida el contenido: solo texto y enlaces, claves exactas, declaración obligatoria, razón válida", async () => {
    const r = await removedAndNotified();
    const bad: Obj[] = [
      { extra: 1 },
      { contactName: "x" },
      { contactEmail: "no-es-correo" },
      { reason: "otra" },
      { explanation: "corta" },
      { evidenceText: null, evidenceUrls: [] },
      { evidenceUrls: ["ftp://example.com/x"] },
      { evidenceUrls: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`) },
      { evidenceUrls: [5] },
      { statementAccepted: false },
      { statementVersion: "V 1!" },
      { contactName: "Nombre\u0007" },
    ];
    for (const over of bad) await fails(() => appeal(r.token, over), /invalid_input/);
    await fails(
      () =>
        one("select copyright_appeal_submit($1,$2,$3::jsonb) r", [
          ACTOR,
          r.token,
          JSON.stringify({ ...appealInput(), file: "x" }),
        ]),
      /invalid_input/,
    );
    expect((await claimRow(r.id)).status).toBe("removed");
    // Texto sin enlaces, o enlaces sin texto, son válidos.
    await appeal(r.token, { evidenceUrls: [] });
  });
});

describe("2B · resolución de la apelación", () => {
  async function appealed() {
    const r = await removedAndNotified();
    await appeal(r.token);
    return { ...r, version: (await claimRow(r.id)).version as number };
  }

  it("aceptar restaura la publicación, cierra el caso, audita y deja el aviso pendiente de envío", async () => {
    const r = await appealed();
    const out = await resolve(r.id, "accept", r.version);
    expect(out).toMatchObject({ status: "restored" });
    expect(out.notice).toMatchObject({
      kind: "appeal_accepted",
      authorEmail: AUTHOR_EMAIL,
      resolutionNote: "Decisión motivada de la moderación",
    });
    expect(await postRow(r.post)).toMatchObject({ status: "published", version: 4 });
    const row = await claimRow(r.id);
    expect(row).toMatchObject({ status: "restored", resolution_notice_pending: true });
    expect(row.restored_at).not.toBeNull();
    expect(
      (
        await db.query<Obj>(
          "select status, resolved_by from copyright_appeals where claim_id=$1",
          [r.id],
        )
      ).rows[0],
    ).toMatchObject({ status: "accepted", resolved_by: MOD });
    const actions = (
      await db.query<{ action: string }>(
        "select action from moderation_audit_log where target_id=$1 and action in ('copyright_appeal_accepted','copyright_post_restored')",
        [r.id],
      )
    ).rows.map((x) => x.action);
    expect(actions.sort()).toEqual([
      "copyright_appeal_accepted",
      "copyright_post_restored",
    ]);
    // Pasa al historial (cerradas) y ya no admite eliminación ni nuevas acciones de revisión.
    const closed = await one<Obj>(
      "select copyright_claims_read($1,'closed',null,null,null) r",
      [MOD],
    );
    expect((closed.items as Obj[]).map((i) => i.id)).toContain(r.id);
    await fails(() => purge(r.id, r.reference, row.version as number), /purge_blocked/);
    await fails(
      () => review(r.id, "add_note", row.version as number, "nota"),
      /invalid_transition/,
    );
    await record(r.id, "appeal_accepted", true);
    expect((await claimRow(r.id)).resolution_notice_pending).toBe(false);
  });

  it("aceptar con la publicación cambiada desde la retirada se rechaza (restore_unsafe) y no cambia nada", async () => {
    const r = await appealed();
    await db.query("update community_posts set version = version + 1 where id=$1", [
      r.post,
    ]);
    await fails(() => resolve(r.id, "accept", r.version), /restore_unsafe/);
    expect((await claimRow(r.id)).status).toBe("appeal_pending");
    expect(await postRow(r.post)).toMatchObject({ status: "hidden" });
    await db.query("delete from community_posts where id=$1", [r.post]);
    await fails(() => resolve(r.id, "accept", r.version), /restore_unsafe/);
    expect((await claimRow(r.id)).status).toBe("appeal_pending");
  });

  it("rechazar mantiene la publicación oculta, el caso ACTIVO y deja el aviso pendiente; no se puede apelar de nuevo", async () => {
    const r = await appealed();
    const out = await resolve(r.id, "reject", r.version);
    expect(out).toMatchObject({ status: "removed" });
    expect(out.notice).toMatchObject({ kind: "appeal_rejected" });
    expect(await postRow(r.post)).toMatchObject({ status: "hidden", version: 3 });
    const row = await claimRow(r.id);
    expect(row).toMatchObject({
      status: "removed",
      resolution_notice_pending: true,
      restored_at: null,
    });
    const open = await one<Obj>(
      "select copyright_claims_read($1,'open',null,null,null) r",
      [MOD],
    );
    expect((open.items as Obj[]).map((i) => i.id)).toContain(r.id);
    await fails(() => appeal(r.token), /appeal_already_submitted/);
    // Hasta que se envíe el aviso de resolución, la eliminación sigue bloqueada.
    await expire(r.id);
    await fails(() => purge(r.id, r.reference, row.version as number), /purge_blocked/);
    await record(r.id, "appeal_rejected", false, "timeout");
    expect((await claimRow(r.id)).resolution_notice_pending).toBe(true);
    await record(r.id, "appeal_rejected", true);
    const after = await claimRow(r.id);
    expect(after.resolution_notice_pending).toBe(false);
    // El reintento del aviso de resolución no repite la acción.
    const ctx = await one<Obj>(
      "select copyright_claim_notice_context($1,$2,'appeal_rejected',null) r",
      [MOD, r.id],
    ).catch((e: Error) => e.message);
    expect(String(ctx)).toMatch(/invalid_transition/);
  });

  it("exige justificación, versión vigente, estado «appeal_pending» y un moderador; no hay doble resolución", async () => {
    const r = await appealed();
    await fails(() => resolve(r.id, "accept", r.version, null), /note_required/);
    await fails(() => resolve(r.id, "accept", r.version, "   "), /note_required/);
    await fails(() => resolve(r.id, "accept", r.version - 1), /version_conflict/);
    await fails(() => resolve(r.id, "otra", r.version), /invalid_argument/);
    await fails(
      () => resolve(r.id, "accept", r.version, "nota", PENDING_USER),
      /actor_not_moderator/,
    );
    const done = await resolve(r.id, "reject", r.version);
    await fails(
      () => resolve(r.id, "accept", done.version as number),
      /invalid_transition/,
    );
    const plain = await removedAndNotified();
    await fails(() => resolve(plain.id, "reject", plain.version), /invalid_transition/);
  });
});

describe("2B · eliminación definitiva manual", () => {
  it("se bloquea mientras el aviso inicial no se haya enviado, el plazo siga abierto, haya apelación o aviso pendiente", async () => {
    await db.query("update auth.users set email=$1 where id=$2", [AUTHOR_EMAIL, ACTOR]);
    const { post } = await postWithMedia();
    const claim = await inReview(post);
    await removeClaim(claim.id, claim.reference);
    let row = await claimRow(claim.id);
    const blockers = async () => (await detail(claim.id)).removal as Obj;
    expect((await blockers()).purgeBlockers).toEqual(["notification_pending"]);
    await fails(
      () => purge(claim.id, claim.reference, row.version as number),
      /purge_blocked/,
    );
    await record(claim.id, "removal", true);
    row = await claimRow(claim.id);
    expect((await blockers()).purgeBlockers).toEqual(["window_open"]);
    await fails(
      () => purge(claim.id, claim.reference, row.version as number),
      /purge_blocked/,
    );
    await expire(claim.id);
    expect((await blockers()).purgeBlockers).toEqual([]);
    expect(await postRow(post)).toMatchObject({ status: "hidden" });
  });

  it("vencer el plazo NO elimina nada: la publicación y sus archivos siguen intactos hasta la acción humana", async () => {
    const r = await removedAndNotified();
    await expire(r.id);
    expect(await postRow(r.post)).toMatchObject({ status: "hidden" });
    const statuses = (
      await db.query<Obj>("select status from media_assets where id = any($1)", [r.ids])
    ).rows;
    expect(statuses.every((s) => s.status === "ready")).toBe(true);
    expect((await claimRow(r.id)).status).toBe("removed");
  });

  it("con todas las condiciones y la confirmación, elimina la publicación y marca solo los archivos exclusivos para el GC", async () => {
    const r = await removedAndNotified();
    await expire(r.id);
    // Un archivo de otro dominio y uno aún no listo se conservan.
    await db.query("update media_assets set domain='cosplay' where id=$1", [r.ids[0]]);
    const row = await claimRow(r.id);
    const out = await purge(r.id, r.reference, row.version as number);
    expect(out).toMatchObject({
      status: "purged",
      postDeleted: true,
      assetsMarked: 1,
      assetsRetained: 1,
    });
    expect(await postRow(r.post)).toBeUndefined();
    const assets = Object.fromEntries(
      (
        await db.query<Obj>("select id, status from media_assets where id = any($1)", [
          r.ids,
        ])
      ).rows.map((a) => [a.id as string, a.status]),
    );
    expect(assets[r.ids[0]!]).toBe("ready");
    expect(assets[r.ids[1]!]).toBe("deleting");
    const after = await claimRow(r.id);
    expect(after).toMatchObject({ status: "purged", purge_asset_ids: [r.ids[1]] });
    expect(after.purged_at).not.toBeNull();
    const audit = (
      await db.query<Obj>(
        "select actor_kind, actor_user_id, metadata from moderation_audit_log where action='copyright_post_purged'",
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: "human", actor_user_id: MOD });
    expect(audit[0]!.metadata).toMatchObject({ assets_marked: 1, assets_retained: 1 });
    // Pasa al historial; el detalle indica cuántos archivos siguen pendientes del GC de R2.
    const closed = await one<Obj>(
      "select copyright_claims_read($1,'closed',null,null,null) r",
      [MOD],
    );
    expect((closed.items as Obj[]).map((i) => i.id)).toContain(r.id);
    const d = (
      await one<Obj>("select copyright_claims_read($1,'open',null,null,$2) r", [
        MOD,
        r.id,
      ])
    ).item as Obj;
    expect((d.removal as Obj).purgeAssetsPending).toBe(1);
    await db.query("delete from media_assets where id=$1", [r.ids[1]]);
    const d2 = (
      await one<Obj>("select copyright_claims_read($1,'open',null,null,$2) r", [
        MOD,
        r.id,
      ])
    ).item as Obj;
    expect((d2.removal as Obj).purgeAssetsPending).toBe(0);
    await fails(() => purge(r.id, r.reference, after.version as number), /purge_blocked/);
  });

  it("un archivo usado también por otra superficie (Cosplay) NO se marca para borrado", async () => {
    const r = await removedAndNotified();
    await expire(r.id);
    await db.query("insert into cosplay_post_images(asset_id) values ($1)", [r.ids[0]]);
    const out = await purge(r.id, r.reference, (await claimRow(r.id)).version as number);
    expect(out).toMatchObject({ assetsMarked: 1, assetsRetained: 1 });
    const status = Object.fromEntries(
      (
        await db.query<Obj>("select id, status from media_assets where id = any($1)", [
          r.ids,
        ])
      ).rows.map((a) => [a.id as string, a.status]),
    );
    expect(status[r.ids[0]!]).toBe("ready");
    expect(status[r.ids[1]!]).toBe("deleting");
  });

  it("repite en el servidor la confirmación, la versión, el estado de la publicación y el rol", async () => {
    const r = await removedAndNotified();
    await expire(r.id);
    const row = await claimRow(r.id);
    const v = row.version as number;
    await fails(
      () => purge(r.id, r.reference, v, { confirm: null }),
      /confirmation_mismatch/,
    );
    await fails(
      () => purge(r.id, r.reference, v, { confirm: "CPY-2026-999999" }),
      /confirmation_mismatch/,
    );
    await fails(() => purge(r.id, r.reference, v - 1), /version_conflict/);
    await fails(() => purge(r.id, r.reference, v, { note: null }), /note_required/);
    await fails(
      () => purge(r.id, r.reference, v, { actor: PENDING_USER }),
      /actor_not_moderator/,
    );
    await db.query("update community_posts set status='published' where id=$1", [r.post]);
    await fails(() => purge(r.id, r.reference, v), /post_state_conflict/);
    expect((await claimRow(r.id)).status).toBe("removed");
    expect(await postRow(r.post)).toBeDefined();
  });

  it("si el autor ya borró la publicación, la eliminación cierra el caso sin marcar archivos", async () => {
    const r = await removedAndNotified();
    await expire(r.id);
    await db.query("delete from community_posts where id=$1", [r.post]);
    const out = await purge(r.id, r.reference, (await claimRow(r.id)).version as number);
    expect(out).toMatchObject({ status: "purged", postDeleted: false, assetsMarked: 0 });
  });

  it("solo se puede eliminar lo que la retirada ocultó: otra publicación no se toca", async () => {
    const r = await removedAndNotified();
    const other = await postWithMedia("otra publicación", 1);
    await expire(r.id);
    await purge(r.id, r.reference, (await claimRow(r.id)).version as number);
    expect(await postRow(other.post)).toMatchObject({ status: "published" });
    expect(
      (await db.query<Obj>("select status from media_assets where id=$1", [other.ids[0]]))
        .rows[0],
    ).toMatchObject({ status: "ready" });
  });
});

describe("2B · lectura, revisión 2A y aislamiento", () => {
  it("el detalle ofrece la publicación actual, la retirada, la apelación y las condiciones de eliminación", async () => {
    const r = await removedAndNotified();
    await appeal(r.token);
    const d = await detail(r.id);
    expect(d.currentPost).toMatchObject({ status: "hidden", version: 3, mediaCount: 2 });
    expect(d.removal).toMatchObject({
      reason: REASON,
      windowMinutes: 60,
      resolutionNoticePending: false,
      purgeBlockers: ["appeal_pending", "window_open"],
    });
    await expire(r.id);
    expect(((await detail(r.id)).removal as Obj).purgeBlockers).toEqual([
      "appeal_pending",
    ]);
    expect(d.appeal).toMatchObject({
      status: "pending",
      reason: "own_work",
      contactName: "Autor Original",
    });
    expect(d.appeal).not.toHaveProperty("author_user_id");
    const text = JSON.stringify(d);
    expect(text).not.toContain(r.token);
    expect(text).not.toContain("appeal_token");
  });

  it("las colas separan activos (incluidos retirada y apelación pendientes) e historial (restaurada y eliminada)", async () => {
    const a = await removedAndNotified();
    const b = await removedAndNotified();
    await appeal(b.token);
    const open = (
      (await one<Obj>("select copyright_claims_read($1,'open',null,null,null) r", [MOD]))
        .items as Obj[]
    ).map((i) => i.status);
    expect(open).toEqual(expect.arrayContaining(["removed", "appeal_pending"]));
    await expire(a.id);
    await purge(a.id, a.reference, (await claimRow(a.id)).version as number);
    const closed = (
      (
        await one<Obj>("select copyright_claims_read($1,'closed',null,null,null) r", [
          MOD,
        ])
      ).items as Obj[]
    ).map((i) => i.id);
    expect(closed).toContain(a.id);
    expect(closed).not.toContain(b.id);
  });

  it("la revisión 2A no puede descartar ni retirar una reclamación ya retirada, solo anotarla; las cerradas son inmutables", async () => {
    const r = await removedAndNotified();
    const v = (await claimRow(r.id)).version as number;
    await fails(() => review(r.id, "dismiss", v, "nota"), /invalid_transition/);
    await fails(() => review(r.id, "withdraw", v, "nota"), /invalid_transition/);
    await fails(() => review(r.id, "start_review", v), /invalid_transition/);
    const noted = await review(r.id, "add_note", v, "Seguimiento interno");
    expect(noted.status).toBe("removed");
    await expire(r.id);
    const out = await purge(r.id, r.reference, noted.version as number);
    await fails(
      () => review(r.id, "add_note", out.version as number, "x"),
      /invalid_transition/,
    );
  });

  it("el historial de eventos sigue siendo inmutable y los nuevos eventos no se pueden alterar", async () => {
    const r = await removedAndNotified();
    await fails(
      () =>
        db.query("update copyright_claim_events set note='x' where claim_id=$1", [r.id]),
      /copyright_claim_events_immutable/,
    );
    await fails(
      () => db.query("delete from copyright_claim_events where claim_id=$1", [r.id]),
      /copyright_claim_events_immutable/,
    );
  });

  it("el sistema sigue sin poder escribir acciones de copyright y las acciones desconocidas siguen cerradas", async () => {
    for (const action of [
      "copyright_post_removed",
      "copyright_post_purged",
      "accion_inventada",
    ])
      await fails(
        () =>
          db.query(
            "insert into moderation_audit_log(actor_kind,actor_user_id,target_type,target_id,action) values('system',null,'copyright_claim',$1,$2)",
            [uid(1), action],
          ),
        /violates check|moderation_audit_log_/,
      );
  });
});

describe("2B · permisos y exposición", () => {
  const SIGS = [
    "public.copyright_claim_remove(uuid,uuid,integer,integer,text,text,text,integer)",
    "public.copyright_claim_notice_context(uuid,uuid,text,text)",
    "public.copyright_claim_notice_record(uuid,uuid,text,boolean,text)",
    "public.copyright_appeal_context(uuid,text)",
    "public.copyright_appeal_submit(uuid,text,jsonb)",
    "public.copyright_appeal_resolve(uuid,uuid,integer,text,text)",
    "public.copyright_claim_purge(uuid,uuid,integer,text,text)",
  ];
  it("solo service_role ejecuta las RPC nuevas; anon, authenticated y public no", async () => {
    for (const sig of SIGS) {
      const rows = (
        await db.query<{ r: string; ok: boolean }>(
          `select r, has_function_privilege(r, '${sig}', 'execute') ok from unnest(array['public','anon','authenticated','service_role']) r`,
        )
      ).rows;
      expect(Object.fromEntries(rows.map((x) => [x.r, x.ok]))).toEqual({
        public: false,
        anon: false,
        authenticated: false,
        service_role: true,
      });
    }
  });

  it("el ayudante de condiciones no es ejecutable por ningún rol de API y las funciones son SECURITY DEFINER con search_path fijo", async () => {
    const rows = (
      await db.query<{ r: string; ok: boolean }>(
        `select r, has_function_privilege(r, 'public.copyright_purge_blockers(public.copyright_claims,timestamptz)', 'execute') ok from unnest(array['public','anon','authenticated','service_role']) r`,
      )
    ).rows;
    expect(rows.every((x) => !x.ok)).toBe(true);
    const meta = (
      await db.query<{ proname: string; definer: boolean; cfg: string[]; owner: string }>(
        `select proname, prosecdef definer, proconfig cfg, pg_get_userbyid(proowner) owner from pg_proc
          where proname in ('copyright_claim_remove','copyright_claim_notice_context','copyright_claim_notice_record',
            'copyright_appeal_context','copyright_appeal_submit','copyright_appeal_resolve','copyright_claim_purge')`,
      )
    ).rows;
    expect(meta).toHaveLength(7);
    for (const m of meta) {
      expect(m.definer).toBe(true);
      expect(m.cfg.join()).toContain("search_path=pg_catalog, public");
      expect(m.owner).toBe("postgres");
    }
  });

  it("la tabla de apelaciones es privada: RLS forzada, sin policies y sin permisos para los roles de API", async () => {
    const t = (
      await db.query<Obj>(
        "select relrowsecurity, relforcerowsecurity from pg_class where relname='copyright_appeals'",
      )
    ).rows[0]!;
    expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect(
      (await db.query("select 1 from pg_policies where tablename='copyright_appeals'"))
        .rows,
    ).toHaveLength(0);
    for (const role of ["anon", "authenticated", "service_role"])
      for (const priv of ["select", "insert", "update", "delete"])
        expect(
          (
            await db.query<{ ok: boolean }>(
              `select has_table_privilege('${role}', 'public.copyright_appeals', '${priv}') ok`,
            )
          ).rows[0]!.ok,
        ).toBe(false);
  });

  it("anon y authenticated no pueden llamar a ninguna RPC nueva", async () => {
    const { post } = await postWithMedia();
    const claim = await inReview(post);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set local role ${role}`);
      await fails(
        () => db.query("select copyright_claim_purge($1,$2,1,'x','x')", [MOD, claim.id]),
        /permission denied/,
      );
      await fails(
        () =>
          db.query("select copyright_appeal_submit($1,$2,'{}'::jsonb)", [ACTOR, tok()]),
        /permission denied/,
      );
      await db.exec("reset role");
    }
  });
});

describe("2B · rollback", () => {
  it("se niega si existe cualquier retirada, apelación o historial de la fase 2B", async () => {
    await removedAndNotified();
    await fails(() => db.exec(REM_ROLLBACK), /rollback_blocked_removal_data_exists/);
  });

  it("sin datos de 2B elimina solo lo añadido y devuelve las restricciones y funciones de 2A", async () => {
    await db.exec(REM_ROLLBACK);
    for (const name of [
      "copyright_claim_remove",
      "copyright_claim_purge",
      "copyright_appeal_submit",
      "copyright_appeal_resolve",
      "copyright_appeal_context",
      "copyright_claim_notice_record",
      "copyright_claim_notice_context",
      "copyright_purge_blockers",
    ])
      expect(
        (await db.query("select 1 from pg_proc where proname=$1", [name])).rows,
      ).toHaveLength(0);
    expect(
      (await db.query("select 1 from pg_class where relname='copyright_appeals'")).rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query(
          "select 1 from information_schema.columns where table_name='copyright_claims' and column_name in ('removed_at','appeal_token_hash')",
        )
      ).rows,
    ).toHaveLength(0);
    const made = await create();
    const id = await claimId(made.reference as string);
    expect((await review(id, "start_review", 1)).status).toBe("in_review");
    await fails(
      () => db.query("update copyright_claims set status='removed' where id=$1", [id]),
      /violates check|copyright_claims_status_check/,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Protección: una retirada o apelación de copyright ACTIVA impide cualquier eliminación ordinaria de la publicación y de sus archivos.
describe("2B · protección frente a la eliminación ordinaria", () => {
  const reporters = [31, 32, 33].map((n) => uid(8000 + n));
  async function ordinaryReports(postId: string, count: number) {
    let ctx!: Obj;
    for (const [i, id] of reporters.slice(0, count).entries()) {
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
        postId,
      ]);
    }
    return ctx;
  }
  /** Decisión ordinaria «content_actioned» tal como la envía la interfaz tras recargar el caso (con la versión VIGENTE de la publicación). */
  const decide = async (ctx: Obj, post: string) =>
    db.query(
      "select community_moderation_case_decide($1,$2,$3,$4,$5,'content_actioned',$6)",
      [
        MOD,
        ctx.caseId,
        ctx.cycleId,
        ctx.caseVersion,
        (await postRow(post))!.version,
        "Mensaje de la moderación",
      ],
    );
  const status = async (post: string) => (await postRow(post))?.status;
  /** Publicación con un caso ordinario pendiente (2 reportes) que DESPUÉS se retira por copyright y se notifica. */
  async function removedWithOrdinaryCase() {
    await db.query("update auth.users set email=$1 where id=$2", [AUTHOR_EMAIL, ACTOR]);
    const { post, ids } = await postWithMedia();
    const claim = await inReview(post);
    const ctx = await ordinaryReports(post, 2);
    const token = tok();
    await removeClaim(claim.id, claim.reference, {
      token,
      postVersion: (await postRow(post))!.version as number,
    });
    await record(claim.id, "removal", true);
    return { ...claim, post, ids, token, ctx };
  }
  const assetStatuses = async (ids: string[]) =>
    (
      await db.query<Obj>("select status from media_assets where id = any($1)", [ids])
    ).rows.map((a) => a.status);
  const sweep = async () =>
    (await one<Obj>("select community_purge_due_posts(10) r")).purged as number;

  it("publicación SIN copyright: la eliminación ordinaria funciona igual (decisión y borrado propio)", async () => {
    const { post } = await postWithMedia("sin copyright", 1);
    const ctx = await ordinaryReports(post, 2);
    await decide(ctx, post);
    expect(await postRow(post)).toMatchObject({ status: "removed_pending_purge" });
    expect((await postRow(post))!.purge_after).not.toBeNull();
    const other = await postWithMedia("borrado propio", 2);
    const out = await one<Obj>("select community_post_delete($1,$2,2) r", [
      ACTOR,
      other.post,
    ]);
    expect(out.deleted_asset_ids as string[]).toHaveLength(2);
    expect(await postRow(other.post)).toBeUndefined();
    expect(await assetStatuses(other.ids)).toEqual(["deleting", "deleting"]);
    expect(await sweep()).toBe(0); // nada vencido todavía
  });

  it("publicación RETIRADA por copyright: la decisión ordinaria content_actioned queda bloqueada y no cambia nada", async () => {
    const { post, ids } = await postWithMedia();
    const claim = await inReview(post);
    const ctx = await ordinaryReports(post, 2); // caso ordinario pendiente ANTES de la retirada
    await removeClaim(claim.id, claim.reference, {
      postVersion: (await postRow(post))!.version as number,
    });
    expect(await status(post)).toBe("hidden");
    await fails(() => decide(ctx, post), /post_copyright_protected/);
    expect(await postRow(post)).toMatchObject({
      status: "hidden",
      removal_decision_id: null,
      purge_after: null,
    });
    expect(await assetStatuses(ids)).toEqual(["ready", "ready"]);
    expect(await sweep()).toBe(0);
  });

  it("apelación PENDIENTE: publicación y archivos siguen protegidos frente a decisión, borrado propio y purga", async () => {
    const r = await removedWithOrdinaryCase();
    await appeal(r.token);
    await expire(r.id);
    await fails(() => decide(r.ctx, r.post), /post_copyright_protected/);
    await fails(
      () => one("select community_post_delete($1,$2,3) r", [ACTOR, r.post]),
      /post_copyright_protected/,
    );
    expect(await postRow(r.post)).toMatchObject({ status: "hidden" });
    expect(await assetStatuses(r.ids)).toEqual(["ready", "ready"]);
    expect(await sweep()).toBe(0);
    expect(await postRow(r.post)).toBeDefined();
  });

  it("una purga ordinaria YA programada y vencida no puede saltarse la protección, y el lote sigue purgando las demás", async () => {
    // Orden inverso al normal, para fijar la garantía: la purga ya estaba programada y la protección aparece después.
    const early = await postWithMedia("programada antes", 1);
    const claim = await inReview(early.post);
    const plain = await postWithMedia("ordinaria vencida", 1);
    await decide(await ordinaryReports(early.post, 2), early.post);
    await decide(await ordinaryReports(plain.post, 2), plain.post);
    await db.query(
      `update copyright_claims set status='removed', removal_reason=$2, removed_at=now(), removed_by=$3,
         removed_post_version=1, removal_window_minutes=60 where id=$1`,
      [claim.id, REASON, MOD],
    );
    await db.exec("set constraints all immediate");
    await db.exec(
      "alter table community_posts drop constraint community_posts_removal_fields_check",
    );
    await db.query(
      "update community_posts set purge_after = now() - interval '1 hour' where id = any($1)",
      [[early.post, plain.post]],
    );
    expect(await sweep()).toBe(1);
    expect(await postRow(plain.post)).toBeUndefined();
    expect(await postRow(early.post)).toBeDefined();
    expect(await assetStatuses(early.ids)).toEqual(["ready"]);
    expect(await assetStatuses(plain.ids)).toEqual(["deleting"]);
  });

  it("la eliminación autorizada por copyright sigue funcionando y marca los archivos exclusivos", async () => {
    const r = await removedAndNotified();
    await expire(r.id);
    const out = await purge(r.id, r.reference, (await claimRow(r.id)).version as number);
    expect(out).toMatchObject({
      status: "purged",
      postDeleted: true,
      assetsMarked: 2,
      assetsRetained: 0,
    });
    expect(await postRow(r.post)).toBeUndefined();
    expect(await assetStatuses(r.ids)).toEqual(["deleting", "deleting"]);
    expect(((await claimRow(r.id)).purge_asset_ids as string[]).slice().sort()).toEqual(
      r.ids.slice().sort(),
    );
  });

  it("archivos compartidos con otra superficie no se eliminan ni siquiera con la eliminación de copyright", async () => {
    const r = await removedAndNotified();
    await expire(r.id);
    await db.query("insert into cosplay_post_images(asset_id) values ($1)", [r.ids[0]]);
    const out = await purge(r.id, r.reference, (await claimRow(r.id)).version as number);
    expect(out).toMatchObject({ assetsMarked: 1, assetsRetained: 1 });
    expect((await assetStatuses(r.ids)).sort()).toEqual(["deleting", "ready"]);
  });

  it("al terminar la protección no queda ninguna eliminación diferida: la decisión ordinaria vieja no se reactiva sola", async () => {
    const r = await removedWithOrdinaryCase();
    const ctx = r.ctx;
    await appeal(r.token);
    await fails(() => decide(ctx, r.post), /post_copyright_protected/);
    await resolve(r.id, "accept", (await claimRow(r.id)).version as number);
    expect(await postRow(r.post)).toMatchObject({
      status: "published",
      removal_decision_id: null,
      removed_at: null,
      purge_after: null,
    });
    expect(await sweep()).toBe(0);
    // La decisión vieja, con la versión de la publicación que tenía al abrirla, ya no es válida: hay que revisar el caso de nuevo.
    await fails(
      () =>
        db.query(
          "select community_moderation_case_decide($1,$2,$3,$4,$5,'content_actioned',$6)",
          [MOD, ctx.caseId, ctx.cycleId, ctx.caseVersion, ctx.postVersion, "Mensaje"],
        ),
      /post_version_conflict/,
    );
    expect(await status(r.post)).toBe("published");
  });

  it("una publicación ya eliminada por el circuito ordinario no puede acogerse a la retirada de copyright", async () => {
    const { post } = await postWithMedia("ya en purga", 1);
    const claim = await inReview(post);
    const ctx = await ordinaryReports(post, 2);
    await decide(ctx, post);
    const current = (await postRow(post))!.version as number;
    await fails(
      () => removeClaim(claim.id, claim.reference, { postVersion: current }),
      /post_state_conflict/,
    );
  });

  it("la protección solo cubre retirada y apelación activas: en revisión, restaurada o eliminada no protegen", async () => {
    const { post } = await postWithMedia("en revisión", 1);
    const claim = await inReview(post);
    const guarded = (id: string) =>
      one<boolean>("select copyright_post_protected($1) r", [id]);
    expect(await guarded(post)).toBe(false);
    await removeClaim(claim.id, claim.reference);
    expect(await guarded(post)).toBe(true);
    const r = await removedAndNotified();
    await appeal(r.token);
    expect(await guarded(r.post)).toBe(true);
    await resolve(r.id, "accept", (await claimRow(r.id)).version as number);
    expect(await guarded(r.post)).toBe(false);
  });

  it("funciones y disparador de protección: privados, SECURITY DEFINER y con search_path fijo", async () => {
    const rows = (
      await db.query<{ ok: boolean }>(
        `select has_function_privilege(r, f, 'execute') ok
           from unnest(array['public','anon','authenticated','service_role']) r,
                unnest(array['public.copyright_post_protected(uuid)','public.copyright_protect_post_guard()']) f`,
      )
    ).rows;
    expect(rows.every((x) => !x.ok)).toBe(true);
    const meta = (
      await db.query<{ definer: boolean; cfg: string[]; owner: string }>(
        `select prosecdef definer, proconfig cfg, pg_get_userbyid(proowner) owner from pg_proc
          where proname in ('copyright_post_protected','copyright_protect_post_guard')`,
      )
    ).rows;
    expect(meta).toHaveLength(2);
    for (const m of meta) {
      expect(m.definer).toBe(true);
      expect(m.cfg.join()).toContain("search_path=pg_catalog, public");
      expect(m.owner).toBe("postgres");
    }
  });
});
