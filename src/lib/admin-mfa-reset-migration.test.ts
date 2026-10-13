// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "./community-atomic-save-test-db";

// MFA fase 1 — SQL REAL (PGlite) de la migración 20261031140000 sobre la cadena REAL de las
// migraciones de admin (roles, invitaciones, 9F). auth.users / auth.mfa_factors / auth.sessions
// son solo la FORMA mínima que usa la migración (en Supabase las gestiona GoTrue). Esto prueba la
// lógica de base de datos: NO prueba la API de administración de Supabase Auth ni sesiones reales.

const MIGRATION = "20261031140000_admin_mfa_reset.sql";
const ROLLBACK = "supabase/rollbacks/20261031140000_admin_mfa_reset.rollback.sql";
const CHAIN = [
  "20260922120000_admin_roles.sql",
  "20260923120000_admin_invitations.sql",
  "20260926120000_admin_team_roles_invariants.sql",
  "20260927120000_admin_team_invitation_revoke.sql",
  "20260928120000_admin_team_member_management.sql",
  MIGRATION,
];
const read = (name: string) => readFileSync(resolve("supabase/migrations", name), "utf8");

const id = (n: number, tag = "a") =>
  `${tag.repeat(8)}-${tag.repeat(4)}-4${tag.repeat(3)}-8${tag.repeat(3)}-${String(n).padStart(12, "0")}`;
const ADMIN = id(1);
const ADMIN2 = id(2);
const MEMBER = id(3);
const MEMBER2 = id(4);
const NOBODY = id(5);
const F1 = id(101, "f");
const F2 = id(102, "f");
const F3 = id(103, "f");
const SESSION = id(201, "5");

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
    [MEMBER, "member@example.test"],
    [MEMBER2, "member2@example.test"],
    [NOBODY, "nobody@example.test"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [n, email]);
  }
  await db.query("insert into profiles(user_id,username) values($1,'miembro')", [MEMBER]);
  await db.exec(`set local session_replication_role = replica;`); // inserta roles sin el guard del último admin
  await db.query(
    "insert into admin_roles(user_id,role) values($1,'admin'),($2,'admin'),($3,'moderator'),($4,'developer')",
    [ADMIN, ADMIN2, MEMBER, MEMBER2],
  );
  await db.exec(`set local session_replication_role = origin;`);
});
afterEach(async () => {
  await db.exec("reset role;rollback");
});

const factor = (
  fid: string,
  user: string,
  over: { created?: string; status?: string; type?: string } = {},
) =>
  db.query(
    "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at) values($1,$2,$3,$4,coalesce($5::timestamptz, now()))",
    [fid, user, over.type ?? "totp", over.status ?? "verified", over.created ?? null],
  );
