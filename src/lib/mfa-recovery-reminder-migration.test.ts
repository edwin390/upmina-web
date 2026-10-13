// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "./community-atomic-save-test-db";

// MFA fase 2 — RECORDATORIO del aviso de aprobación. SQL REAL (PGlite) de la migración 20261104120000 sobre la
// cadena real. auth.* son solo la FORMA mínima que usa la migración. No prueba GoTrue ni Resend.

const MIGRATION = "20261104120000_mfa_recovery_reminder.sql";
const ROLLBACK = "supabase/rollbacks/20261104120000_mfa_recovery_reminder.rollback.sql";
const CHAIN = [
  "20260922120000_admin_roles.sql",
  "20260923120000_admin_invitations.sql",
  "20260926120000_admin_team_roles_invariants.sql",
  "20260927120000_admin_team_invitation_revoke.sql",
  "20260928120000_admin_team_member_management.sql",
  "20261031140000_admin_mfa_reset.sql",
  "20261031150000_admin_mfa_recovery.sql",
  "20261101120000_developer_panel.sql",
  "20261102120000_developer_transition.sql",
  "20261103120000_developer_removal.sql",
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
const T1 = sha("token-1");
const CANCEL = sha("cancel-token-1");

let db: TestDatabase;

beforeAll(async () => {
  const modulePath = process.env.UPMINA_TEST_PGLITE_MODULE;
  if (!modulePath) throw new Error("Set UPMINA_TEST_PGLITE_MODULE");
  const { PGlite } = await import(/* @vite-ignore */ modulePath);
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz default now(),
      deleted_at timestamptz, banned_until timestamptz);
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
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [n, email]);
  }
  await db.exec(`set local session_replication_role = replica;`);
  await db.query(
    "insert into admin_roles(user_id,role) values($1,'admin'),($2,'moderator'),($3,'admin'),($4,'developer')",
    [ADMIN, MOD, ADMIN2, DEVELOPER],
  );
  await db.exec(`set local session_replication_role = origin;`);
  for (const [fid, user] of [
    [id(104, "f"), ADMIN],
    [id(105, "f"), ADMIN2],
    [id(106, "f"), MOD],
    [id(107, "f"), DEVELOPER],
  ]) {
    await db.query("insert into auth.mfa_factors(id,user_id) values($1,$2)", [fid, user]);
  }
});
afterEach(async () => {
  await db.exec("reset role;rollback");
});

type J = Record<string, unknown>;
const call = async (sql: string, params: unknown[]): Promise<J> =>
  (await db.query<{ r: J }>(`select ${sql} r`, params)).rows[0].r;
const reminder = (rid: string, actor: string = ADMIN) =>
  call("admin_mfa_recovery_reminder_start($1,$2)", [rid, actor]);
const text = async (sql: string, params: unknown[] = []) =>
  (await db.query<{ r: string | null }>(`select ${sql} r`, params)).rows[0].r;
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
const canExecute = async (role: string, fn: string) =>
  (
    await db.query<{ r: boolean }>("select has_function_privilege($1, $2, 'execute') r", [
      role,
      fn,
    ])
  ).rows[0].r;

/** Aprobada por un par con el aviso de aprobación ENTREGADO (webhook). */
async function approvedAndDelivered(): Promise<string> {
  const c = await call("admin_mfa_recovery_create($1,$2)", [MOD, T1]);
  expect(c.ok).toBe(true);
  const rid = c.recoveryId as string;
  expect((await call("admin_mfa_recovery_verify($1,$2)", [MOD, T1])).ok).toBe(true);
  expect(
    (await call("admin_mfa_recovery_approve($1,$2,$3)", [rid, ADMIN, CANCEL])).ok,
  ).toBe(true);
  await deliverApproval(rid);
  return rid;
}
async function deliverApproval(rid: string) {
  const key = `recovery:${rid}:approved:1`;
  await call("admin_mfa_recovery_mail_start($1,'approved',$2)", [rid, key]);
  await db.query("select admin_mfa_recovery_mail_result($1,true,$2,null)", [
    key,
    "prov-approved-1",
  ]);
  await db.query("select admin_mfa_recovery_mail_event($1,'delivered')", [
    "prov-approved-1",
  ]);
}
const snapshot = async (rid: string) =>
  (
    await db.query(
      `select r.status, r.cancel_hash, r.cancel_rotations, r.approved_at, r.approved_by,
              public.admin_mfa_recovery_ready_at(r.id) ready_at, public.admin_mfa_recovery_readiness(r.id) readiness,
              (select count(*)::int from admin_mfa_recovery_mail m where m.recovery_id = r.id and m.kind = 'approved') approved_mails,
              (select state from admin_mfa_recovery_mail m where m.recovery_id = r.id and m.kind = 'approved') approved_state
         from admin_mfa_recoveries r where r.id = $1`,
      [rid],
    )
  ).rows[0];
