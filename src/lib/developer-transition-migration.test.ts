// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "./community-atomic-save-test-db";

// Developer Panel V1 — transición Admin → Developer por AUTOTRANSFERENCIA. SQL REAL (PGlite) de la
// migración 20261102120000 sobre la cadena real de admin, MFA fase 1 y 2 y Developer Panel V1.
// auth.* son solo la FORMA mínima que usa la migración. No prueba Supabase Auth, GoTrue ni Resend.

const MIGRATION = "20261102120000_developer_transition.sql";
const ROLLBACK = "supabase/rollbacks/20261102120000_developer_transition.rollback.sql";
const CHAIN = [
  "20260922120000_admin_roles.sql",
  "20260923120000_admin_invitations.sql",
  "20260926120000_admin_team_roles_invariants.sql",
  "20260927120000_admin_team_invitation_revoke.sql",
  "20260928120000_admin_team_member_management.sql",
  "20261031140000_admin_mfa_reset.sql",
  "20261031150000_admin_mfa_recovery.sql",
  "20261101120000_developer_panel.sql",
  MIGRATION,
];
const read = (name: string) => readFileSync(resolve("supabase/migrations", name), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const id = (n: number, tag = "a") =>
  `${tag.repeat(8)}-${tag.repeat(4)}-4${tag.repeat(3)}-8${tag.repeat(3)}-${String(n).padStart(12, "0")}`;
const ADMIN = id(1);
const ADMIN2 = id(2);
const MOD = id(3);
const DEVELOPER = id(4); // Developer «heredado» (sin transferencia registrada: sin espera)
const NOBODY = id(5);
const ADMIN_F = id(104, "f");
const ADMIN2_F = id(105, "f");
const MOD_F = id(106, "f");
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
    [NOBODY, "nobody@example.test"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [n, email]);
  }
  await db.exec(`set local session_replication_role = replica;`);
  await db.query(
    "insert into admin_roles(user_id,role) values($1,'admin'),($2,'admin'),($3,'moderator'),($4,'developer')",
    [ADMIN, ADMIN2, MOD, DEVELOPER],
  );
  await db.exec(`set local session_replication_role = origin;`);
  for (const [fid, user] of [
    [ADMIN_F, ADMIN],
    [ADMIN2_F, ADMIN2],
    [MOD_F, MOD],
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
const transfer = (actor: string) => call("admin_transfer_self_to_developer($1)", [actor]);
const status = (actor: string) => call("admin_transfer_status($1)", [actor]);
const restore = (actor: string, target: string, role: string) =>
  call("admin_restore_developer($1,$2,$3)", [actor, target, role]);
const cooldown = (actor: string) => call("admin_developer_cooldown($1)", [actor]);
const setCooldown = (minutes: number | null, note = "DEV inicial") =>
  call("operator_set_developer_cooldown($1,$2)", [minutes, note]);
const create = (user: string, hash = T1) =>
  call("admin_mfa_recovery_create($1,$2)", [user, hash]);
const verify = (user: string, hash = T1) =>
  call("admin_mfa_recovery_verify($1,$2)", [user, hash]);
const approve = (rid: string, actor: string, h = CANCEL) =>
  call("admin_mfa_recovery_approve($1,$2,$3)", [rid, actor, h]);
const approveEx = (rid: string, actor: string, h = CANCEL) =>
  call("admin_mfa_recovery_approve_exceptional($1,$2,$3)", [rid, actor, h]);
const denyEx = (rid: string, actor: string, reason = "No es el titular") =>
  call("admin_mfa_recovery_deny_exceptional($1,$2,$3)", [rid, actor, reason]);
const roleOf = async (user: string) =>
  (
    await db.query<{ role: string }>("select role from admin_roles where user_id=$1", [
      user,
    ])
  ).rows[0]?.role;
const audit = async () =>
  (
    await db.query<Record<string, unknown>>(
      "select action, target_user_id, actor_user_id, previous_role, new_role, operator_note from admin_developer_audit order by created_at, id",
    )
  ).rows;
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

/** Viaje en el tiempo del inicio de la espera: la auditoría es append-only, se desactiva solo aquí. */
async function shiftAnchor(user: string, interval: string) {
  await db.exec(
    "alter table admin_developer_audit disable trigger admin_developer_audit_append_only",
  );
  await db.query(
    `update admin_developer_audit set created_at = clock_timestamp() - $2::interval
      where target_user_id = $1 and action = 'self_transferred'
        and created_at = (select max(created_at) from admin_developer_audit where target_user_id = $1 and action = 'self_transferred')`,
    [user, interval],
  );
  await db.exec(
    "alter table admin_developer_audit enable trigger admin_developer_audit_append_only",
  );
}
async function pendingFor(user: string): Promise<string> {
  const c = await create(user);
  expect(c.ok).toBe(true);
  expect((await verify(user)).ok).toBe(true);
  return c.recoveryId as string;
}
/** ADMIN2 se transfiere: ADMIN queda como único admin y ADMIN2 como Developer RECIÉN transferido. */
async function transferAdmin2() {
  expect((await transfer(ADMIN2)).ok).toBe(true);
}

describe("autotransferencia Admin → Developer", () => {
  it("transfiere SOLO al propio actor: rol, auditoría con actor = objetivo, invitaciones revocadas", async () => {
    await db.query(
      "insert into admin_invitations(token_hash, role, invitation_type, created_by, expires_at) values($1,'moderator','standard',$2, now() + interval '1 day')",
      [sha("inv-pendiente"), ADMIN2],
    );
    const out = await transfer(ADMIN2);
    expect(out).toMatchObject({ ok: true });
    expect(await roleOf(ADMIN2)).toBe("developer");
    expect(await roleOf(ADMIN)).toBe("admin"); // nadie más cambia
    expect(await audit()).toEqual([
      {
        action: "self_transferred",
        target_user_id: ADMIN2,
        actor_user_id: ADMIN2,
        previous_role: "admin",
        new_role: "developer",
        operator_note: null,
      },
    ]);
    const inv = await db.query<{ revoked_at: string | null }>(
      "select revoked_at from admin_invitations where token_hash=$1",
      [sha("inv-pendiente")],
    );
    expect(inv.rows[0].revoked_at).not.toBeNull();
    // fecha fiable de la transferencia en la respuesta y en la auditoría
    expect(typeof out.transferredAt).toBe("string");
  });

  it("no hay parámetro de objetivo: la función solo recibe al actor", async () => {
    const r = await db.query<{ n: number }>(
      "select pronargs n from pg_proc where proname='admin_transfer_self_to_developer'",
    );
    expect(r.rows[0].n).toBe(1);
    // inyectar otro usuario como «actor» solo afecta a ESE usuario si fuera admin; un no admin falla
    for (const user of [MOD, DEVELOPER, NOBODY]) {
      await fails(() => transfer(user), /actor_not_admin/);
    }
    expect(await roleOf(MOD)).toBe("moderator");
    expect(await roleOf(DEVELOPER)).toBe("developer");
    expect(await audit()).toEqual([]);
  });

  it("la cuenta pierde de inmediato las capacidades de Admin y gana las de Developer", async () => {
    await transferAdmin2();
    await fails(
      () => call("admin_mfa_recoveries_pending($1)", [ADMIN2]),
      /actor_not_admin/,
    );
    await fails(
      () =>
        db.query("select * from change_admin_member_role($1,$2,'moderator')", [
          ADMIN2,
          MOD,
        ]),
      /actor_not_admin/,
    );
    await fails(() => transfer(ADMIN2), /actor_not_admin/); // ya no es admin: no se repite
    expect(
      (await db.query("select * from admin_mfa_cleanups_for_developer($1)", [ADMIN2]))
        .rows,
    ).toEqual([]);
    expect(await cooldown(ADMIN2)).toMatchObject({ ready: false });
  });

  it("exige OTRO admin elegible: único admin, sin TOTP, TOTP sin verificar, bloqueado o eliminado", async () => {
    await db.query("update admin_roles set role='moderator' where user_id=$1", [ADMIN2]);
    expect(await transfer(ADMIN)).toMatchObject({
      ok: false,
      reason: "no_eligible_peer",
    });
    expect(await roleOf(ADMIN)).toBe("admin");
    await db.query("update admin_roles set role='admin' where user_id=$1", [ADMIN2]);

    await db.query("delete from auth.mfa_factors where id=$1", [ADMIN2_F]);
    expect(await transfer(ADMIN)).toMatchObject({
      ok: false,
      reason: "no_eligible_peer",
    });
    await db.query(
      "insert into auth.mfa_factors(id,user_id,status) values($1,$2,'unverified')",
      [id(107, "f"), ADMIN2],
    );
    expect(await transfer(ADMIN)).toMatchObject({
      ok: false,
      reason: "no_eligible_peer",
    });
    await db.query("update auth.mfa_factors set status='verified' where user_id=$1", [
      ADMIN2,
    ]);
    await db.query(
      "update auth.users set banned_until = now() + interval '1 day' where id=$1",
      [ADMIN2],
    );
    expect(await transfer(ADMIN)).toMatchObject({
      ok: false,
      reason: "no_eligible_peer",
    });
    await db.query(
      "update auth.users set banned_until = null, deleted_at = now() where id=$1",
      [ADMIN2],
    );
    expect(await transfer(ADMIN)).toMatchObject({
      ok: false,
      reason: "no_eligible_peer",
    });
    expect(await roleOf(ADMIN)).toBe("admin");
    expect(await audit()).toEqual([]);
  });

  it("se bloquea mientras exista CUALQUIER recuperación de MFA activa de un Admin (propia o ajena)", async () => {
    const own = await create(ADMIN);
    expect(own.ok).toBe(true);
    expect(await transfer(ADMIN)).toMatchObject({
      ok: false,
      reason: "recovery_in_progress",
    });
    expect(await transfer(ADMIN2)).toMatchObject({
      ok: false,
      reason: "recovery_in_progress",
    }); // ajena
    expect(await status(ADMIN2)).toMatchObject({
      eligible: false,
      reason: "recovery_in_progress",
    });
    // una solicitud de un moderator no bloquea
    await call("admin_mfa_recovery_cancel($1,$2)", [own.recoveryId, ADMIN]);
    const mod = await create(MOD, sha("t-mod"));
    expect(mod.ok).toBe(true);
    expect(await status(ADMIN2)).toMatchObject({ eligible: true, reason: "ok" });
    // y una solicitud ya cerrada tampoco
    expect((await transfer(ADMIN2)).ok).toBe(true);
  });

  it("dos transferencias seguidas: la segunda no puede dejar al sistema sin Admin", async () => {
    await transferAdmin2();
    expect(await status(ADMIN)).toMatchObject({
      eligible: false,
      reason: "no_eligible_peer",
    });
    expect(await transfer(ADMIN)).toMatchObject({
      ok: false,
      reason: "no_eligible_peer",
    });
    expect(await roleOf(ADMIN)).toBe("admin");
    // red de seguridad de la base: el guard del último admin sigue activo aunque se saltara la comprobación
    await fails(
      () => db.query("update admin_roles set role='developer' where user_id=$1", [ADMIN]),
      /last_admin_protected/,
    );
  });

  it("toma el lock de roles ANTES de cualquier FOR UPDATE (transferencia, restauración, aprobación, rechazo y alta de solicitud)", async () => {
    for (const fn of [
      "public.admin_transfer_self_to_developer(uuid)",
      "public.admin_restore_developer(uuid,uuid,text)",
      "public.admin_mfa_recovery_approve(uuid,uuid,text)",
      "public.admin_mfa_recovery_deny(uuid,uuid,text)",
      "public.admin_mfa_recovery_create(uuid,text)",
      "public.admin_mfa_recovery_approve_exceptional(uuid,uuid,text)",
      "public.admin_mfa_recovery_deny_exceptional(uuid,uuid,text)",
    ]) {
      const def = (
        await db.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) d", [
          fn,
        ])
      ).rows[0].d;
      const lock = def.indexOf("upmina_lock_admin_roles");
      expect(lock, fn).toBeGreaterThan(-1);
      const forUpdate = def.indexOf("for update");
      if (forUpdate !== -1) expect(lock, fn).toBeLessThan(forUpdate);
    }
  });

  it("estado para la interfaz: elegible, sin otro admin, recuperación en curso; un no admin no lo consulta", async () => {
    expect(await status(ADMIN)).toEqual({ eligible: true, reason: "ok" });
    await db.query("update admin_roles set role='moderator' where user_id=$1", [ADMIN2]);
    expect(await status(ADMIN)).toEqual({ eligible: false, reason: "no_eligible_peer" });
    await fails(() => status(MOD), /actor_not_admin/);
    await fails(() => status(DEVELOPER), /actor_not_admin/);
  });
});

