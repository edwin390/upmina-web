// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "./community-atomic-save-test-db";

// MFA fase 2 — SQL REAL (PGlite) de la migración 20261031150000 sobre la cadena real de admin y la
// migración de la fase 1. auth.* son solo la FORMA mínima que usa la migración. Prueba la lógica de
// base de datos; NO prueba Supabase Auth, GoTrue ni Resend.

const MIGRATION = "20261031150000_admin_mfa_recovery.sql";
const ROLLBACK = "supabase/rollbacks/20261031150000_admin_mfa_recovery.rollback.sql";
const CHAIN = [
  "20260922120000_admin_roles.sql",
  "20260923120000_admin_invitations.sql",
  "20260926120000_admin_team_roles_invariants.sql",
  "20260927120000_admin_team_invitation_revoke.sql",
  "20260928120000_admin_team_member_management.sql",
  "20261031140000_admin_mfa_reset.sql",
  MIGRATION,
];
const read = (name: string) => readFileSync(resolve("supabase/migrations", name), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const id = (n: number, tag = "a") =>
  `${tag.repeat(8)}-${tag.repeat(4)}-4${tag.repeat(3)}-8${tag.repeat(3)}-${String(n).padStart(12, "0")}`;
const ADMIN = id(1);
const ADMIN2 = id(2);
const MOD = id(3);
const DEVELOPER = id(4);
const NOBODY = id(5);
const UNCONFIRMED = id(6);
const OLD_F = id(101, "f");
const OLD_F2 = id(102, "f");
const NEW_F = id(103, "f");
const SESSION = id(201, "5");
const T1 = sha("token-1");
const T2 = sha("token-2");
const BAD = sha("token-bad");

let db: TestDatabase;

beforeAll(async () => {
  const modulePath = process.env.UPMINA_TEST_PGLITE_MODULE;
  if (!modulePath) throw new Error("Set UPMINA_TEST_PGLITE_MODULE");
  const { PGlite } = await import(/* @vite-ignore */ modulePath);
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz default now());
    create table auth.mfa_factors(id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
      factor_type text not null default 'totp', status text not null default 'verified',
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table auth.sessions(id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
      factor_id uuid, aal text);
    create table public.profiles(user_id uuid primary key references auth.users(id), username text, display_name text);
  `);
  for (const name of CHAIN) await db.exec(read(name));
}, 90000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("begin");
  for (const [n, email] of [
    [ADMIN, "admin@example.test"],
    [ADMIN2, "admin2@example.test"],
    [MOD, "mod@example.test"],
    [DEVELOPER, "dev@example.test"],
    [NOBODY, "nobody@example.test"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [n, email]);
  }
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,$2,null)",
    [UNCONFIRMED, "unconfirmed@example.test"],
  );
  await db.query("insert into profiles(user_id,username) values($1,'moderadora')", [MOD]);
  await db.exec(`set local session_replication_role = replica;`);
  await db.query(
    "insert into admin_roles(user_id,role) values($1,'admin'),($2,'admin'),($3,'moderator'),($4,'developer'),($5,'moderator')",
    [ADMIN, ADMIN2, MOD, DEVELOPER, UNCONFIRMED],
  );
  await db.exec(`set local session_replication_role = origin;`);
});
afterEach(async () => {
  await db.exec("reset role;rollback");
});

type J = Record<string, unknown>;
const call = async (sql: string, params: unknown[]): Promise<J> =>
  (await db.query<{ r: J }>(`select ${sql} r`, params)).rows[0].r;
const create = (user: string, hash = T1) =>
  call("admin_mfa_recovery_create($1,$2)", [user, hash]);
const verify = (user: string, hash: string) =>
  call("admin_mfa_recovery_verify($1,$2)", [user, hash]);
const resend = (user: string, hash: string) =>
  call("admin_mfa_recovery_resend($1,$2)", [user, hash]);
const CANCEL = sha("cancel-token-1");
const CANCEL2 = sha("cancel-token-2");
const approve = (rid: string, actor: string, cancelHash = CANCEL) =>
  call("admin_mfa_recovery_approve($1,$2,$3)", [rid, actor, cancelHash]);
const cancelByToken = (hash: string) =>
  call("admin_mfa_recovery_cancel_by_token($1)", [hash]);
const cancelCheck = async (hash: string) =>
  (await db.query<{ r: boolean }>("select admin_mfa_recovery_cancel_check($1) r", [hash]))
    .rows[0].r;
const setCancel = (rid: string, hash: string) =>
  call("admin_mfa_recovery_set_cancel($1,$2)", [rid, hash]);
const allowed = async (rid: string) =>
  (
    await db.query<{ r: boolean }>("select admin_mfa_recovery_execution_allowed($1) r", [
      rid,
    ])
  ).rows[0].r;
const deny = (rid: string, actor: string, reason: string) =>
  call("admin_mfa_recovery_deny($1,$2,$3)", [rid, actor, reason]);
const cancel = (rid: string, actor: string) =>
  call("admin_mfa_recovery_cancel($1,$2)", [rid, actor]);
const begin = (user: string, rid: string) =>
  call("admin_mfa_recovery_begin_execute($1,$2)", [user, rid]);
const current = (user: string) => call("admin_mfa_recovery_current($1)", [user]);
const complete = (user: string, session: string | null) =>
  call("admin_mfa_recovery_complete($1,$2)", [user, session]);
const mailStart = (rid: string, kind: string, key: string) =>
  call("admin_mfa_recovery_mail_start($1,$2,$3)", [rid, kind, key]);
const mailResult = async (
  key: string,
  ok: boolean,
  provider: string | null,
  cls: string | null,
) =>
  (
    await db.query<{ r: string }>(
      "select admin_mfa_recovery_mail_result($1,$2,$3,$4) r",
      [key, ok, provider, cls],
    )
  ).rows[0].r;
const mailEvent = async (provider: string, event: string) =>
  (
    await db.query<{ r: string }>("select admin_mfa_recovery_mail_event($1,$2) r", [
      provider,
      event,
    ])
  ).rows[0].r;
const factor = (fid: string, user: string, created?: string) =>
  db.query(
    "insert into auth.mfa_factors(id,user_id,created_at) values($1,$2,coalesce($3::timestamptz, now()))",
    [fid, user, created ?? null],
  );
const row = async (rid: string) =>
  (
    await db.query<Record<string, unknown>>(
      "select * from admin_mfa_recoveries where id=$1",
      [rid],
    )
  ).rows[0];
async function fails(run: () => Promise<unknown>, pattern: RegExp) {
  await db.exec("savepoint expected");
  let err: unknown = null;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  await db.exec("rollback to savepoint expected");
  expect(err).not.toBeNull();
  expect(String((err as Error).message)).toMatch(pattern);
}

/** Viaje en el tiempo de la solicitud: expires_at es inmutable por trigger, se desactiva solo aquí. */
async function expireRequest(rid: unknown) {
  await db.exec(
    "alter table admin_mfa_recoveries disable trigger admin_mfa_recoveries_guard",
  );
  await db.query(
    "update admin_mfa_recoveries set expires_at = now() - interval '1 second' where id=$1",
    [rid],
  );
  await db.exec(
    "alter table admin_mfa_recoveries enable trigger admin_mfa_recoveries_guard",
  );
}

/** Lleva una recuperación de MOD hasta «approved» con el aviso ENTREGADO y la espera cumplida. */
async function readyRecovery(user = MOD, cancelHash = CANCEL): Promise<string> {
  const c = await create(user);
  const rid = c.recoveryId as string;
  expect((await verify(user, T1)).ok).toBe(true);
  expect((await approve(rid, ADMIN, cancelHash)).ok).toBe(true);
  await mailStart(rid, "approved", `recovery:${rid}:approved`);
  await mailResult(`recovery:${rid}:approved`, true, "prov-approved", null);
  await mailEvent("prov-approved", "delivered");
  await db.query(
    "update admin_mfa_recoveries set approved_at = now() - interval '20 minutes' where id=$1",
    [rid],
  );
  await db.query(
    "update admin_mfa_recovery_mail set delivered_at = now() - interval '20 minutes' where recovery_id=$1",
    [rid],
  );
  return rid;
}

describe("solicitud", () => {
  it("un miembro privilegiado crea UNA solicitud; solo se guarda el hash del desafío y el correo en hash", async () => {
    const c = await create(MOD);
    expect(c).toMatchObject({
      ok: true,
      role: "moderator",
      email: "mod@example.test",
      sends: 1,
    });
    const r = await row(c.recoveryId as string);
    expect(r).toMatchObject({
      status: "pending_email",
      user_id: MOD,
      challenge_sends: 1,
    });
    expect(r.challenge_hash).toBe(T1);
    expect(r.email_hash).toBe(sha("mod@example.test"));
    expect(JSON.stringify(r)).not.toContain("mod@example.test");
    const ev = await db.query("select event from admin_mfa_recovery_events");
    expect(ev.rows).toEqual([{ event: "requested" }]);
  });

  it("rechaza a quien no tiene rol, con correo sin confirmar vía Auth, y a una solicitud activa duplicada", async () => {
    expect(await create(NOBODY)).toMatchObject({ ok: false, reason: "not_privileged" });
    expect(await create(UNCONFIRMED)).toMatchObject({
      ok: false,
      reason: "email_unverified",
    });
    await create(MOD);
    expect(await create(MOD, T2)).toMatchObject({ ok: false, reason: "active_request" });
  });

  it("el único admin no tiene recuperación automática; otros miembros sí si existe un admin", async () => {
    await db.query("delete from admin_roles where user_id=$1", [ADMIN2]);
    expect(await create(ADMIN)).toMatchObject({ ok: false, reason: "no_approver" });
    expect((await create(MOD)).ok).toBe(true);
  });

  it("limita a 3 solicitudes por cuenta en 24 horas", async () => {
    for (let i = 0; i < 3; i++) {
      const c = await create(MOD, sha(`t${i}`));
      expect(c.ok).toBe(true);
      expect((await cancel(c.recoveryId as string, MOD)).ok).toBe(true);
    }
    expect(await create(MOD, T2)).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("una solicitud caducada se cierra y permite empezar otra", async () => {
    const c = await create(MOD);
    await expireRequest(c.recoveryId);
    const again = await create(MOD, T2);
    expect(again.ok).toBe(true);
    expect(await row(c.recoveryId as string)).toMatchObject({ status: "expired" });
  });

  it("argumentos inválidos (hash mal formado) se rechazan", async () => {
    await fails(() => create(MOD, "no-es-un-hash"), /invalid_argument/);
  });
});

describe("desafío de correo", () => {
  it("el desafío correcto pasa a pending_approval, destruye el hash y NO es reutilizable", async () => {
    const c = await create(MOD);
    expect(await verify(MOD, T1)).toMatchObject({ ok: true, status: "pending_approval" });
    const r = await row(c.recoveryId as string);
    expect(r.challenge_hash).toBeNull();
    expect(r.email_verified_at).not.toBeNull();
    expect(await verify(MOD, T1)).toMatchObject({ ok: false, reason: "no_request" });
  });

  it("un desafío incorrecto cuenta intentos y a los 5 cancela la solicitud (aunque luego llegue el correcto)", async () => {
    const c = await create(MOD);
    for (let i = 0; i < 4; i++) {
      expect(await verify(MOD, BAD)).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(await verify(MOD, BAD)).toMatchObject({ ok: false, reason: "locked" });
    expect(await row(c.recoveryId as string)).toMatchObject({
      status: "cancelled",
      closed_reason: "too_many_attempts",
    });
    expect(await verify(MOD, T1)).toMatchObject({ ok: false, reason: "no_request" });
  });

  it("un desafío caducado no verifica; reenviar rota el hash, invalida el anterior y respeta enfriamiento y límite", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    await db.query(
      "update admin_mfa_recoveries set challenge_expires_at = now() - interval '1 second' where id=$1",
      [rid],
    );
    expect(await verify(MOD, T1)).toMatchObject({
      ok: false,
      reason: "challenge_expired",
    });
    expect(await resend(MOD, T2)).toMatchObject({ ok: false, reason: "too_soon" });
    await db.query(
      "update admin_mfa_recoveries set last_sent_at = now() - interval '2 minutes' where id=$1",
      [rid],
    );
    expect(await resend(MOD, T2)).toMatchObject({ ok: true, sends: 2 });
    expect(await verify(MOD, T1)).toMatchObject({ ok: false, reason: "invalid" }); // el anterior ya no sirve
    await db.query(
      "update admin_mfa_recoveries set last_sent_at = now() - interval '2 minutes' where id=$1",
      [rid],
    );
    expect((await resend(MOD, sha("t3"))).ok).toBe(true);
    await db.query(
      "update admin_mfa_recoveries set last_sent_at = now() - interval '2 minutes' where id=$1",
      [rid],
    );
    expect(await resend(MOD, sha("t4"))).toMatchObject({
      ok: false,
      reason: "send_limit",
    });
  });

  it("cambiar el correo registrado invalida la solicitud (verificación, reenvío y aprobación)", async () => {
    const c = await create(MOD);
    await db.query("update auth.users set email='otro@example.test' where id=$1", [MOD]);
    expect(await verify(MOD, T1)).toMatchObject({ ok: false, reason: "email_changed" });
    expect(await row(c.recoveryId as string)).toMatchObject({
      status: "cancelled",
      closed_reason: "email_changed",
    });

    await db.query("update auth.users set email='mod@example.test' where id=$1", [MOD]);
    const c2 = await create(MOD, T2);
    expect((await verify(MOD, T2)).ok).toBe(true);
    await db.query("update auth.users set email='tercero@example.test' where id=$1", [
      MOD,
    ]);
    expect(await approve(c2.recoveryId as string, ADMIN)).toMatchObject({
      ok: false,
      reason: "email_changed",
    });
  });

  it("si cambia el rol del solicitante durante el proceso, la solicitud se cancela", async () => {
    const c = await create(MOD);
    await db.query("update admin_roles set role='developer' where user_id=$1", [MOD]);
    expect(await verify(MOD, T1)).toMatchObject({ ok: false, reason: "role_changed" });
    expect(await row(c.recoveryId as string)).toMatchObject({ status: "cancelled" });
  });

  it("el desafío de OTRA cuenta no verifica la propia (ligado al usuario)", async () => {
    await create(MOD, T1);
    await create(DEVELOPER, T2);
    expect(await verify(MOD, T2)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await verify(DEVELOPER, T2)).toMatchObject({ ok: true });
  });
});

describe("aprobación, rechazo y cancelación", () => {
  it("solo otro ADMIN aprueba: sin autoaprobación, sin moderator/developer, sin solicitud sin correo verificado", async () => {
    const c = await create(ADMIN);
    const rid = c.recoveryId as string;
    expect(await approve(rid, ADMIN2)).toMatchObject({
      ok: false,
      reason: "not_pending",
    }); // correo sin verificar
    expect((await verify(ADMIN, T1)).ok).toBe(true);
    expect(await approve(rid, ADMIN)).toMatchObject({
      ok: false,
      reason: "self_approval",
    });
    await fails(() => approve(rid, MOD), /actor_not_admin/);
    await fails(() => approve(rid, DEVELOPER), /actor_not_admin/);
    await fails(() => approve(rid, NOBODY), /actor_not_admin/);
    const ok = await approve(rid, ADMIN2);
    expect(ok).toMatchObject({ ok: true, email: "admin@example.test" });
    expect(await row(rid)).toMatchObject({ status: "approved", approved_by: ADMIN2 });
  });

  it("no se aprueba dos veces ni una solicitud caducada", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    await verify(MOD, T1);
    expect((await approve(rid, ADMIN)).ok).toBe(true);
    expect(await approve(rid, ADMIN2)).toMatchObject({
      ok: false,
      reason: "not_pending",
    });

    const c2 = await create(DEVELOPER, T2);
    await verify(DEVELOPER, T2);
    await expireRequest(c2.recoveryId);
    expect(await approve(c2.recoveryId as string, ADMIN)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("rechazar exige motivo, no lo hace el titular y deja la solicitud cerrada (no aprobable después)", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    await verify(MOD, T1);
    expect(await deny(rid, ADMIN, "   ")).toMatchObject({
      ok: false,
      reason: "reason_required",
    });
    await fails(() => deny(rid, MOD, "x"), /actor_not_admin/);
    expect(await deny(rid, ADMIN, "No reconozco la solicitud")).toMatchObject({
      ok: true,
    });
    expect(await row(rid)).toMatchObject({
      status: "denied",
      denied_reason: "No reconozco la solicitud",
    });
    expect(await approve(rid, ADMIN2)).toMatchObject({
      ok: false,
      reason: "not_pending",
    });
  });

  it("el titular y cualquier admin pueden cancelar; un tercero no; lo cerrado no se reabre", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    expect(await cancel(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    expect((await cancel(rid, MOD)).ok).toBe(true);
    expect(await row(rid)).toMatchObject({
      status: "cancelled",
      closed_reason: "cancelled_by_owner",
    });
    expect(await cancel(rid, MOD)).toMatchObject({
      ok: false,
      reason: "not_cancellable",
    });
    await fails(
      () =>
        db.query("update admin_mfa_recoveries set status='approved' where id=$1", [rid]),
      /mfa_recovery_closed/,
    );
  });
});

describe("espera y aviso verificado antes de ejecutar", () => {
  it("sin aviso entregado NO se ejecuta (pendiente, solo aceptado, fallido); la espera no sustituye la entrega", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    await verify(MOD, T1);
    await approve(rid, ADMIN);
    await db.query(
      "update admin_mfa_recoveries set approved_at = now() - interval '2 hours' where id=$1",
      [rid],
    );
    expect(await begin(MOD, rid)).toMatchObject({ ok: false, reason: "notice_pending" }); // sin registro
    const key = `recovery:${rid}:approved`;
    expect(await mailStart(rid, "approved", key)).toMatchObject({ shouldSend: true });
    expect(await begin(MOD, rid)).toMatchObject({ ok: false, reason: "notice_pending" });
    await mailResult(key, true, "prov-1", null);
    expect(await begin(MOD, rid)).toMatchObject({ ok: false, reason: "notice_pending" }); // aceptado ≠ entregado
    await mailEvent("prov-1", "bounced");
    expect(await begin(MOD, rid)).toMatchObject({ ok: false, reason: "notice_failed" });
    expect(await row(rid)).toMatchObject({ status: "approved", factor_ids: [] });
  });

  it("entregado pero dentro de los 15 min → 'waiting'; cumplida la espera → ready", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    await verify(MOD, T1);
    await approve(rid, ADMIN);
    const key = `recovery:${rid}:approved`;
    await mailStart(rid, "approved", key);
    await mailResult(key, true, "prov-2", null);
    await mailEvent("prov-2", "delivered");
    expect(await begin(MOD, rid)).toMatchObject({ ok: false, reason: "waiting" });
    // La espera cuenta también desde la ENTREGA: aprobar hace tiempo pero entregar ahora sigue esperando.
    await db.query(
      "update admin_mfa_recoveries set approved_at = now() - interval '2 hours' where id=$1",
      [rid],
    );
    expect(await begin(MOD, rid)).toMatchObject({ ok: false, reason: "waiting" });
    await db.query(
      "update admin_mfa_recovery_mail set delivered_at = now() - interval '16 minutes' where recovery_id=$1",
      [rid],
    );
    expect((await current(MOD)).readiness).toBe("ready");
  });

  it("mail: idempotente, el fallo permite otro intento con otra clave, entregado no se degrada, abrir/clic se ignoran", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    const key = `recovery:${rid}:challenge:1`;
    const first = await mailStart(rid, "challenge", key);
    expect(first).toMatchObject({ shouldSend: true, providerKey: `${key}:1` });
    expect(await mailResult(key, false, null, "provider_unavailable")).toBe("failed");
    const second = await mailStart(rid, "challenge", key);
    expect(second).toMatchObject({ shouldSend: true, providerKey: `${key}:2` });
    expect(await mailResult(key, true, "prov-3", null)).toBe("accepted");
    expect(await mailStart(rid, "challenge", key)).toMatchObject({
      shouldSend: false,
      state: "accepted",
    });
    expect(await mailEvent("prov-3", "opened")).toBe("ignored");
    expect(await mailEvent("prov-3", "clicked")).toBe("ignored");
    expect(await mailEvent("prov-3", "delivered")).toBe("delivered");
    expect(await mailEvent("prov-3", "bounced")).toBe("delivered"); // no se degrada
    expect(await mailResult(key, false, null, "x")).toBe("delivered");
    expect(await mailEvent("prov-desconocido", "delivered")).toBe("unknown_message");
    await fails(
      () => mailStart(DEVELOPER, "challenge", key),
      /violates|invalid_argument/,
    );
  });
});

describe("ejecución y finalización", () => {
  it("instantánea de ids TOTP, borrado exacto idempotente, el rol y las invitaciones no cambian", async () => {
    await factor(OLD_F, MOD);
    await factor(OLD_F2, MOD);
    const rid = await readyRecovery();
    const invitationsBefore = (
      await db.query("select count(*)::int n from admin_invitations")
    ).rows;
    const b = await begin(MOD, rid);
    expect(b).toMatchObject({ ok: true, already: false, status: "executing" });
    expect((b.factorIds as string[]).sort()).toEqual([OLD_F, OLD_F2].sort());
    // un reintento reutiliza la MISMA instantánea, aunque haya aparecido un factor nuevo
    await factor(NEW_F, MOD);
    const again = await begin(MOD, rid);
    expect((again.factorIds as string[]).sort()).toEqual([OLD_F, OLD_F2].sort());
    expect(again.factorIds).not.toContain(NEW_F);
    expect(
      (
        await db.query<{ r: string }>(
          "select admin_mfa_recovery_record_execution($1,false,null,'auth_delete_failed') r",
          [rid],
        )
      ).rows[0].r,
    ).toBe("failed");
    expect(await row(rid)).toMatchObject({
      status: "executing",
      execution_attempts: 1,
      last_error_class: "auth_delete_failed",
    });
    expect(
      (
        await db.query<{ r: string }>(
          "select admin_mfa_recovery_record_execution($1,true,2,null) r",
          [rid],
        )
      ).rows[0].r,
    ).toBe("factors_deleted");
    expect(
      (
        await db.query<{ r: string }>(
          "select admin_mfa_recovery_record_execution($1,true,2,null) r",
          [rid],
        )
      ).rows[0].r,
    ).toBe("already_recorded");
    expect(await begin(MOD, rid)).toMatchObject({
      ok: true,
      already: true,
      status: "factors_deleted",
    });
    expect(await row(rid)).toMatchObject({ factors_deleted: 2 });
    expect(
      (await db.query("select role from admin_roles where user_id=$1", [MOD])).rows,
    ).toEqual([{ role: "moderator" }]);
    expect(
      (await db.query("select count(*)::int n from admin_invitations")).rows,
    ).toEqual(invitationsBefore);
  });

  it("sin factores previos la instantánea queda vacía y la recuperación sigue", async () => {
    const rid = await readyRecovery();
    expect(await begin(MOD, rid)).toMatchObject({ ok: true, factorIds: [] });
  });

  it("otro usuario no puede ejecutar la recuperación ajena; solo se incluyen factores TOTP del titular", async () => {
    await factor(OLD_F, MOD);
    await factor(OLD_F2, DEVELOPER);
    const rid = await readyRecovery();
    expect(await begin(DEVELOPER, rid)).toMatchObject({ ok: false, reason: "not_found" });
    expect((await begin(MOD, rid)).factorIds).toEqual([OLD_F]);
  });

  it("antes de ejecutar se revalida: cambio de rol o de correo cancela y no crea instantánea", async () => {
    const rid = await readyRecovery();
    await db.query("update admin_roles set role='developer' where user_id=$1", [MOD]);
    expect(await begin(MOD, rid)).toMatchObject({ ok: false, reason: "role_changed" });
    expect(await row(rid)).toMatchObject({ status: "cancelled", factor_ids: [] });
  });

  it("completed exige un TOTP NUEVO verificado en aal2: ni el factor antiguo, ni aal1, ni sin sesión", async () => {
    await factor(OLD_F, MOD, "2020-01-01T00:00:00Z");
    const rid = await readyRecovery();
    await begin(MOD, rid);
    await db.query("select admin_mfa_recovery_record_execution($1,true,1,null)", [rid]);
    await db.query("delete from auth.mfa_factors where id=$1", [OLD_F]);
    expect(await complete(MOD, null)).toMatchObject({
      ok: false,
      reason: "new_factor_required",
    });
    await db.query(
      "insert into auth.sessions(id,user_id,factor_id,aal) values($1,$2,null,'aal1')",
      [SESSION, MOD],
    );
    expect(await complete(MOD, SESSION)).toMatchObject({
      ok: false,
      reason: "new_factor_required",
    });
    await db.query(
      "update admin_mfa_recoveries set executed_at = now() - interval '1 minute' where id=$1",
      [rid],
    );
    await factor(NEW_F, MOD); // creado DESPUÉS del borrado
    await db.query("update auth.sessions set factor_id=$1, aal='aal1' where id=$2", [
      NEW_F,
      SESSION,
    ]);
    expect(await complete(MOD, SESSION)).toMatchObject({
      ok: false,
      reason: "new_factor_required",
    }); // aal1
    await db.query("update auth.sessions set aal='aal2' where id=$1", [SESSION]);
    expect(await complete(MOD, SESSION)).toMatchObject({ ok: true, already: false });
    expect(await row(rid)).toMatchObject({ status: "completed" });
    expect(await complete(MOD, SESSION)).toMatchObject({ ok: true, already: true });
    const ev = (
      await db.query<{ event: string }>(
        "select event from admin_mfa_recovery_events where event in ('factors_deleted','completed') order by id",
      )
    ).rows;
    expect(ev.map((e) => e.event)).toEqual(["factors_deleted", "completed"]);
  });

  it("un factor presente en la instantánea o anterior al borrado nunca cierra la recuperación", async () => {
    await factor(OLD_F, MOD);
    const rid = await readyRecovery();
    await begin(MOD, rid);
    await db.query("select admin_mfa_recovery_record_execution($1,true,0,null)", [rid]);
    // el factor antiguo sigue «verificado» (el borrado real aún no ocurrió) y una sesión aal2 lo usa
    await db.query(
      "insert into auth.sessions(id,user_id,factor_id,aal) values($1,$2,$3,'aal2')",
      [SESSION, MOD, OLD_F],
    );
    expect(await complete(MOD, SESSION)).toMatchObject({
      ok: false,
      reason: "new_factor_required",
    });
    // una sesión de OTRA cuenta no vale
    await factor(NEW_F, DEVELOPER);
    await db.query("update auth.sessions set factor_id=$1 where id=$2", [NEW_F, SESSION]);
    expect(await complete(MOD, SESSION)).toMatchObject({
      ok: false,
      reason: "new_factor_required",
    });
  });

  it("defensa por reloj: un factor verificado anterior al borrado se rechaza aunque no estuviera en la instantánea", async () => {
    const rid = await readyRecovery();
    await begin(MOD, rid); // instantánea vacía: aún no existe ningún factor
    await db.query("select admin_mfa_recovery_record_execution($1,true,0,null)", [rid]);
    await factor(NEW_F, MOD, "2020-01-01T00:00:00Z"); // verificado, «creado» antes del borrado
    await db.query(
      "insert into auth.sessions(id,user_id,factor_id,aal) values($1,$2,$3,'aal2')",
      [SESSION, MOD, NEW_F],
    );
    expect(await complete(MOD, SESSION)).toMatchObject({
      ok: false,
      reason: "new_factor_required",
    });
  });

  it("un TOTP NO verificado (pendiente) nunca cierra la recuperación; una vez verificado sí, y repetir no duplica nada", async () => {
    const rid = await readyRecovery();
    await begin(MOD, rid);
    await db.query("select admin_mfa_recovery_record_execution($1,true,0,null)", [rid]);
    await db.query(
      "update admin_mfa_recoveries set executed_at = now() - interval '1 minute' where id=$1",
      [rid],
    );
    await db.query(
      "insert into auth.mfa_factors(id,user_id,status) values($1,$2,'unverified')",
      [NEW_F, MOD],
    );
    await db.query(
      "insert into auth.sessions(id,user_id,factor_id,aal) values($1,$2,$3,'aal2')",
      [SESSION, MOD, NEW_F],
    );
    expect(await complete(MOD, SESSION)).toMatchObject({
      ok: false,
      reason: "new_factor_required",
    });
    expect(await row(rid)).toMatchObject({
      status: "factors_deleted",
      completed_at: null,
    });
    await db.query("update auth.mfa_factors set status='verified' where id=$1", [NEW_F]);
    expect(await complete(MOD, SESSION)).toMatchObject({ ok: true, already: false });
    for (let i = 0; i < 3; i++)
      expect(await complete(MOD, SESSION)).toMatchObject({ ok: true, already: true });
    const done = (
      await db.query(
        "select count(*)::int n from admin_mfa_recovery_events where event='completed'",
      )
    ).rows[0];
    expect(done).toEqual({ n: 1 }); // un solo evento aunque se reconcilie varias veces
  });

  it("el factor de OTRA cuenta (aunque esté verificado y sea nuevo) no cierra la recuperación de este titular", async () => {
    const rid = await readyRecovery();
    await begin(MOD, rid);
    await db.query("select admin_mfa_recovery_record_execution($1,true,0,null)", [rid]);
    await db.query(
      "update admin_mfa_recoveries set executed_at = now() - interval '1 minute' where id=$1",
      [rid],
    );
    await factor(NEW_F, DEVELOPER);
    await db.query(
      "insert into auth.sessions(id,user_id,factor_id,aal) values($1,$2,$3,'aal2')",
      [SESSION, MOD, NEW_F],
    );
    expect(await complete(MOD, SESSION)).toMatchObject({
      ok: false,
      reason: "new_factor_required",
    });
  });

  it("solo se cierra desde factors_deleted: aprobada, en ejecución o cancelada no se pueden «completar»", async () => {
    const rid = await readyRecovery();
    await factor(NEW_F, MOD);
    await db.query(
      "insert into auth.sessions(id,user_id,factor_id,aal) values($1,$2,$3,'aal2')",
      [SESSION, MOD, NEW_F],
    );
    expect(await complete(MOD, SESSION)).toMatchObject({
      ok: false,
      reason: "no_request",
    }); // approved
    await begin(MOD, rid); // executing
    expect(await complete(MOD, SESSION)).toMatchObject({
      ok: false,
      reason: "no_request",
    });
    expect(await row(rid)).toMatchObject({ status: "executing" });
  });

  it("si el titular pierde el rol no se completa; si abandona tras borrar, puede empezar otra solicitud", async () => {
    const rid = await readyRecovery();
    await begin(MOD, rid);
    await db.query("select admin_mfa_recovery_record_execution($1,true,0,null)", [rid]);
    const next = await create(MOD, T2);
    expect(next.ok).toBe(true);
    expect(await row(rid)).toMatchObject({
      status: "cancelled",
      closed_reason: "superseded",
    });
  });
});

describe("enlace de cancelación (sin sesión ni TOTP)", () => {
  it("solo se guarda el hash; el enlace es válido tras aprobar y NO antes", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    await verify(MOD, T1);
    expect(await cancelCheck(CANCEL)).toBe(false); // aún no aprobada
    await approve(rid, ADMIN);
    const r = await row(rid);
    expect(r.cancel_hash).toBe(CANCEL);
    expect(r.cancel_rotations).toBe(1);
    expect(await cancelCheck(CANCEL)).toBe(true);
    expect(await cancelCheck(sha("otro"))).toBe(false);
    expect(await cancelCheck("no-es-hash")).toBe(false);
  });

  it("cancelar cierra la solicitud, es de UN solo uso, audita sin el token y conserva rol y factores", async () => {
    await factor(OLD_F, MOD);
    const rid = await readyRecovery();
    const out = await cancelByToken(CANCEL);
    expect(out).toMatchObject({ ok: true, recoveryId: rid, userId: MOD });
    expect(await row(rid)).toMatchObject({
      status: "cancelled",
      closed_reason: "cancelled_by_link",
      cancel_hash: null,
    });
    expect(await cancelByToken(CANCEL)).toMatchObject({ ok: false, reason: "invalid" }); // un solo uso
    expect(
      (await db.query("select role from admin_roles where user_id=$1", [MOD])).rows,
    ).toEqual([{ role: "moderator" }]);
    expect(
      (await db.query("select id from auth.mfa_factors where user_id=$1", [MOD])).rows,
    ).toEqual([{ id: OLD_F }]);
    const ev = (
      await db.query<Record<string, unknown>>(
        "select event, actor_user_id, detail from admin_mfa_recovery_events where event='cancelled'",
      )
    ).rows;
    expect(ev).toEqual([
      { event: "cancelled", actor_user_id: null, detail: "cancelled_by_link" },
    ]);
    expect(
      JSON.stringify((await db.query("select * from admin_mfa_recovery_events")).rows),
    ).not.toContain(CANCEL);
  });

  it("tras cancelar NO se puede ejecutar ni aprobar de nuevo, aunque ya esté lista y vigente", async () => {
    const rid = await readyRecovery();
    expect((await current(MOD)).readiness).toBe("ready");
    await cancelByToken(CANCEL);
    expect(await begin(MOD, rid)).toMatchObject({ ok: false, reason: "not_approved" });
    expect(await approve(rid, ADMIN2)).toMatchObject({
      ok: false,
      reason: "not_pending",
    });
    expect(await row(rid)).toMatchObject({ factor_ids: [] });
  });

  it("condición de carrera: cancelar DESPUÉS de begin_execute detiene el resto del borrado y la reanudación", async () => {
    await factor(OLD_F, MOD);
    const rid = await readyRecovery();
    expect(await begin(MOD, rid)).toMatchObject({ ok: true, status: "executing" });
    expect(await allowed(rid)).toBe(true);
    expect(await cancelByToken(CANCEL)).toMatchObject({ ok: true }); // cancelación en 'executing'
    expect(await allowed(rid)).toBe(false); // el ejecutor se detiene antes del siguiente borrado
    expect(await begin(MOD, rid)).toMatchObject({ ok: false });
    await fails(
      () => db.query("select admin_mfa_recovery_record_execution($1,true,1,null)", [rid]),
      /mfa_recovery_closed|not_executing/,
    );
  });

  it("no cancela una solicitud ya terminada, caducada, ni la de otra cuenta con un token ajeno", async () => {
    const rid = await readyRecovery();
    await begin(MOD, rid);
    await db.query("select admin_mfa_recovery_record_execution($1,true,0,null)", [rid]);
    expect(await cancelByToken(CANCEL)).toMatchObject({ ok: false, reason: "invalid" }); // factors_deleted
    const rid2 = await readyRecovery(DEVELOPER, CANCEL2);
    await expireRequest(rid2);
    expect(await cancelByToken(CANCEL2)).toMatchObject({ ok: false });
    expect(await cancelCheck(CANCEL2)).toBe(false);
  });

  it("reenviar el aviso rota el token (el anterior deja de valer) salvo que el aviso ya esté entregado", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    await verify(MOD, T1);
    await approve(rid, ADMIN);
    const key = `recovery:${rid}:approved:1`;
    await mailStart(rid, "approved", key);
    await mailResult(key, false, null, "provider_unavailable");
    expect(await setCancel(rid, CANCEL2)).toMatchObject({ ok: true, cancelRotation: 2 });
    expect(await cancelCheck(CANCEL)).toBe(false);
    expect(await cancelCheck(CANCEL2)).toBe(true);
    await mailStart(rid, "approved", `recovery:${rid}:approved:2`);
    await mailResult(`recovery:${rid}:approved:2`, true, "prov-r", null);
    await mailEvent("prov-r", "delivered");
    expect(await setCancel(rid, sha("tercero"))).toMatchObject({
      ok: false,
      reason: "already_delivered",
    });
    expect(await cancelCheck(CANCEL2)).toBe(true); // el enlace entregado sigue vigente
  });

  it("solo cuenta el ÚLTIMO aviso: una entrega antigua no habilita la ejecución del aviso rotado", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    await verify(MOD, T1);
    await approve(rid, ADMIN);
    await mailStart(rid, "approved", `recovery:${rid}:approved:1`);
    await mailResult(`recovery:${rid}:approved:1`, true, "prov-a", null);
    await setCancel(rid, CANCEL2);
    await mailStart(rid, "approved", `recovery:${rid}:approved:2`);
    await mailResult(`recovery:${rid}:approved:2`, true, "prov-b", null);
    await db.query(
      "update admin_mfa_recoveries set approved_at = now() - interval '2 hours' where id=$1",
      [rid],
    );
    await mailEvent("prov-a", "delivered");
    expect((await current(MOD)).readiness).toBe("notice_pending");
    await mailEvent("prov-b", "delivered");
    await db.query(
      "update admin_mfa_recovery_mail set delivered_at = now() - interval '20 minutes' where recovery_id=$1",
      [rid],
    );
    expect((await current(MOD)).readiness).toBe("ready");
  });

  it("eventos del proveedor repetidos o fuera de orden no corrompen el estado", async () => {
    const c = await create(MOD);
    const rid = c.recoveryId as string;
    const key = `recovery:${rid}:challenge:1`;
    await mailStart(rid, "challenge", key);
    await mailResult(key, true, "prov-o", null);
    expect(await mailEvent("prov-o", "bounced")).toBe("failed");
    expect(await mailEvent("prov-o", "delivered")).toBe("delivered"); // la entrega tardía corrige
    expect(await mailEvent("prov-o", "delivered")).toBe("delivered"); // repetido
    expect(await mailEvent("prov-o", "bounced")).toBe("delivered"); // posterior, no degrada
    const st = (
      await db.query<{ state: string }>(
        "select state from admin_mfa_recovery_mail where idempotency_key=$1",
        [key],
      )
    ).rows[0];
    expect(st.state).toBe("delivered");
  });

  it("solo service_role puede usar el enlace; anon/authenticated no", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set local role ${role}`);
      await fails(() => cancelByToken(CANCEL), /permission denied/);
      await fails(
        () => db.query("select admin_mfa_recovery_cancel_check($1)", [CANCEL]),
        /permission denied/,
      );
      await db.exec("reset role");
    }
  });
});

