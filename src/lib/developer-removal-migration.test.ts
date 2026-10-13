// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "./community-atomic-save-test-db";

// Developer Panel V1 — «Quitar acceso» a un Developer, con la limpieza MFA de la fase 1 (admin_mfa_resets). SQL REAL (PGlite) de la migración 20261103120000 sobre la
// cadena real de admin, MFA fase 1 y 2, Developer Panel V1 y transición. auth.* son solo la FORMA mínima que
// usa la migración. No prueba Supabase Auth, GoTrue ni Resend.

const MIGRATION = "20261103120000_developer_removal.sql";
const ROLLBACK = "supabase/rollbacks/20261103120000_developer_removal.rollback.sql";
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
const DEVELOPER2 = id(5);
const NOBODY = id(6);
const GHOST = id(99);
const T1 = sha("token-1");
const T2 = sha("token-2");
const CANCEL = sha("cancel-token-1");
const FACTORS: Record<string, string> = {
  [ADMIN]: id(104, "f"),
  [ADMIN2]: id(105, "f"),
  [MOD]: id(106, "f"),
  [DEVELOPER]: id(107, "f"),
  [DEVELOPER2]: id(108, "f"),
};

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
    [DEVELOPER2, "dev2@example.test"],
    [NOBODY, "nobody@example.test"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [n, email]);
    await db.query("insert into profiles(user_id,username) values($1,$2)", [
      n,
      `u_${String(n).slice(-3)}`,
    ]);
  }
  await db.exec(`set local session_replication_role = replica;`);
  await db.query(
    "insert into admin_roles(user_id,role) values($1,'admin'),($2,'admin'),($3,'moderator'),($4,'developer')",
    [ADMIN, ADMIN2, MOD, DEVELOPER],
  );
  await db.exec(`set local session_replication_role = origin;`);
  for (const user of [ADMIN, ADMIN2, MOD, DEVELOPER, DEVELOPER2]) {
    await db.query("insert into auth.mfa_factors(id,user_id) values($1,$2)", [
      FACTORS[user],
      user,
    ]);
  }
});
afterEach(async () => {
  await db.exec("reset role;rollback");
});

type J = Record<string, unknown>;
const call = async (sql: string, params: unknown[]): Promise<J> =>
  (await db.query<{ r: J }>(`select ${sql} r`, params)).rows[0].r;
const removeDev = (actor: string, target: string) =>
  call("admin_remove_developer($1,$2)", [actor, target]);
const restore = (actor: string, target: string, role: string) =>
  call("admin_restore_developer($1,$2,$3)", [actor, target, role]);
const transfer = (actor: string) => call("admin_transfer_self_to_developer($1)", [actor]);
const create = (user: string, hash = T1) =>
  call("admin_mfa_recovery_create($1,$2)", [user, hash]);
const verify = (user: string, hash = T1) =>
  call("admin_mfa_recovery_verify($1,$2)", [user, hash]);
const approveEx = (rid: string, actor: string, h = CANCEL) =>
  call("admin_mfa_recovery_approve_exceptional($1,$2,$3)", [rid, actor, h]);
const roleOf = async (user: string) =>
  (
    await db.query<{ role: string }>("select role from admin_roles where user_id=$1", [
      user,
    ])
  ).rows[0]?.role;
const developerAudit = async () =>
  (
    await db.query<Record<string, unknown>>(
      "select action, target_user_id, actor_user_id, previous_role, new_role, operator_note from admin_developer_audit order by created_at, id",
    )
  ).rows;
const teamAudit = async () =>
  (
    await db.query<Record<string, unknown>>(
      "select action, actor_user_id, target_user_id, old_role, new_role from admin_team_audit order by created_at, id",
    )
  ).rows;
const count = async (table: string, where = "true") =>
  (await db.query<{ n: number }>(`select count(*)::int n from ${table} where ${where}`))
    .rows[0].n;
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
const dropSecondAdmin = () =>
  db.query("update admin_roles set role='moderator' where user_id=$1", [ADMIN2]);