const removeWithReset = async (actor = ADMIN, target = MEMBER) =>
  (
    await db.query<Record<string, unknown>>(
      "select * from admin_remove_member_with_mfa_reset($1,$2)",
      [actor, target],
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
const resets = async () =>
  (
    await db.query<Record<string, unknown>>(
      "select * from admin_mfa_resets order by requested_at",
    )
  ).rows;
const check = async (user: string, session: string | null) =>
  (
    await db.query<{ r: { allowed: boolean; reason: string } }>(
      "select admin_mfa_activation_check($1,$2) r",
      [user, session],
    )
  ).rows[0].r;
const record = async (
  rid: string,
  ok: boolean,
  deleted: number | null,
  cls: string | null = null,
) =>
  (
    await db.query<{ r: string }>("select admin_mfa_reset_record($1,$2,$3,$4) r", [
      rid,
      ok,
      deleted,
      cls,
    ])
  ).rows[0].r;

describe("retirada del último rol + marca de limpieza (atómica)", () => {
  it("retira el rol, audita 'access_removed' y crea UNA limpieza pendiente con la instantánea de factores", async () => {
    await factor(F1, MEMBER);
    const r = await removeWithReset();
    expect(r).toMatchObject({ out_old_role: "moderator", out_mfa_factor_count: 1 });
    expect(
      (await db.query("select 1 from admin_roles where user_id=$1", [MEMBER])).rows,
    ).toHaveLength(0);
    const audit = (
      await db.query("select action,actor_user_id,target_user_id from admin_team_audit")
    ).rows;
    expect(audit).toEqual([
      { action: "access_removed", actor_user_id: ADMIN, target_user_id: MEMBER },
    ]);
    const rows = await resets();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: MEMBER,
      status: "pending",
      old_role: "moderator",
      requested_by: ADMIN,
      kind: "role_removed",
      attempts: 0,
      completed_at: null,
    });
    expect(rows[0].factor_ids).toEqual([F1]);
  });

  it("sin factores TOTP no queda nada pendiente: la limpieza nace completada (0 factores)", async () => {
    const r = await removeWithReset();
    expect(r.out_mfa_factor_count).toBe(0);
    expect(await resets()).toMatchObject([{ status: "completed", factors_deleted: 0 }]);
  });

  it("solo se atribuyen factores TOTP (otros tipos no entran en la instantánea)", async () => {
    await factor(F1, MEMBER);
    await factor(F2, MEMBER, { type: "phone" });
    await removeWithReset();
    expect((await resets())[0].factor_ids).toEqual([F1]);
  });

  it("un factor creado DESPUÉS de la retirada no está en la instantánea", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    await factor(F2, MEMBER);
    const [row] = await resets();
    expect(row.factor_ids).toEqual([F1]);
    expect(row.factor_ids).not.toContain(F2);
  });

  it("cambiar de rol NO crea ninguna limpieza", async () => {
    await factor(F1, MEMBER);
    await db.query("select * from change_admin_member_role($1,$2,'developer')", [
      ADMIN,
      MEMBER,
    ]);
    expect(await resets()).toHaveLength(0);
    expect(
      (await db.query("select role from admin_roles where user_id=$1", [MEMBER])).rows,
    ).toEqual([{ role: "developer" }]);
  });

  it("los rechazos de remove_admin_member revierten TODO: sin limpieza y sin cambios", async () => {
    await factor(F1, MEMBER);
    await fails(() => removeWithReset(MEMBER, MEMBER2), /actor_not_admin/);
    await fails(() => removeWithReset(ADMIN, ADMIN), /self_change_not_allowed/);
    await fails(() => removeWithReset(ADMIN, NOBODY), /member_not_found/);
    expect(await resets()).toHaveLength(0);
    expect((await db.query("select count(*)::int n from admin_roles")).rows[0]).toEqual({
      n: 4,
    });
  });

  it("el único ADMIN no puede retirarse a sí mismo (actor = objetivo): no hay limpieza ni cambios", async () => {
    await fails(() => removeWithReset(ADMIN, ADMIN), /self_change_not_allowed/);
    await fails(() => removeWithReset(ADMIN2, ADMIN2), /self_change_not_allowed/);
    expect(await resets()).toHaveLength(0);
    expect(
      (await db.query("select count(*)::int n from admin_roles where role='admin'"))
        .rows[0],
    ).toEqual({ n: 2 });
  });

  it("repetir la solicitud no crea otra limpieza ni reabre privilegios", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    await fails(() => removeWithReset(), /member_not_found/);
    expect(await resets()).toHaveLength(1);
    expect(
      (await db.query("select 1 from admin_roles where user_id=$1", [MEMBER])).rows,
    ).toHaveLength(0);
  });
});