describe("restauración de un Developer por otro Admin", () => {
  it("restaura a Moderator o a Admin con auditoría (actor ≠ objetivo)", async () => {
    await db.query("insert into auth.mfa_factors(id,user_id) values($1,$2)", [
      id(108, "f"),
      DEVELOPER,
    ]);
    expect(await restore(ADMIN, DEVELOPER, "moderator")).toMatchObject({
      ok: true,
      newRole: "moderator",
    });
    expect(await roleOf(DEVELOPER)).toBe("moderator");
    await db.query("update admin_roles set role='developer' where user_id=$1", [
      DEVELOPER,
    ]); // fixture
    expect(await restore(ADMIN2, DEVELOPER, "admin")).toMatchObject({
      ok: true,
      newRole: "admin",
    });
    expect(await roleOf(DEVELOPER)).toBe("admin");
    const rows = await audit();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: "restored",
      actor_user_id: ADMIN,
      new_role: "moderator",
    });
    expect(rows[1]).toMatchObject({
      action: "restored",
      actor_user_id: ADMIN2,
      new_role: "admin",
    });
  });

  it("un Developer no puede cambiar su propio rol ni el de otros; un Admin no lo hace con el cambio de rol normal", async () => {
    await fails(() => restore(DEVELOPER, DEVELOPER, "admin"), /actor_not_admin/);
    await fails(() => restore(DEVELOPER, MOD, "moderator"), /actor_not_admin/);
    await fails(
      () =>
        db.query("select * from change_admin_member_role($1,$2,'admin')", [
          DEVELOPER,
          DEVELOPER,
        ]),
      /actor_not_admin/,
    );
    await fails(
      () =>
        db.query("select * from change_admin_member_role($1,$2,'moderator')", [
          ADMIN,
          DEVELOPER,
        ]),
      /developer_protected/,
    );
    await fails(
      () =>
        db.query("select * from change_admin_member_role($1,$2,'developer')", [
          ADMIN,
          MOD,
        ]),
      /developer_protected/,
    );
    expect(await roleOf(DEVELOPER)).toBe("developer");
    expect(await audit()).toEqual([]);
  });

  it("nunca restaura a developer ni a roles inventados; un Admin no se «restaura» a sí mismo", async () => {
    await fails(() => restore(ADMIN, DEVELOPER, "developer"), /invalid_role/);
    await fails(() => restore(ADMIN, DEVELOPER, "user"), /invalid_role/);
    await fails(() => restore(ADMIN, ADMIN, "moderator"), /self_change_not_allowed/);
    expect(await restore(ADMIN, MOD, "admin")).toMatchObject({
      ok: false,
      reason: "not_developer",
    });
    expect(await restore(ADMIN, NOBODY, "admin")).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await roleOf(MOD)).toBe("moderator");
  });

  it("bloquea con una recuperación activa del objetivo y exige TOTP verificado para volver a Admin", async () => {
    const c = await create(DEVELOPER);
    expect(c.ok).toBe(true);
    expect(await restore(ADMIN, DEVELOPER, "moderator")).toMatchObject({
      ok: false,
      reason: "recovery_in_progress",
    });
    await call("admin_mfa_recovery_cancel($1,$2)", [c.recoveryId, DEVELOPER]);
    // sin TOTP verificado: Moderator sí, Admin no
    expect(await restore(ADMIN, DEVELOPER, "admin")).toMatchObject({
      ok: false,
      reason: "mfa_not_enrolled",
    });
    expect(await restore(ADMIN, DEVELOPER, "moderator")).toMatchObject({ ok: true });
  });

  it("los cambios normales Admin ↔ Moderator siguen igual y se auditan en admin_team_audit", async () => {
    const up = await db.query<{ out_new_role: string }>(
      "select * from change_admin_member_role($1,$2,'admin')",
      [ADMIN, MOD],
    );
    expect(up.rows[0].out_new_role).toBe("admin");
    await db.query("select * from change_admin_member_role($1,$2,'moderator')", [
      ADMIN,
      MOD,
    ]);
    const teamAudit = await db.query<{ action: string }>(
      "select action from admin_team_audit where target_user_id=$1 order by created_at",
      [MOD],
    );
    expect(teamAudit.rows.map((r) => r.action)).toEqual(["role_changed", "role_changed"]);
    expect(await audit()).toEqual([]); // la auditoría de Developer solo recoge transiciones de Developer
  });
});