async function addDeveloper2() {
  await db.exec(`set local session_replication_role = replica;`);
  await db.query("insert into admin_roles(user_id,role) values($1,'developer')", [
    DEVELOPER2,
  ]);
  await db.exec(`set local session_replication_role = origin;`);
}
async function pendingFor(user: string, hash = T1): Promise<string> {
  const c = await create(user, hash);
  expect(c.ok).toBe(true);
  expect((await verify(user, hash)).ok).toBe(true);
  return c.recoveryId as string;
}
const DEV_FN = "public.admin_remove_developer(uuid,uuid)";

describe("quitar acceso a un Developer", () => {
  it("retira SOLO el rol: auditoría 'removed' exacta, historial de equipo y cuenta, perfil y factores intactos", async () => {
    await db.exec("set local session_replication_role = replica");
    await db.query(
      "insert into admin_invitations(id,token_hash,role,invitation_type,created_by,expires_at) values($1,$2,'moderator','standard',$3,now()+interval '1 day')",
      [id(500), sha("inv-dev"), DEVELOPER],
    );
    await db.exec("set local session_replication_role = origin");
    const usersBefore = await count("auth.users");
    const factorsBefore = (
      await db.query("select id,user_id,status from auth.mfa_factors order by id")
    ).rows;
    const profilesBefore = (await db.query("select * from profiles order by user_id"))
      .rows;

    const out = await removeDev(ADMIN, DEVELOPER);
    expect(out).toMatchObject({ ok: true, lastDeveloper: true, revokedInvitations: 1 });
    expect(await roleOf(DEVELOPER)).toBeUndefined();
    // resto del equipo intacto
    expect(await roleOf(ADMIN)).toBe("admin");
    expect(await roleOf(ADMIN2)).toBe("admin");
    expect(await roleOf(MOD)).toBe("moderator");

    expect(await developerAudit()).toEqual([
      {
        action: "removed",
        target_user_id: DEVELOPER,
        actor_user_id: ADMIN,
        previous_role: "developer",
        new_role: null,
        operator_note: null,
      },
    ]);
    expect(await teamAudit()).toEqual([
      {
        action: "access_removed",
        actor_user_id: ADMIN,
        target_user_id: DEVELOPER,
        old_role: "developer",
        new_role: null,
      },
    ]);
    // la cuenta personal y el perfil se conservan; los factores los borra DESPUÉS el backend (la función no toca auth)
    expect(await count("auth.users")).toBe(usersBefore);
    expect(
      (await db.query("select id,user_id,status from auth.mfa_factors order by id")).rows,
    ).toEqual(factorsBefore);
    expect((await db.query("select * from profiles order by user_id")).rows).toEqual(
      profilesBefore,
    );
    // …pero la limpieza MFA nace en la MISMA transacción: instantánea exacta y pendiente
    expect(out).toMatchObject({ mfaFactorCount: 1 });
    const resets = await db.query(
      "select id, user_id, kind, status, old_role, requested_by, factor_ids, completed_at, factors_deleted, attempts from admin_mfa_resets",
    );
    expect(resets.rows).toEqual([
      {
        id: out.mfaResetId,
        user_id: DEVELOPER,
        kind: "role_removed",
        status: "pending",
        old_role: "developer",
        requested_by: ADMIN,
        factor_ids: [FACTORS[DEVELOPER]],
        completed_at: null,
        factors_deleted: null,
        attempts: 0,
      },
    ]);
    const inv = await db.query<{ revoked_by: string | null }>(
      "select revoked_by from admin_invitations where id=$1",
      [id(500)],
    );
    expect(inv.rows[0].revoked_by).toBe(ADMIN);
  });

  it("sin factores TOTP no queda nada pendiente: la limpieza nace completada con 0 borrados", async () => {
    await db.query("delete from auth.mfa_factors where user_id=$1", [DEVELOPER]);
    const out = await removeDev(ADMIN, DEVELOPER);
    expect(out).toMatchObject({ ok: true, mfaFactorCount: 0 });
    expect(
      (
        await db.query(
          "select status, factors_deleted, cardinality(factor_ids) n from admin_mfa_resets",
        )
      ).rows,
    ).toEqual([{ status: "completed", factors_deleted: 0, n: 0 }]);
  });

  it("segunda retirada (carrera o doble clic): not_found y una sola fila de auditoría", async () => {
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({ ok: true });
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await developerAudit()).toHaveLength(1);
    expect(await teamAudit()).toHaveLength(1);
    expect(await count("admin_mfa_resets")).toBe(1); // sin limpieza duplicada
  });

  it("solo un ADMIN vigente puede ejecutarla: moderador, Developer y usuario sin rol son rechazados sin cambios", async () => {
    for (const actor of [MOD, DEVELOPER, NOBODY, GHOST]) {
      await fails(() => removeDev(actor, DEVELOPER2), /actor_not_admin/);
    }
    await addDeveloper2();
    for (const actor of [MOD, DEVELOPER, NOBODY, GHOST]) {
      await fails(() => removeDev(actor, DEVELOPER2), /actor_not_admin/);
    }
    expect(await roleOf(DEVELOPER2)).toBe("developer");
    expect(await developerAudit()).toEqual([]);
    expect(await teamAudit()).toEqual([]);
  });

  it("argumentos nulos se rechazan", async () => {
    await fails(
      () => call("admin_remove_developer(null,$1)", [DEVELOPER]),
      /invalid_argument/,
    );
    await fails(
      () => call("admin_remove_developer($1,null)", [ADMIN]),
      /invalid_argument/,
    );
  });

  it("nadie se retira a sí mismo (ni un Admin con su propia cuenta ni un Developer con la suya)", async () => {
    await fails(() => removeDev(ADMIN, ADMIN), /self_change_not_allowed/);
    await fails(() => removeDev(DEVELOPER, DEVELOPER), /actor_not_admin/);
    expect(await roleOf(ADMIN)).toBe("admin");
    expect(await roleOf(DEVELOPER)).toBe("developer");
    expect(await developerAudit()).toEqual([]);
  });

  it("objetivo inexistente o que no es Developer: sin cambios", async () => {
    expect(await removeDev(ADMIN, GHOST)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await removeDev(ADMIN, NOBODY)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    for (const target of [MOD, ADMIN2]) {
      expect(await removeDev(ADMIN, target)).toMatchObject({
        ok: false,
        reason: "not_developer",
      });
    }
    expect(await roleOf(MOD)).toBe("moderator");
    expect(await roleOf(ADMIN2)).toBe("admin");
    expect(await developerAudit()).toEqual([]);
    expect(await teamAudit()).toEqual([]);
  });

  it("no retira a un Developer con una recuperación propia en curso", async () => {
    const rid = await pendingFor(DEVELOPER);
    expect(
      await db.query("select status from admin_mfa_recoveries where id=$1", [rid]),
    ).toMatchObject({ rows: [{ status: "pending_approval" }] });
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "recovery_in_progress",
    });
    expect(await roleOf(DEVELOPER)).toBe("developer");
    expect(await developerAudit()).toEqual([]);
    expect(await count("admin_mfa_resets")).toBe(0); // un rechazo no crea ninguna limpieza
  });

  it("no retira a un Developer que aprobó una recuperación activa; sí cuando ya terminó o se cerró", async () => {
    await dropSecondAdmin(); // ADMIN es el único admin elegible: el Developer aprueba de forma excepcional
    const rid = await pendingFor(ADMIN);
    expect(await approveEx(rid, DEVELOPER)).toMatchObject({ ok: true });
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "approval_in_progress",
    });
    expect(await roleOf(DEVELOPER)).toBe("developer");
    // la solicitud sigue intacta
    expect(
      (
        await db.query(
          "select status, approved_by from admin_mfa_recoveries where id=$1",
          [rid],
        )
      ).rows,
    ).toEqual([{ status: "approved", approved_by: DEVELOPER }]);
    // una vez cerrada (el titular la canceló), ya no depende de él
    await db.exec("set local session_replication_role = replica");
    await db.query("update admin_mfa_recoveries set status='cancelled' where id=$1", [
      rid,
    ]);
    await db.exec("set local session_replication_role = origin");
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({ ok: true });
  });

  it("último Developer CON una solicitud de Admin que solo él podría aprobar: se rechaza", async () => {
    await dropSecondAdmin();
    const rid = await pendingFor(ADMIN);
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "recovery_depends_on_developer",
    });
    expect(await roleOf(DEVELOPER)).toBe("developer");
    expect(
      (await db.query("select status from admin_mfa_recoveries where id=$1", [rid])).rows,
    ).toEqual([{ status: "pending_approval" }]);
    expect(await developerAudit()).toEqual([]);
    expect(await count("admin_mfa_resets")).toBe(0);
  });

  it("hay otro Developer: se permite aunque haya una solicitud pendiente (lastDeveloper = false)", async () => {
    await dropSecondAdmin();
    await addDeveloper2();
    await pendingFor(ADMIN);
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({
      ok: true,
      lastDeveloper: false,
    });
    expect(await roleOf(DEVELOPER2)).toBe("developer");
  });

  it("último Developer pero la solicitud tiene un Admin elegible que puede aprobarla: se permite con aviso", async () => {
    await pendingFor(ADMIN); // ADMIN2 sigue siendo un par elegible
    expect(await removeDev(ADMIN2, DEVELOPER)).toMatchObject({
      ok: true,
      lastDeveloper: true,
    });
  });

  it("último Developer sin recuperaciones: se permite y devuelve lastDeveloper = true", async () => {
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({
      ok: true,
      lastDeveloper: true,
    });
    await addDeveloper2();
    expect(await removeDev(ADMIN, DEVELOPER2)).toMatchObject({
      ok: true,
      lastDeveloper: true,
    });
  });

  it("recuperaciones ya cerradas del Developer no bloquean (historial)", async () => {
    const rid = await pendingFor(DEVELOPER);
    await db.exec("set local session_replication_role = replica");
    await db.query("update admin_mfa_recoveries set status='denied' where id=$1", [rid]);
    await db.exec("set local session_replication_role = origin");
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({ ok: true });
  });

  it("la protección del último Admin sigue intacta (quitar un Developer no la afecta)", async () => {
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({ ok: true });
    await db.query("delete from admin_roles where user_id=$1", [ADMIN2]);
    await fails(
      () => db.query("delete from admin_roles where user_id=$1", [ADMIN]),
      /last_admin_protected/,
    );
    expect(await roleOf(ADMIN)).toBe("admin");
  });

  it("la salida de un Developer transferido deja la cuenta sin rol y sin vías de vuelta: ni transferencia ni restauración ni cambio de rol", async () => {
    expect(await transfer(ADMIN2)).toMatchObject({ ok: true });
    expect(await removeDev(ADMIN, ADMIN2)).toMatchObject({ ok: true });
    expect((await developerAudit()).map((r) => r.action)).toEqual([
      "self_transferred",
      "removed",
    ]);
    await fails(() => transfer(ADMIN2), /actor_not_admin/);
    expect(await restore(ADMIN, ADMIN2, "admin")).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    await fails(
      () =>
        db.query("select * from change_admin_member_role($1,$2,'developer')", [
          ADMIN,
          ADMIN2,
        ]),
      /member_not_found/,
    );
    expect(await roleOf(ADMIN2)).toBeUndefined();
    // y un Moderator sigue sin poder ser convertido en Developer por el cambio normal de rol
    await fails(
      () =>
        db.query("select * from change_admin_member_role($1,$2,'developer')", [
          ADMIN,
          MOD,
        ]),
      /developer_protected|invalid_role/,
    );
    expect(await roleOf(MOD)).toBe("moderator");
  });

  it("no hay ninguna función nueva que conceda Developer", async () => {
    const def = (
      await db.query<{ d: string }>(
        "select pg_get_functiondef('public.admin_remove_developer(uuid,uuid)'::regprocedure) d",
      )
    ).rows[0].d;
    expect(def).not.toMatch(/insert into public\.admin_roles/);
    expect(def).not.toMatch(/set role\s*=\s*'developer'/);
    const grantFns = await db.query(
      "select proname from pg_proc where proname in ('operator_grant_developer')",
    );
    expect(grantFns.rows).toEqual([]);
  });

  it("toma el lock de roles ANTES de cualquier FOR UPDATE (serializa con transferencias, restauraciones y aprobaciones)", async () => {
    const def = (
      await db.query<{ d: string }>(
        "select pg_get_functiondef('public.admin_remove_developer(uuid,uuid)'::regprocedure) d",
      )
    ).rows[0].d;
    const lock = def.indexOf("upmina_lock_admin_roles");
    const forUpdate = def.indexOf("for update");
    expect(lock).toBeGreaterThan(-1);
    expect(forUpdate).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(forUpdate);
  });
});