describe("lecturas, auditoría y permisos", () => {
  it("el listado de admin solo lo ve un ADMIN y no incluye correo ni secretos", async () => {
    const c = await create(MOD);
    await verify(MOD, T1);
    const rows = (
      await db.query<Record<string, unknown>>(
        "select * from admin_mfa_recoveries_pending($1)",
        [ADMIN],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      out_id: c.recoveryId,
      out_username: "moderadora",
      out_status: "pending_approval",
    });
    expect(Object.keys(rows[0])).not.toContain("out_email");
    expect(Object.keys(rows[0]).join(",")).not.toMatch(/hash|token/);
    expect(JSON.stringify(rows[0])).not.toContain("@example");
    await fails(
      () => db.query("select * from admin_mfa_recoveries_pending($1)", [MOD]),
      /actor_not_admin/,
    );
  });

  it("los eventos son de solo anexar y la tabla no se puede tocar con los roles de la API", async () => {
    const c = await create(MOD);
    await fails(
      () => db.query("update admin_mfa_recovery_events set event='completed'"),
      /append_only/,
    );
    await fails(() => db.query("delete from admin_mfa_recovery_events"), /append_only/);
    await fails(
      () => db.query("delete from admin_mfa_recoveries where id=$1", [c.recoveryId]),
      /immutable/,
    );
    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.exec(`set local role ${role}`);
      await fails(
        () => db.query("select * from admin_mfa_recoveries"),
        /permission denied/,
      );
      await fails(
        () => db.query("select * from admin_mfa_recovery_mail"),
        /permission denied/,
      );
      await db.exec("reset role");
    }
  });

  it("solo service_role ejecuta las funciones; anon/authenticated no", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set local role ${role}`);
      await fails(() => create(MOD), /permission denied/);
      await fails(() => approve(id(9), ADMIN), /permission denied/);
      await fails(() => mailEvent("x", "delivered"), /permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set local role service_role");
    await fails(
      () => db.query("select admin_mfa_recovery_close($1,'cancelled','x',null)", [id(9)]),
      /permission denied/,
    );
    await fails(
      () => db.query("select admin_mfa_recovery_readiness($1)", [id(9)]),
      /permission denied/,
    );
    expect((await current(MOD)).status).toBe("none");
    await db.exec("reset role");
  });

  it("el estado del titular refleja el avance sin exponer secretos", async () => {
    expect(await current(MOD)).toMatchObject({ status: "none", hasApprover: true });
    await create(MOD);
    const cur = await current(MOD);
    expect(cur).toMatchObject({ status: "pending_email", readiness: "not_approved" });
    expect(JSON.stringify(cur)).not.toMatch(/challenge_hash|email_hash|@example/);
  });
});

describe("rollback", () => {
  it("se niega si hay historial y funciona sin historial", async () => {
    await create(MOD);
    await fails(
      () => db.exec(readFileSync(resolve(ROLLBACK), "utf8")),
      /rollback_refused_recovery_history_exists/,
    );
  });

  it("sin historial elimina los objetos de la fase 2", async () => {
    await db.exec(readFileSync(resolve(ROLLBACK), "utf8"));
    const left = await db.query(
      "select 1 from pg_proc where proname like 'admin_mfa_recover%' union all select 1 from pg_class where relname like 'admin_mfa_recover%'",
    );
    expect(left.rows).toHaveLength(0);
  });
});