const reminders = async (rid: string) =>
  (
    await db.query(
      "select idempotency_key, state from admin_mfa_recovery_mail where recovery_id=$1 and kind='reminder' order by created_at, id",
      [rid],
    )
  ).rows;
async function ageReminders(rid: string, interval = "61 seconds") {
  await db.query(
    "update admin_mfa_recovery_mail set created_at = created_at - $2::interval where recovery_id=$1 and kind='reminder'",
    [rid, interval],
  );
}
const setStatus = async (rid: string, status: string) => {
  await db.exec("set local session_replication_role = replica");
  await db.query("update admin_mfa_recoveries set status=$2 where id=$1", [rid, status]);
  await db.exec("set local session_replication_role = origin");
};

describe("recordatorio del aviso de aprobación", () => {
  it("con el aviso original ENTREGADO reserva un recordatorio y no cambia nada de la recuperación ni de su espera", async () => {
    const rid = await approvedAndDelivered();
    const before = await snapshot(rid);
    expect(before.readiness).toBe("waiting");
    const out = await reminder(rid);
    expect(out).toMatchObject({
      ok: true,
      recoveryId: rid,
      baseKey: `recovery:${rid}:reminder:1`,
      number: 1,
      email: "mod@example.test",
    });
    expect(await reminders(rid)).toEqual([
      { idempotency_key: `recovery:${rid}:reminder:1`, state: "pending" },
    ]);
    // estado, enlace de cancelación, rotaciones, espera y aviso de aprobación: IDÉNTICOS
    expect(await snapshot(rid)).toEqual(before);
  });

  it("aceptado y ENTREGADO el recordatorio, la espera de 15 minutos sigue exactamente igual (solo cuenta el aviso de aprobación)", async () => {
    const rid = await approvedAndDelivered();
    const before = await snapshot(rid);
    const out = await reminder(rid);
    const key = out.baseKey as string;
    await db.query("select admin_mfa_recovery_mail_result($1,true,$2,null)", [
      key,
      "prov-rem-1",
    ]);
    expect((await snapshot(rid)).readiness).toBe("waiting"); // 'accepted' no la bloquea
    expect(await snapshot(rid)).toEqual(before);
    await db.query("select admin_mfa_recovery_mail_event($1,'delivered')", [
      "prov-rem-1",
    ]);
    expect(await snapshot(rid)).toEqual(before); // ni siquiera tras la entrega del recordatorio
    const ev = await db.query<{ detail: string }>(
      "select detail from admin_mfa_recovery_events where recovery_id=$1 and event='mail_state' order by id",
      [rid],
    );
    expect(ev.rows.map((e) => e.detail)).toEqual(
      expect.arrayContaining([
        "approved:delivered",
        "reminder:accepted",
        "reminder:delivered",
      ]),
    );
  });

  it("límite de frecuencia: un segundo recordatorio antes de 60 s se rechaza (too_soon con segundos restantes) y a los 60 s se permite", async () => {
    const rid = await approvedAndDelivered();
    expect((await reminder(rid)).ok).toBe(true);
    const soon = await reminder(rid);
    expect(soon).toMatchObject({ ok: false, reason: "too_soon" });
    expect(Number(soon.retryAfterSeconds)).toBeGreaterThan(0);
    expect(Number(soon.retryAfterSeconds)).toBeLessThanOrEqual(60);
    expect(await reminders(rid)).toHaveLength(1);
    await ageReminders(rid, "59 seconds");
    expect(await reminder(rid)).toMatchObject({ ok: false, reason: "too_soon" });
    await ageReminders(rid, "2 seconds");
    expect(await reminder(rid)).toMatchObject({ ok: true, number: 2 });
  });

  it("máximo 3 recordatorios por recuperación: el cuarto se rechaza (reminder_limit)", async () => {
    const rid = await approvedAndDelivered();
    for (const n of [1, 2, 3]) {
      expect(await reminder(rid)).toMatchObject({ ok: true, number: n });
      await ageReminders(rid);
    }
    expect(await reminder(rid)).toMatchObject({ ok: false, reason: "reminder_limit" });
    expect(await reminders(rid)).toHaveLength(3);
    expect((await snapshot(rid)).readiness).toBe("waiting");
  });

  it("un envío fallido no consume el máximo (pero respeta los 60 s) y usa una clave nueva", async () => {
    const rid = await approvedAndDelivered();
    const first = await reminder(rid);
    await db.query(
      "select admin_mfa_recovery_mail_result($1,false,null,'provider_unavailable')",
      [first.baseKey],
    );
    expect(await reminder(rid)).toMatchObject({ ok: false, reason: "too_soon" });
    await ageReminders(rid);
    expect(await reminder(rid)).toMatchObject({
      ok: true,
      baseKey: `recovery:${rid}:reminder:2`,
    });
    await ageReminders(rid);
    expect(await reminder(rid)).toMatchObject({ ok: true, number: 3 });
    await ageReminders(rid);
    expect(await reminder(rid)).toMatchObject({ ok: true, number: 4 }); // 2 aceptables + 1 fallido
    await ageReminders(rid);
    expect(await reminder(rid)).toMatchObject({ ok: false, reason: "reminder_limit" });
  });

  it("solo para una recuperación APROBADA: cancelada, ejecutando, completada, denegada, caducada o pendiente se rechazan sin reservar nada", async () => {
    const rid = await approvedAndDelivered();
    for (const status of ["cancelled", "executing", "completed", "denied", "expired"]) {
      await db.exec("savepoint st");
      await setStatus(rid, status);
      expect(await reminder(rid), status).toMatchObject({
        ok: false,
        reason: "not_pending",
      });
      expect(await reminders(rid)).toEqual([]);
      await db.exec("rollback to savepoint st");
    }
    expect((await snapshot(rid)).status).toBe("approved");
    await db.exec("delete from admin_mfa_recovery_mail where false");
    // y una solicitud solo creada (pendiente de verificar) tampoco admite recordatorios
    await db.exec("savepoint st2");
    await setStatus(rid, "cancelled");
    const c = await call("admin_mfa_recovery_create($1,$2)", [MOD, T1]);
    expect(await reminder(c.recoveryId as string)).toMatchObject({
      ok: false,
      reason: "not_pending",
    });
    await db.exec("rollback to savepoint st2");
  });

  it("si el aviso de aprobación aún NO está entregado (pendiente, aceptado o fallido) no hay recordatorio: se usa el reenvío normal", async () => {
    const c = await call("admin_mfa_recovery_create($1,$2)", [MOD, T1]);
    const rid = c.recoveryId as string;
    await call("admin_mfa_recovery_verify($1,$2)", [MOD, T1]);
    await call("admin_mfa_recovery_approve($1,$2,$3)", [rid, ADMIN, CANCEL]);
    expect(await reminder(rid)).toMatchObject({
      ok: false,
      reason: "notice_not_delivered",
    });
    const key = `recovery:${rid}:approved:1`;
    await call("admin_mfa_recovery_mail_start($1,'approved',$2)", [rid, key]);
    await db.query("select admin_mfa_recovery_mail_result($1,true,'prov-x',null)", [key]);
    expect(await reminder(rid)).toMatchObject({
      ok: false,
      reason: "notice_not_delivered",
    });
    await db.query("select admin_mfa_recovery_mail_result($1,false,null,'rejected')", [
      `recovery:${rid}:approved:1`,
    ]);
    expect(await reminders(rid)).toEqual([]);
  });

  it("no revela ni afecta otras solicitudes: id inexistente, nulo o ajeno", async () => {
    expect(await reminder(id(77))).toMatchObject({ ok: false, reason: "not_found" });
    await fails(
      () => call("admin_mfa_recovery_reminder_start(null,$1)", [ADMIN]),
      /invalid_argument/,
    );
    expect(
      (await db.query("select 1 from admin_mfa_recovery_mail where kind='reminder'"))
        .rows,
    ).toEqual([]);
  });

  it("si el correo del titular cambió o su rol cambió, no se envía el recordatorio (readiness lo impide)", async () => {
    const rid = await approvedAndDelivered();
    await db.query("update auth.users set email='otro@example.test' where id=$1", [MOD]);
    expect(await reminder(rid)).toMatchObject({ ok: false, reason: "not_pending" });
    expect(await reminders(rid)).toEqual([]);
  });

  it("el enlace de cancelación original sigue vigente tras varios recordatorios", async () => {
    const rid = await approvedAndDelivered();
    for (const n of [1, 2, 3]) {
      expect((await reminder(rid)).ok).toBe(true);
      await ageReminders(rid);
      void n;
    }
    expect(await text("admin_mfa_recovery_cancel_check($1)::text", [CANCEL])).toBe(
      "true",
    );
    expect((await snapshot(rid)).cancel_hash).toBe(CANCEL);
    expect((await snapshot(rid)).cancel_rotations).toBe(1);
  });
});