describe("limpieza MFA con la infraestructura de la fase 1", () => {
  const pendingReset = async (user: string) =>
    (
      await db.query(
        "select out_reset_id, out_factor_ids from admin_mfa_pending_reset($1)",
        [user],
      )
    ).rows;
  const record = (
    resetId: unknown,
    ok: boolean,
    deleted: number | null,
    cls: string | null,
  ) =>
    db.query<{ r: string }>("select admin_mfa_reset_record($1,$2,$3,$4) r", [
      resetId,
      ok,
      deleted,
      cls,
    ]);
  const activation = async (user: string, session: string | null) =>
    (
      await db.query<{ r: J }>("select admin_mfa_activation_check($1,$2) r", [
        user,
        session,
      ])
    ).rows[0].r;

  it("la función de fase 1 devuelve exactamente la instantánea y la finalización audita 'mfa_reset_completed' con el actor", async () => {
    const out = await removeDev(ADMIN, DEVELOPER);
    expect(await pendingReset(DEVELOPER)).toEqual([
      { out_reset_id: out.mfaResetId, out_factor_ids: [FACTORS[DEVELOPER]] },
    ]);
    expect((await record(out.mfaResetId, true, 1, null)).rows[0].r).toBe("completed");
    expect(await pendingReset(DEVELOPER)).toEqual([]);
    expect(await teamAudit()).toEqual([
      {
        action: "access_removed",
        actor_user_id: ADMIN,
        target_user_id: DEVELOPER,
        old_role: "developer",
        new_role: null,
      },
      {
        action: "mfa_reset_completed",
        actor_user_id: ADMIN,
        target_user_id: DEVELOPER,
        old_role: "developer",
        new_role: null,
      },
    ]);
    // idempotente: repetir el registro no duplica la auditoría
    expect((await record(out.mfaResetId, true, 1, null)).rows[0].r).toBe("completed");
    expect(await teamAudit()).toHaveLength(2);
  });

  it("una limpieza fallida queda PENDIENTE con su clase de error y sin devolver privilegios ni auditar la finalización", async () => {
    const out = await removeDev(ADMIN, DEVELOPER);
    expect(
      (await record(out.mfaResetId, false, null, "auth_delete_failed")).rows[0].r,
    ).toBe("pending");
    expect(
      (await record(out.mfaResetId, false, null, "auth_delete_failed")).rows[0].r,
    ).toBe("pending");
    const row = (
      await db.query(
        "select status, attempts, last_error_class from admin_mfa_resets where id=$1",
        [out.mfaResetId],
      )
    ).rows;
    expect(row).toEqual([
      { status: "pending", attempts: 2, last_error_class: "auth_delete_failed" },
    ]);
    expect(await roleOf(DEVELOPER)).toBeUndefined(); // el fallo no devuelve privilegios
    expect((await teamAudit()).map((r) => r.action)).toEqual(["access_removed"]);
    expect((await developerAudit()).map((r) => r.action)).toEqual(["removed"]);
    // el reintento posterior sí completa
    expect((await record(out.mfaResetId, true, 1, null)).rows[0].r).toBe("completed");
  });

  it("la instantánea no incluye factores creados DESPUÉS: un reintento tardío nunca borra uno nuevo", async () => {
    const out = await removeDev(ADMIN, DEVELOPER);
    const later = id(300, "e");
    await db.query(
      "insert into auth.mfa_factors(id,user_id,created_at) values($1,$2,now() + interval '1 minute')",
      [later, DEVELOPER],
    );
    const pending = await pendingReset(DEVELOPER);
    expect(pending).toEqual([
      { out_reset_id: out.mfaResetId, out_factor_ids: [FACTORS[DEVELOPER]] },
    ]);
    expect(JSON.stringify(pending)).not.toContain(later);
  });

  it("mientras la limpieza está pendiente la cuenta NO puede recuperar privilegios (la activación se bloquea); después exige un factor NUEVO", async () => {
    const out = await removeDev(ADMIN, DEVELOPER);
    const session = id(400, "d");
    await db.query(
      "insert into auth.sessions(id,user_id,factor_id,aal) values($1,$2,$3,'aal2')",
      [session, DEVELOPER, FACTORS[DEVELOPER]],
    );
    expect(await activation(DEVELOPER, session)).toMatchObject({
      allowed: false,
      reason: "mfa_cleanup_pending",
    });
    await record(out.mfaResetId, true, 1, null);
    // el factor antiguo (de la instantánea) no acredita: hace falta uno nuevo
    expect(await activation(DEVELOPER, session)).toMatchObject({
      allowed: false,
      reason: "mfa_reenroll_required",
    });
    const fresh = id(301, "e");
    const freshSession = id(401, "d");
    await db.query(
      "insert into auth.mfa_factors(id,user_id,created_at) values($1,$2,now() + interval '1 minute')",
      [fresh, DEVELOPER],
    );
    await db.query(
      "insert into auth.sessions(id,user_id,factor_id,aal) values($1,$2,$3,'aal2')",
      [freshSession, DEVELOPER, fresh],
    );
    expect(await activation(DEVELOPER, freshSession)).toMatchObject({ allowed: true });
  });

  it("una limpieza pendiente previa del objetivo bloquea la retirada sin cambios (nada de instantáneas duplicadas)", async () => {
    await db.query(
      "insert into admin_mfa_resets(user_id,status,old_role,requested_by,requested_at,factor_ids) values($1,'pending','moderator',$2,now(),$3)",
      [DEVELOPER, ADMIN, [FACTORS[DEVELOPER]]],
    );
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "mfa_cleanup_pending",
    });
    expect(await roleOf(DEVELOPER)).toBe("developer");
    expect(await developerAudit()).toEqual([]);
    expect(await count("admin_mfa_resets")).toBe(1);
  });

  it("la retirada y la marca son atómicas: si falla algo después de borrar el rol, todo se revierte", async () => {
    // fuerza un fallo en el último insert: una fila de equipo con actor = objetivo viola su CHECK
    await db.exec("savepoint atomic");
    await db.exec(
      "alter table admin_team_audit add constraint boom check (target_user_id <> '" +
        DEVELOPER +
        "')",
    );
    let err: unknown = null;
    try {
      await removeDev(ADMIN, DEVELOPER);
    } catch (e) {
      err = e;
    }
    await db.exec("rollback to savepoint atomic");
    expect(err).not.toBeNull();
    expect(await roleOf(DEVELOPER)).toBe("developer");
    expect(await count("admin_mfa_resets")).toBe(0);
    expect(await developerAudit()).toEqual([]);
  });

  it("no existe un segundo sistema de limpieza: la función solo escribe en admin_mfa_resets y no toca auth", async () => {
    const def = (
      await db.query<{ d: string }>(
        "select pg_get_functiondef('public.admin_remove_developer(uuid,uuid)'::regprocedure) d",
      )
    ).rows[0].d;
    expect(def).toMatch(/insert into public\.admin_mfa_resets/);
    expect(def).not.toMatch(/delete from auth\.|update auth\.|auth\.admin/);
    expect(def).not.toMatch(/create table/i);
  });
});