describe("registro del resultado de la limpieza (idempotente)", () => {
  it("un fallo deja la limpieza pendiente y cuenta el intento; sin secretos, solo la clase", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    const [row] = await resets();
    expect(await record(row.id as string, false, null, "auth_delete_failed")).toBe(
      "pending",
    );
    expect(
      await record(row.id as string, false, null, "Texto con espacios y SECRETO"),
    ).toBe("pending");
    const [after] = await resets();
    expect(after).toMatchObject({
      status: "pending",
      attempts: 2,
      last_error_class: "cleanup_failed",
    });
    expect(JSON.stringify(after)).not.toMatch(/SECRETO/);
  });

  it("el éxito completa una sola vez, audita 'mfa_reset_completed' y un segundo registro no duplica nada", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    const [row] = await resets();
    expect(await record(row.id as string, true, 1)).toBe("completed");
    expect(await record(row.id as string, true, 1)).toBe("completed");
    expect(await record(row.id as string, false, null, "late_failure")).toBe("completed");
    const [after] = await resets();
    expect(after).toMatchObject({
      status: "completed",
      factors_deleted: 1,
      attempts: 1,
      last_error_class: null,
    });
    const audit = (
      await db.query(
        "select action,actor_user_id,target_user_id,old_role,new_role from admin_team_audit order by created_at",
      )
    ).rows;
    expect(audit.map((a) => a.action)).toEqual(["access_removed", "mfa_reset_completed"]);
    expect(audit[1]).toMatchObject({
      actor_user_id: ADMIN,
      target_user_id: MEMBER,
      old_role: "moderator",
      new_role: null,
    });
  });

  it("rechaza un recuento de borrados imposible y un id inexistente", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    const [row] = await resets();
    await fails(() => record(row.id as string, true, 2), /invalid_argument/);
    await fails(() => record(row.id as string, true, -1), /invalid_argument/);
    await fails(() => record(id(999, "e"), true, 0), /reset_not_found/);
    expect((await resets())[0].status).toBe("pending");
  });

  it("la fila es append-only: no se borra, no se edita la instantánea y lo completado es inmutable", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    const [row] = await resets();
    await fails(() => db.query("delete from admin_mfa_resets"), /append_only/);
    await fails(
      () => db.query("update admin_mfa_resets set factor_ids='{}'"),
      /immutable_field|shape_check/,
    );
    await fails(
      () => db.query("update admin_mfa_resets set user_id=$1", [NOBODY]),
      /immutable_field/,
    );
    await record(row.id as string, true, 1);
    await fails(
      () => db.query("update admin_mfa_resets set attempts=9"),
      /completed_immutable/,
    );
  });

  it("solo puede haber UNA limpieza pendiente por usuario", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    await fails(
      () =>
        db.query(
          "insert into admin_mfa_resets(user_id,status,old_role,requested_by,requested_at,factor_ids) values($1,'pending','moderator',$2,now(),$3)",
          [MEMBER, ADMIN, [F2]],
        ),
      /one_pending_per_user|duplicate key/,
    );
  });
});