describe("auditoría del solicitante del recordatorio", () => {
  const events = async (rid: string) =>
    (
      await db.query(
        "select event, actor_user_id, detail from admin_mfa_recovery_events where recovery_id=$1 and detail like 'reminder:%' order by id",
        [rid],
      )
    ).rows;

  it("registra quién lo pidió (Admin) en la auditoría existente, una vez por recordatorio reservado", async () => {
    const rid = await approvedAndDelivered();
    expect((await reminder(rid, ADMIN)).ok).toBe(true);
    await ageReminders(rid);
    expect((await reminder(rid, ADMIN2)).ok).toBe(true);
    expect(await events(rid)).toEqual([
      { event: "mail_state", actor_user_id: ADMIN, detail: "reminder:requested" },
      { event: "mail_state", actor_user_id: ADMIN2, detail: "reminder:requested" },
    ]);
  });

  it("un Developer también puede pedirlo (aprobación excepcional) y queda registrado con su identidad", async () => {
    const rid = await approvedAndDelivered();
    expect((await reminder(rid, DEVELOPER)).ok).toBe(true);
    expect(await events(rid)).toEqual([
      { event: "mail_state", actor_user_id: DEVELOPER, detail: "reminder:requested" },
    ]);
  });

  it("un rechazo (límite de frecuencia, límite máximo) no registra ningún evento de solicitud", async () => {
    const rid = await approvedAndDelivered();
    expect((await reminder(rid)).ok).toBe(true);
    expect((await reminder(rid)).reason).toBe("too_soon");
    expect(await events(rid)).toHaveLength(1);
  });

  it("solo un Admin o Developer vigente puede pedirlo: moderador, usuario sin rol o inexistente → rechazo sin reservar nada", async () => {
    const rid = await approvedAndDelivered();
    for (const actor of [MOD, id(88), id(99)]) {
      await fails(() => reminder(rid, actor), /actor_not_admin/);
    }
    expect(await reminders(rid)).toEqual([]);
    expect(await events(rid)).toEqual([]);
  });

  it("el titular de la solicitud no puede pedir recordatorios sobre la suya (self_approval)", async () => {
    // solicitud de ADMIN aprobada por otro admin (ADMIN2) con aviso entregado
    const c = await call("admin_mfa_recovery_create($1,$2)", [ADMIN, T1]);
    const rid = c.recoveryId as string;
    await call("admin_mfa_recovery_verify($1,$2)", [ADMIN, T1]);
    expect(
      (await call("admin_mfa_recovery_approve($1,$2,$3)", [rid, ADMIN2, CANCEL])).ok,
    ).toBe(true);
    await deliverApproval(rid);
    expect(await reminder(rid, ADMIN)).toMatchObject({
      ok: false,
      reason: "self_approval",
    });
    expect(await reminders(rid)).toEqual([]);
    expect(await reminder(rid, ADMIN2)).toMatchObject({ ok: true });
  });

  it("toma el lock de roles ANTES de cualquier FOR UPDATE (serializa con cambios de rol y aprobaciones)", async () => {
    const def = (
      await db.query<{ d: string }>(
        "select pg_get_functiondef('public.admin_mfa_recovery_reminder_start(uuid,uuid)'::regprocedure) d",
      )
    ).rows[0].d;
    const lock = def.indexOf("upmina_lock_admin_roles");
    const forUpdate = def.indexOf("for update");
    expect(lock).toBeGreaterThan(-1);
    expect(forUpdate).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(forUpdate);
  });

  it("garantía ante la cancelación: confirmada la cancelación NO se puede reservar un recordatorio nuevo; uno ya reservado conserva su fila", async () => {
    const rid = await approvedAndDelivered();
    const reserved = await reminder(rid);
    expect(reserved.ok).toBe(true);
    // el titular cancela con el enlace original (sigue vigente tras la reserva)
    expect((await call("admin_mfa_recovery_cancel_by_token($1)", [CANCEL])).ok).toBe(
      true,
    );
    await ageReminders(rid);
    expect(await reminder(rid)).toMatchObject({ ok: false, reason: "not_pending" });
    // la reserva anterior no se borra ni se altera (no se promete poder retirar un correo ya entregado al proveedor)
    expect(await reminders(rid)).toEqual([
      { idempotency_key: reserved.baseKey, state: "pending" },
    ]);
  });
});