describe("permisos y auditoría", () => {
  it("solo service_role ejecuta admin_remove_developer; es SECURITY DEFINER con search_path fijo", async () => {
    expect(await canExecute("service_role", DEV_FN)).toBe(true);
    for (const role of ["anon", "authenticated", "public"]) {
      expect(await canExecute(role, DEV_FN), role).toBe(false);
    }
    const meta = await db.query<{ definer: boolean; config: string[] | null }>(
      "select prosecdef definer, proconfig config from pg_proc where proname='admin_remove_developer'",
    );
    expect(meta.rows[0].definer).toBe(true);
    expect(meta.rows[0].config?.join(",")).toContain("search_path=pg_catalog, public");
  });

  it("la auditoría sigue siendo append-only y 'removed' exige actor distinto del objetivo y resultado sin rol", async () => {
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({ ok: true });
    await fails(
      () => db.query("update admin_developer_audit set action='removed'"),
      /developer_audit_append_only/,
    );
    await fails(
      () => db.query("delete from admin_developer_audit"),
      /developer_audit_append_only/,
    );
    const insert = (actor: string | null, target: string, newRole: string | null) =>
      db.query(
        "insert into admin_developer_audit(action,target_user_id,actor_user_id,previous_role,new_role) values('removed',$1,$2,'developer',$3)",
        [target, actor, newRole],
      );
    await fails(() => insert(ADMIN, DEVELOPER2, "admin"), /shape_check/);
    await fails(() => insert(DEVELOPER2, DEVELOPER2, null), /shape_check/);
    await fails(() => insert(null, DEVELOPER2, null), /shape_check/);
  });

  it("las acciones anteriores conservan su forma (compatibilidad con la migración previa)", async () => {
    expect(await transfer(ADMIN2)).toMatchObject({ ok: true });
    expect(await restore(ADMIN, ADMIN2, "moderator")).toMatchObject({ ok: true });
    expect((await developerAudit()).map((r) => [r.action, r.new_role])).toEqual([
      ["self_transferred", "developer"],
      ["restored", "moderator"],
    ]);
  });
});