describe("espera de seguridad antes de aprobar recuperaciones excepcionales", () => {
  /** ADMIN (único admin) pide la recuperación; ADMIN2, ya Developer, es quien podría aprobar. */
  async function scenario() {
    await transferAdmin2();
    return pendingFor(ADMIN);
  }

  it("sin configuración el valor por defecto es CONSERVADOR (24 h): la migración no fija 60 en ningún entorno", async () => {
    await transferAdmin2();
    const settings = await db.query("select * from admin_developer_settings");
    expect(settings.rows).toEqual([]);
    const c = await cooldown(ADMIN2);
    expect(c).toMatchObject({ ready: false, cooldownMinutes: 1440 });
    expect(Number(c.remainingSeconds)).toBeGreaterThan(86390);
    expect(Number(c.remainingSeconds)).toBeLessThanOrEqual(86400);
  });

  it("60 min configurados: antes de cumplirse se rechaza (cooldown_active) sin tocar la solicitud ni registrar nada", async () => {
    expect(await setCooldown(60)).toMatchObject({
      ok: true,
      previous: null,
      minutes: 60,
    });
    const rid = await scenario();
    const before = (
      await db.query("select count(*)::int n from admin_mfa_recovery_events")
    ).rows[0];
    expect(await approveEx(rid, ADMIN2)).toMatchObject({
      ok: false,
      reason: "cooldown_active",
    });
    await shiftAnchor(ADMIN2, "59 minutes 59 seconds");
    const blocked = await approveEx(rid, ADMIN2);
    expect(blocked).toMatchObject({ ok: false, reason: "cooldown_active" });
    expect(typeof blocked.readyAt).toBe("string");
    const row = (
      await db.query(
        "select status, approved_by, approval_kind from admin_mfa_recoveries where id=$1",
        [rid],
      )
    ).rows[0];
    expect(row).toMatchObject({
      status: "pending_approval",
      approved_by: null,
      approval_kind: "peer",
    });
    expect(
      (await db.query("select count(*)::int n from admin_mfa_recovery_events")).rows[0],
    ).toEqual(before);
  });

  it("exactamente al cumplirse los 60 min y después, la aprobación excepcional se permite", async () => {
    await setCooldown(60);
    const rid = await scenario();
    await shiftAnchor(ADMIN2, "60 minutes"); // la espera termina justo ahora (o antes): se cumple
    expect(await cooldown(ADMIN2)).toMatchObject({ ready: true, remainingSeconds: 0 });
    expect(await approveEx(rid, ADMIN2)).toMatchObject({ ok: true });
    const row = (
      await db.query(
        "select status, approver_role from admin_mfa_recoveries where id=$1",
        [rid],
      )
    ).rows[0];
    expect(row).toMatchObject({ status: "approved", approver_role: "developer" });
  });

  it("pasados 61 minutos también; el estado de la espera lo informa el servidor (ready, readyAt, remainingSeconds)", async () => {
    await setCooldown(60);
    await transferAdmin2();
    await shiftAnchor(ADMIN2, "10 minutes");
    const mid = await cooldown(ADMIN2);
    expect(mid).toMatchObject({ ready: false, cooldownMinutes: 60 });
    expect(Number(mid.remainingSeconds)).toBeGreaterThan(49 * 60);
    expect(Number(mid.remainingSeconds)).toBeLessThanOrEqual(50 * 60);
    await shiftAnchor(ADMIN2, "61 minutes");
    expect(await cooldown(ADMIN2)).toMatchObject({ ready: true, remainingSeconds: 0 });
  });

  it("recargar, abrir otra sesión o reintentar NO reinicia la espera: el inicio es la fila de auditoría", async () => {
    await setCooldown(60);
    const rid = await scenario();
    await shiftAnchor(ADMIN2, "30 minutes");
    const first = (await cooldown(ADMIN2)).readyAt;
    for (let i = 0; i < 3; i++) {
      await approveEx(rid, ADMIN2); // reintentos rechazados
      expect((await cooldown(ADMIN2)).readyAt).toBe(first);
    }
    expect(
      (await db.query("select count(*)::int n from admin_developer_audit")).rows[0].n,
    ).toBe(1);
  });

  it("restaurar y volver a transferirse genera un inicio NUEVO: no permite eludir la espera", async () => {
    await setCooldown(60);
    await transferAdmin2();
    await shiftAnchor(ADMIN2, "120 minutes"); // la primera espera ya había terminado
    expect(await cooldown(ADMIN2)).toMatchObject({ ready: true });
    expect(await restore(ADMIN, ADMIN2, "admin")).toMatchObject({ ok: true }); // vuelve a Admin
    expect(await transfer(ADMIN2)).toMatchObject({ ok: true }); // y se transfiere otra vez
    const again = await cooldown(ADMIN2);
    expect(again).toMatchObject({ ready: false });
    expect(Number(again.remainingSeconds)).toBeGreaterThan(59 * 60);
    const rid = await pendingFor(ADMIN);
    expect(await approveEx(rid, ADMIN2)).toMatchObject({
      ok: false,
      reason: "cooldown_active",
    });
    expect(
      (
        await db.query(
          "select count(*)::int n from admin_developer_audit where action='self_transferred'",
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it("cambiar la espera afecta a los Developers existentes (usa el valor vigente) y queda auditado", async () => {
    await setCooldown(60);
    await transferAdmin2();
    await shiftAnchor(ADMIN2, "90 minutes");
    expect(await cooldown(ADMIN2)).toMatchObject({ ready: true });
    expect(await setCooldown(120, "endurecer")).toMatchObject({
      previous: 60,
      minutes: 120,
    });
    expect(await cooldown(ADMIN2)).toMatchObject({ ready: false, cooldownMinutes: 120 });
    const log = await db.query<Record<string, unknown>>(
      "select old_value, new_value, note from admin_developer_settings_audit order by created_at, id",
    );
    expect(log.rows).toEqual([
      { old_value: null, new_value: 60, note: "DEV inicial" },
      { old_value: 60, new_value: 120, note: "endurecer" },
    ]);
  });

  it("rechazar y revertir NO están sujetos a la espera (solo restringen)", async () => {
    await setCooldown(60);
    const rid = await scenario();
    expect(await denyEx(rid, ADMIN2)).toMatchObject({ ok: true });
    expect(await cooldown(ADMIN2)).toMatchObject({ ready: false }); // sigue en espera
  });

  it("un Developer sin transferencia registrada (heredado) no tiene espera", async () => {
    await db.query("update admin_roles set role='moderator' where user_id=$1", [ADMIN2]);
    const rid = await pendingFor(ADMIN);
    expect(await cooldown(DEVELOPER)).toMatchObject({ ready: true, readyAt: null });
    expect(await approveEx(rid, DEVELOPER)).toMatchObject({ ok: true });
  });

  it("el cliente no puede manipularla: sin parámetro de tiempo, la configuración no es escribible por la API y la validación es estricta", async () => {
    const r = await db.query<{ n: number }>(
      "select pronargs n from pg_proc where proname='admin_mfa_recovery_approve_exceptional'",
    );
    expect(r.rows[0].n).toBe(3); // solicitud, actor y hash: nada de tiempo
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of [
        "admin_developer_settings",
        "admin_developer_settings_audit",
        "admin_developer_audit",
      ]) {
        for (const priv of ["select", "insert", "update", "delete"]) {
          const q = await db.query<{ ok: boolean }>(
            "select has_table_privilege($1, $2, $3) ok",
            [role, `public.${table}`, priv],
          );
          expect(q.rows[0].ok, `${role} ${priv} ${table}`).toBe(false);
        }
      }
    }
    for (const bad of [-1, 10081, null]) {
      await fails(() => setCooldown(bad as number), /invalid_argument/);
    }
    await fails(() => setCooldown(60, "  "), /invalid_argument/);
    await fails(() => setCooldown(60, "x".repeat(81)), /invalid_argument/);
    expect((await db.query("select * from admin_developer_settings")).rows).toEqual([]);
    await fails(() => cooldown(MOD), /actor_not_developer/);
    await fails(() => cooldown(ADMIN), /actor_not_developer/);
  });
});

describe("permisos, auditoría y retirada del alta por el operador", () => {
  it("las funciones nuevas solo las ejecuta service_role; las de operador y las internas, nadie", async () => {
    for (const fn of [
      "public.admin_transfer_self_to_developer(uuid)",
      "public.admin_transfer_status(uuid)",
      "public.admin_restore_developer(uuid,uuid,text)",
      "public.admin_developer_cooldown(uuid)",
    ]) {
      expect(await canExecute("service_role", fn), fn).toBe(true);
      for (const role of ["public", "anon", "authenticated"]) {
        expect(await canExecute(role, fn), `${role} ${fn}`).toBe(false);
      }
    }
    for (const fn of [
      "public.operator_set_developer_cooldown(integer,text)",
      "public.operator_revoke_developer(uuid,text)",
      "public.admin_developer_cooldown_minutes()",
      "public.admin_developer_cooldown_ready_at(uuid)",
    ]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(await canExecute(role, fn), `${role} ${fn}`).toBe(false);
      }
    }
  });

  it("las funciones reemplazadas conservan sus permisos", async () => {
    for (const fn of [
      "public.admin_mfa_recovery_approve(uuid,uuid,text)",
      "public.admin_mfa_recovery_deny(uuid,uuid,text)",
      "public.admin_mfa_recovery_create(uuid,text)",
      "public.admin_mfa_recovery_approve_exceptional(uuid,uuid,text)",
    ]) {
      expect(await canExecute("service_role", fn), fn).toBe(true);
      for (const role of ["public", "anon", "authenticated"]) {
        expect(await canExecute(role, fn), `${role} ${fn}`).toBe(false);
      }
    }
  });

  it("operator_grant_developer ya no existe; operator_revoke_developer se conserva como emergencia y audita", async () => {
    const gone = await db.query(
      "select 1 from pg_proc where proname='operator_grant_developer'",
    );
    expect(gone.rows).toEqual([]);
    expect(
      await call("operator_revoke_developer($1,$2)", [DEVELOPER, "emergencia"]),
    ).toMatchObject({
      ok: true,
      new_role: "moderator",
    });
    expect(await roleOf(DEVELOPER)).toBe("moderator");
    expect(await audit()).toEqual([
      {
        action: "revoked",
        target_user_id: DEVELOPER,
        actor_user_id: null,
        previous_role: "developer",
        new_role: "moderator",
        operator_note: "emergencia",
      },
    ]);
  });

  it("la forma de la auditoría rechaza combinaciones inválidas y es append-only", async () => {
    await db.exec("savepoint s");
    await fails(
      () =>
        db.query(
          "insert into admin_developer_audit(action,target_user_id,actor_user_id,previous_role,new_role) values('self_transferred',$1,$2,'admin','developer')",
          [ADMIN, ADMIN2], // actor distinto del objetivo
        ),
      /shape_check|check constraint/,
    );
    await fails(
      () =>
        db.query(
          "insert into admin_developer_audit(action,target_user_id,actor_user_id,previous_role,new_role) values('restored',$1,$1,'developer','admin')",
          [ADMIN], // actor igual al objetivo
        ),
      /shape_check|check constraint/,
    );
    await fails(
      () =>
        db.query(
          "insert into admin_developer_audit(action,target_user_id,actor_user_id,previous_role,new_role) values('restored',$1,$2,'developer','developer')",
          [DEVELOPER, ADMIN], // nunca se restaura a developer
        ),
      /shape_check|check constraint/,
    );
    await transferAdmin2();
    await fails(
      () => db.query("update admin_developer_audit set new_role='admin'"),
      /developer_audit_append_only/,
    );
    await fails(
      () => db.query("delete from admin_developer_audit"),
      /developer_audit_append_only/,
    );
    await db.exec("release savepoint s");
  });

  it("regresión de la fase 2: la aprobación normal entre Admins sigue funcionando y toma el lock sin cambiar su resultado", async () => {
    const rid = await pendingFor(MOD);
    expect(await approve(rid, ADMIN)).toMatchObject({ ok: true });
    const row = (
      await db.query(
        "select approval_kind, approver_role from admin_mfa_recoveries where id=$1",
        [rid],
      )
    ).rows[0];
    expect(row).toMatchObject({ approval_kind: "peer", approver_role: null });
    // una solicitud de un Admin con otro admin elegible: la aprobación excepcional sigue rechazada
    const adminReq = await pendingFor(ADMIN);
    expect(await approveEx(adminReq, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "peer_available",
    });
    expect(await approve(adminReq, ADMIN2, sha("cancel-token-2"))).toMatchObject({
      ok: true,
    });
  });
});

describe("rollback", () => {
  const rollback = () => readFileSync(resolve(ROLLBACK), "utf8");

  it("se niega con transiciones registradas o con la espera configurada", async () => {
    await setCooldown(60);
    await fails(() => db.exec(rollback()), /rollback_refused_developer_settings_exist/);
  });

  it("se niega con una autotransferencia registrada", async () => {
    await transferAdmin2();
    await fails(
      () => db.exec(rollback()),
      /rollback_refused_developer_transitions_exist/,
    );
  });

  it("sin historial restaura operator_grant_developer, la forma anterior de la auditoría y las funciones previas", async () => {
    await db.exec(rollback());
    const grant = await db.query(
      "select 1 from pg_proc where proname='operator_grant_developer'",
    );
    expect(grant.rows).toHaveLength(1);
    expect(
      await canExecute("service_role", "public.operator_grant_developer(uuid,text)"),
    ).toBe(false);
    const gone = await db.query(
      "select proname from pg_proc where proname in ('admin_transfer_self_to_developer','admin_restore_developer','admin_developer_cooldown','operator_set_developer_cooldown','admin_developer_cooldown_ready_at')",
    );
    expect(gone.rows).toEqual([]);
    const cols = await db.query(
      "select column_name from information_schema.columns where table_name='admin_developer_audit' and column_name='actor_user_id'",
    );
    expect(cols.rows).toEqual([]);
    // la aprobación excepcional vuelve a su versión sin espera
    await db.query("update admin_roles set role='moderator' where user_id=$1", [ADMIN2]);
    const rid = await pendingFor(ADMIN);
    expect(await approveEx(rid, DEVELOPER)).toMatchObject({ ok: true });
  });
});