describe("comprobación previa a la activación (reinvitación)", () => {
  it("primera invitación / sin antecedentes: permitida, aunque tenga un factor (flujo normal)", async () => {
    await factor(F1, NOBODY);
    expect(await check(NOBODY, SESSION)).toMatchObject({
      allowed: true,
      reason: "no_reset_history",
    });
    expect(await check(NOBODY, null)).toMatchObject({ allowed: true });
  });

  it("limpieza pendiente → bloquea la activación aunque la sesión sea aal2", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    await db.query("insert into auth.sessions values($1,$2,$3,'aal2')", [
      SESSION,
      MEMBER,
      F1,
    ]);
    expect(await check(MEMBER, SESSION)).toMatchObject({
      allowed: false,
      reason: "mfa_cleanup_pending",
    });
  });

  it("reinvitación con la sesión aal2 del factor ANTIGUO → rechazada, esté o no borrado el factor", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    const [row] = await resets();
    await db.query("insert into auth.sessions values($1,$2,$3,'aal2')", [
      SESSION,
      MEMBER,
      F1,
    ]);
    // F1 sigue existiendo, limpieza completada en la tabla (caso extremo): F1 está en la instantánea
    await record(row.id as string, true, 1);
    expect(await check(MEMBER, SESSION)).toMatchObject({
      allowed: false,
      reason: "mfa_reenroll_required",
    });
    // y con el factor ya borrado en Auth
    await db.query("delete from auth.mfa_factors where id=$1", [F1]);
    expect(await check(MEMBER, SESSION)).toMatchObject({
      allowed: false,
      reason: "mfa_reenroll_required",
    });
  });

  it("sesión aal1, sin sesión, de otro usuario o sin factor asociado → debe reenrolar", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    const [row] = await resets();
    await record(row.id as string, true, 1);
    await db.query("delete from auth.mfa_factors where id=$1", [F1]);
    await factor(F2, MEMBER, { created: "2999-01-01T00:00:00Z" });
    await db.query("insert into auth.sessions values($1,$2,$3,'aal1')", [
      SESSION,
      MEMBER,
      F2,
    ]);
    expect(await check(MEMBER, SESSION)).toMatchObject({
      reason: "mfa_reenroll_required",
    });
    expect(await check(MEMBER, null)).toMatchObject({ reason: "mfa_reenroll_required" });
    expect(await check(MEMBER, id(300, "6"))).toMatchObject({
      reason: "mfa_reenroll_required",
    });
    await db.query("update auth.sessions set aal='aal2', factor_id=null");
    expect(await check(MEMBER, SESSION)).toMatchObject({
      reason: "mfa_reenroll_required",
    });
    await db.query("update auth.sessions set factor_id=$1, user_id=$2", [F2, MEMBER2]);
    expect(await check(MEMBER, SESSION)).toMatchObject({
      reason: "mfa_reenroll_required",
    });
  });

  it("factor NUEVO verificado (no está en la instantánea y es posterior a la retirada) → permitida", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    const [row] = await resets();
    await record(row.id as string, true, 1);
    await db.query("delete from auth.mfa_factors where id=$1", [F1]);
    await factor(F2, MEMBER, { created: "2999-01-01T00:00:00Z" });
    await db.query("insert into auth.sessions values($1,$2,$3,'aal2')", [
      SESSION,
      MEMBER,
      F2,
    ]);
    expect(await check(MEMBER, SESSION)).toMatchObject({
      allowed: true,
      reason: "new_factor_verified",
    });
  });

  it("factor sin verificar, de otro tipo, o anterior a la retirada (carrera) → rechazado, en dirección segura", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    const [row] = await resets();
    await record(row.id as string, true, 1);
    await db.query("delete from auth.mfa_factors where id=$1", [F1]);
    await db.query("insert into auth.sessions values($1,$2,$3,'aal2')", [
      SESSION,
      MEMBER,
      F3,
    ]);

    await factor(F3, MEMBER, { created: "2999-01-01T00:00:00Z", status: "unverified" });
    expect(await check(MEMBER, SESSION)).toMatchObject({
      reason: "mfa_reenroll_required",
    });
    await db.query("delete from auth.mfa_factors where id=$1", [F3]);
    await factor(F3, MEMBER, { created: "2999-01-01T00:00:00Z", type: "phone" });
    expect(await check(MEMBER, SESSION)).toMatchObject({
      reason: "mfa_reenroll_required",
    });
    await db.query("delete from auth.mfa_factors where id=$1", [F3]);
    // verificado y fuera de la instantánea, pero creado ANTES de la retirada
    await factor(F3, MEMBER, { created: "2000-01-01T00:00:00Z" });
    expect(await check(MEMBER, SESSION)).toMatchObject({
      reason: "mfa_reenroll_required",
    });
  });

  it("la IDENTIDAD manda: un factor de la instantánea se rechaza aunque su fecha parezca posterior (sin depender del reloj)", async () => {
    // F1 está en la instantánea pero con created_at futuro (reloj desfasado): solo la comprobación por id lo rechaza.
    await factor(F1, MEMBER, { created: "2999-01-01T00:00:00Z" });
    await removeWithReset();
    const [row] = await resets();
    await record(row.id as string, true, 1);
    await db.query("insert into auth.sessions values($1,$2,$3,'aal2')", [
      SESSION,
      MEMBER,
      F1,
    ]);
    expect(await check(MEMBER, SESSION)).toMatchObject({
      allowed: false,
      reason: "mfa_reenroll_required",
    });
  });

  it("un reintento tardío no puede afectar a un factor nuevo: la función solo conoce ids de la instantánea", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    await factor(F2, MEMBER, { created: "2999-01-01T00:00:00Z" });
    const pending = (
      await db.query<{ out_factor_ids: string[] }>(
        "select * from admin_mfa_pending_reset($1)",
        [MEMBER],
      )
    ).rows;
    expect(pending).toHaveLength(1);
    expect(pending[0].out_factor_ids).toEqual([F1]);
  });
});