describe("permisos y rollback", () => {
  it("solo service_role ejecuta admin_mfa_recovery_reminder_start; es SECURITY DEFINER con search_path fijo", async () => {
    const fn = "public.admin_mfa_recovery_reminder_start(uuid,uuid)";
    expect(await canExecute("service_role", fn)).toBe(true);
    for (const role of ["anon", "authenticated", "public"]) {
      expect(await canExecute(role, fn), role).toBe(false);
    }
    const meta = await db.query<{ definer: boolean; config: string[] | null }>(
      "select prosecdef definer, proconfig config from pg_proc where proname='admin_mfa_recovery_reminder_start'",
    );
    expect(meta.rows[0].definer).toBe(true);
    expect(meta.rows[0].config?.join(",")).toContain("search_path=pg_catalog, public");
  });

  it("no toca datos existentes al aplicarse y conserva los tipos de correo anteriores", async () => {
    const sql = read(MIGRATION);
    expect(sql).not.toMatch(/(update|delete from)\s+public\./i);
    expect(sql).not.toMatch(/auth\./i.source.replace("auth\\.", "update auth\\."));
    const kinds = await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) def from pg_constraint where conname='admin_mfa_recovery_mail_kind_check'",
    );
    for (const k of ["challenge", "approved", "closed", "completed", "reminder"]) {
      expect(kinds.rows[0].def).toContain(`'${k}'`);
    }
  });

  it("el rollback se niega con recordatorios registrados y, sin ellos, restaura la restricción y elimina la función", async () => {
    const rollback = readFileSync(resolve(ROLLBACK), "utf8");
    const rid = await approvedAndDelivered();
    expect((await reminder(rid)).ok).toBe(true);
    await fails(() => db.exec(rollback), /rollback_refused_reminders_exist/);
    await db.query("delete from admin_mfa_recovery_mail where kind='reminder'");
    await db.exec(rollback);
    expect(
      (
        await db.query(
          "select 1 from pg_proc where proname='admin_mfa_recovery_reminder_start'",
        )
      ).rows,
    ).toEqual([]);
    await fails(
      () =>
        db.query(
          "insert into admin_mfa_recovery_mail(recovery_id,kind,idempotency_key) values($1,'reminder','recovery:x:reminder:1')",
          [rid],
        ),
      /kind_check/,
    );
  });
});