describe("rollback", () => {
  const rollback = () => readFileSync(resolve(ROLLBACK), "utf8");

  it("se niega con una retirada registrada", async () => {
    expect(await removeDev(ADMIN, DEVELOPER)).toMatchObject({ ok: true });
    await fails(() => db.exec(rollback()), /rollback_refused_developer_removals_exist/);
  });

  it("sin historial elimina la función y restaura la forma anterior de la auditoría", async () => {
    await db.exec(rollback());
    const gone = await db.query(
      "select proname from pg_proc where proname='admin_remove_developer'",
    );
    expect(gone.rows).toEqual([]);
    const nullable = await db.query<{ is_nullable: string }>(
      "select is_nullable from information_schema.columns where table_name='admin_developer_audit' and column_name='new_role'",
    );
    expect(nullable.rows[0].is_nullable).toBe("NO");
    // las transiciones anteriores siguen funcionando
    expect(await transfer(ADMIN2)).toMatchObject({ ok: true });
    expect(await restore(ADMIN, ADMIN2, "admin")).toMatchObject({ ok: true });
    await fails(
      () =>
        db.query(
          "insert into admin_developer_audit(action,target_user_id,actor_user_id,previous_role,new_role) values('removed',$1,$2,'developer',null)",
          [DEVELOPER2, ADMIN],
        ),
      /shape_check|not-null|null value/,
    );
  });

  it("la migración y su rollback no se aplican accidentalmente a otras tablas (solo objetos propios)", () => {
    const sql = read(MIGRATION);
    expect(sql).not.toMatch(/drop table|truncate|delete from auth\./i);
    // solo LEE los factores (instantánea); nunca los modifica ni borra
    expect(sql).not.toMatch(/(insert into|update|delete from)\s+auth\./i);
    expect(T2).toHaveLength(64);
  });
});