describe("lista de limpiezas pendientes y permisos", () => {
  it("solo un ADMIN la consulta; devuelve usuario, rol anterior, intentos y la clase del último error", async () => {
    await factor(F1, MEMBER);
    await removeWithReset();
    const [row] = await resets();
    await record(row.id as string, false, null, "auth_delete_failed");
    const list = (
      await db.query("select * from admin_mfa_cleanups_pending($1)", [ADMIN2])
    ).rows;
    expect(list).toEqual([
      {
        out_user_id: MEMBER,
        out_old_role: "moderator",
        out_requested_at: expect.anything(),
        out_attempts: 1,
        out_last_error_class: "auth_delete_failed",
        out_factor_count: 1,
        out_username: "miembro",
        out_email: "member@example.test",
      },
    ]);
    await fails(
      () => db.query("select * from admin_mfa_cleanups_pending($1)", [MEMBER2]),
      /actor_not_admin/,
    );
  });

  it("ACL: solo service_role ejecuta las funciones; remove_admin_member ya no es invocable directamente; la tabla es inaccesible", async () => {
    const exec = async (fn: string, role: string) =>
      (
        await db.query<{ ok: boolean }>(
          "select has_function_privilege($1,$2,'execute') ok",
          [role, fn],
        )
      ).rows[0].ok;
    for (const fn of [
      "public.admin_remove_member_with_mfa_reset(uuid,uuid)",
      "public.admin_mfa_pending_reset(uuid)",
      "public.admin_mfa_reset_record(uuid,boolean,integer,text)",
      "public.admin_mfa_cleanups_pending(uuid)",
      "public.admin_mfa_activation_check(uuid,uuid)",
    ]) {
      expect(await exec(fn, "service_role"), fn).toBe(true);
      expect(await exec(fn, "anon"), fn).toBe(false);
      expect(await exec(fn, "authenticated"), fn).toBe(false);
    }
    expect(await exec("public.remove_admin_member(uuid,uuid)", "service_role")).toBe(
      false,
    );
    expect(
      await exec("public.change_admin_member_role(uuid,uuid,text)", "service_role"),
    ).toBe(true);
    const table = async (role: string, priv: string) =>
      (
        await db.query<{ ok: boolean }>(
          "select has_table_privilege($1,'public.admin_mfa_resets',$2) ok",
          [role, priv],
        )
      ).rows[0].ok;
    for (const role of ["anon", "authenticated", "service_role"])
      for (const priv of ["select", "insert", "update", "delete"])
        expect(await table(role, priv), `${role} ${priv}`).toBe(false);
    const rls = (
      await db.query<{ a: boolean; b: boolean }>(
        "select relrowsecurity a, relforcerowsecurity b from pg_class where relname='admin_mfa_resets'",
      )
    ).rows[0];
    expect(rls).toEqual({ a: true, b: true });
  });
});

describe("migración — contenido estático", () => {
  const sql = read(MIGRATION);
  const code = sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("no usa friendly_name ni claims del cliente como prueba, no guarda secretos y no toca otras migraciones", () => {
    expect(code).not.toMatch(/friendly_name/i);
    expect(code).not.toMatch(/\bsecret\b|otp_code|jwt|password/i);
    expect(code).not.toMatch(/\bdelete\s+from\s+auth\./i);
    expect(code).not.toMatch(/\balter\s+table\s+public\.admin_(roles|invitations)\b/i);
    expect(code).not.toMatch(
      /create or replace function public\.(remove_admin_member|consume_admin_invitation|change_admin_member_role)/i,
    );
  });

  it("el rollback se niega si hay historial", () => {
    const rb = readFileSync(resolve(ROLLBACK), "utf8");
    expect(rb).toMatch(/rollback_blocked/);
    expect(rb).toMatch(/grant execute on function public\.remove_admin_member/);
  });
});
