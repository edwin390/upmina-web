// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "./community-atomic-save-test-db";

// Developer Panel V1 — SQL REAL (PGlite) de la migración 20261101120000 sobre la cadena real de admin
// y las migraciones de MFA fase 1 y fase 2. auth.* son solo la FORMA mínima que usa la migración.
// Prueba la lógica de base de datos; NO prueba Supabase Auth, GoTrue ni Resend.

const MIGRATION = "20261101120000_developer_panel.sql";
const ROLLBACK = "supabase/rollbacks/20261101120000_developer_panel.rollback.sql";
const CHAIN = [
  "20260922120000_admin_roles.sql",
  "20260923120000_admin_invitations.sql",
  "20260926120000_admin_team_roles_invariants.sql",
  "20260927120000_admin_team_invitation_revoke.sql",
  "20260928120000_admin_team_member_management.sql",
  "20261031140000_admin_mfa_reset.sql",
  "20261031150000_admin_mfa_recovery.sql",
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
const DEVELOPER2 = id(7);
const NOBODY = id(5);
const OLD_F = id(101, "f");
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
    [DEVELOPER2, "dev2@example.test"],
    [NOBODY, "nobody@example.test"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [n, email]);
  }
  await db.query(
    "insert into profiles(user_id,username) values($1,'moderadora'),($2,'unica_admin'),($3,'el_dev')",
    [MOD, ADMIN, DEVELOPER],
  );
  await db.exec(`set local session_replication_role = replica;`);
  await db.query(
    "insert into admin_roles(user_id,role) values($1,'admin'),($2,'admin'),($3,'moderator'),($4,'developer'),($5,'developer')",
    [ADMIN, ADMIN2, MOD, DEVELOPER, DEVELOPER2],
  );
  await db.exec(`set local session_replication_role = origin;`);
  // Cada miembro con TOTP verificado, salvo que el test diga otra cosa.
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
const create = (user: string, hash = T1) =>
  call("admin_mfa_recovery_create($1,$2)", [user, hash]);
const verify = (user: string, hash = T1) =>
  call("admin_mfa_recovery_verify($1,$2)", [user, hash]);
const approve = (rid: string, actor: string, cancelHash = CANCEL) =>
  call("admin_mfa_recovery_approve($1,$2,$3)", [rid, actor, cancelHash]);
const approveEx = (rid: string, actor: string, cancelHash = CANCEL) =>
  call("admin_mfa_recovery_approve_exceptional($1,$2,$3)", [rid, actor, cancelHash]);
const denyEx = (rid: string, actor: string, reason = "No es el titular") =>
  call("admin_mfa_recovery_deny_exceptional($1,$2,$3)", [rid, actor, reason]);
const begin = (user: string, rid: string) =>
  call("admin_mfa_recovery_begin_execute($1,$2)", [user, rid]);
const mailStart = (rid: string, kind: string, key: string) =>
  call("admin_mfa_recovery_mail_start($1,$2,$3)", [rid, kind, key]);
const row = async (rid: string) =>
  (
    await db.query<Record<string, unknown>>(
      "select * from admin_mfa_recoveries where id=$1",
      [rid],
    )
  ).rows[0];
const events = async (rid: string) =>
  (
    await db.query<{
      event: string;
      actor_user_id: string | null;
      detail: string | null;
    }>(
      "select event, actor_user_id, detail from admin_mfa_recovery_events where recovery_id=$1 order by id",
      [rid],
    )
  ).rows;
const peer = async (user: string) =>
  (
    await db.query<{ r: boolean }>("select admin_mfa_recovery_peer_available($1) r", [
      user,
    ])
  ).rows[0].r;
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

/** ADMIN deja de tener pares: ADMIN2 pasa a moderator (el único admin queda ADMIN). */
async function soleAdmin() {
  await db.query("update admin_roles set role='moderator' where user_id=$1", [ADMIN2]);
}
/** Solicitud de `user` hasta pending_approval. */
async function pendingFor(user: string): Promise<string> {
  const c = await create(user);
  expect(c.ok).toBe(true);
  expect((await verify(user)).ok).toBe(true);
  return c.recoveryId as string;
}

describe("Developer es independiente de Admin", () => {
  it("Admin no puede conceder, retirar ni modificar Developer (ni por la retirada con limpieza de MFA)", async () => {
    await fails(
      () =>
        db.query("select * from change_admin_member_role($1,$2,'developer')", [
          ADMIN,
          MOD,
        ]),
      /developer_protected/,
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
        db.query("select * from change_admin_member_role($1,$2,'admin')", [
          ADMIN,
          DEVELOPER,
        ]),
      /developer_protected/,
    );
    await fails(
      () => db.query("select * from remove_admin_member($1,$2)", [ADMIN, DEVELOPER]),
      /developer_protected/,
    );
    await fails(
      () =>
        db.query("select * from admin_remove_member_with_mfa_reset($1,$2)", [
          ADMIN,
          DEVELOPER,
        ]),
      /developer_protected/,
    );
    const roles = await db.query<{ role: string }>(
      "select role from admin_roles where user_id=$1",
      [DEVELOPER],
    );
    expect(roles.rows[0].role).toBe("developer");
    expect((await db.query("select * from admin_team_audit")).rows).toEqual([]);
  });

  it("las capacidades de Admin no relacionadas siguen intactas (cambiar y retirar a un moderator)", async () => {
    const changed = await db.query<{ out_old_role: string; out_new_role: string }>(
      "select * from change_admin_member_role($1,$2,'admin')",
      [ADMIN, MOD],
    );
    expect(changed.rows[0]).toMatchObject({
      out_old_role: "moderator",
      out_new_role: "admin",
    });
    await db.query("select * from change_admin_member_role($1,$2,'moderator')", [
      ADMIN,
      MOD,
    ]);
    const removed = await db.query<{ out_old_role: string }>(
      "select * from remove_admin_member($1,$2)",
      [ADMIN, MOD],
    );
    expect(removed.rows[0].out_old_role).toBe("moderator");
  });

  it("no se obtiene Developer por invitación ni por bootstrap (CHECK sin cambios)", async () => {
    await fails(
      () =>
        db.query(
          "insert into admin_invitations(token_hash, role, invitation_type, created_by, expires_at) values($1,'developer','standard',$2, now() + interval '1 day')",
          [sha("inv"), ADMIN],
        ),
      /admin_invitations_role_check|check constraint/,
    );
    await fails(
      () =>
        db.query(
          "insert into admin_invitations(token_hash, role, invitation_type, created_by, expires_at) values($1,'developer','bootstrap_admin',null, now() + interval '1 day')",
          [sha("boot")],
        ),
      /check constraint|bootstrap_not_allowed/,
    );
  });

  it("Developer no hereda RPC de Admin y Admin no usa las de Developer", async () => {
    const rid = await pendingFor(MOD);
    await fails(() => approve(rid, DEVELOPER), /actor_not_admin/);
    await fails(
      () => db.query("select * from admin_mfa_cleanups_pending($1)", [DEVELOPER]),
      /actor_not_admin/,
    );
    await fails(
      () =>
        db.query("select * from change_admin_member_role($1,$2,'admin')", [
          DEVELOPER,
          MOD,
        ]),
      /actor_not_admin/,
    );
    await fails(
      () => call("admin_mfa_recoveries_pending($1)", [DEVELOPER]),
      /actor_not_admin/,
    );
    await fails(() => approveEx(rid, ADMIN), /actor_not_developer/);
    await fails(() => denyEx(rid, ADMIN), /actor_not_developer/);
    await fails(
      () => db.query("select * from admin_mfa_recoveries_exceptional($1)", [ADMIN]),
      /actor_not_developer/,
    );
    await fails(
      () => db.query("select * from admin_mfa_cleanups_for_developer($1)", [ADMIN]),
      /actor_not_developer/,
    );
    await fails(() => approveEx(rid, MOD), /actor_not_developer/);
    await fails(() => approveEx(rid, NOBODY), /actor_not_developer/);
  });
});

describe("asignación del primer Developer (solo operador)", () => {
  const FNS = [
    "public.operator_grant_developer(uuid,text)",
    "public.operator_revoke_developer(uuid,text)",
  ];

  it("ningún rol de API puede ejecutar las funciones de operador (ni service_role)", async () => {
    for (const fn of FNS) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(await canExecute(role, fn)).toBe(false);
      }
    }
    expect(
      await canExecute("service_role", "public.admin_mfa_recovery_peer_available(uuid)"),
    ).toBe(false);
  });

  it("las funciones reemplazadas conservan sus permisos: solo service_role, nada para clientes", async () => {
    for (const fn of [
      "public.admin_mfa_recovery_create(uuid,text)",
      "public.admin_mfa_recovery_current(uuid)",
      "public.change_admin_member_role(uuid,uuid,text)",
      "public.admin_remove_member_with_mfa_reset(uuid,uuid)",
    ]) {
      expect(await canExecute("service_role", fn), fn).toBe(true);
      for (const role of ["public", "anon", "authenticated"]) {
        expect(await canExecute(role, fn), `${role} ${fn}`).toBe(false);
      }
    }
    // remove_admin_member NO es invocable directamente desde la fase 1 y el reemplazo no lo reabre
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(await canExecute(role, "public.remove_admin_member(uuid,uuid)"), role).toBe(
        false,
      );
    }
    // el «guard» sigue siendo interno (ningún rol de API los ejecuta)
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(await canExecute(role, "public.admin_mfa_recoveries_guard()")).toBe(false);
    }
  });

  it("las RPC de Developer solo las ejecuta service_role", async () => {
    for (const fn of [
      "public.admin_mfa_recovery_approve_exceptional(uuid,uuid,text)",
      "public.admin_mfa_recovery_deny_exceptional(uuid,uuid,text)",
      "public.admin_mfa_recoveries_exceptional(uuid)",
      "public.admin_mfa_cleanups_for_developer(uuid)",
    ]) {
      expect(await canExecute("service_role", fn)).toBe(true);
      for (const role of ["public", "anon", "authenticated"]) {
        expect(await canExecute(role, fn)).toBe(false);
      }
    }
  });

  it("concede Developer a un moderator con TOTP verificado, deja auditoría y no permite repetirlo", async () => {
    const out = await call("operator_grant_developer($1,$2)", [
      MOD,
      "primer developer, ticket 1",
    ]);
    expect(out).toMatchObject({
      ok: true,
      previous_role: "moderator",
      new_role: "developer",
    });
    expect(
      (
        await db.query<{ role: string }>(
          "select role from admin_roles where user_id=$1",
          [MOD],
        )
      ).rows[0].role,
    ).toBe("developer");
    const audit = await db.query<Record<string, unknown>>(
      "select * from admin_developer_audit",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: "granted",
      target_user_id: MOD,
      previous_role: "moderator",
      new_role: "developer",
      operator_note: "primer developer, ticket 1",
    });
    await fails(
      () => call("operator_grant_developer($1,$2)", [MOD, "otra vez"]),
      /grant_requires_moderator/,
    );
  });

  it("rechaza sin nota, sin rol, un admin, un moderator sin TOTP verificado y una cuenta inexistente", async () => {
    await fails(
      () => call("operator_grant_developer($1,$2)", [MOD, "  "]),
      /invalid_argument/,
    );
    await fails(
      () => call("operator_grant_developer($1,$2)", [MOD, "x".repeat(81)]),
      /invalid_argument/,
    );
    await fails(
      () => call("operator_grant_developer($1,$2)", [NOBODY, "n"]),
      /member_not_found/,
    );
    await fails(
      () => call("operator_grant_developer($1,$2)", [ADMIN, "n"]),
      /grant_requires_moderator/,
    );
    await db.query("delete from auth.mfa_factors where id=$1", [MOD_F]);
    await db.query(
      "insert into auth.mfa_factors(id,user_id,status) values($1,$2,'unverified')",
      [id(108, "f"), MOD],
    );
    await fails(
      () => call("operator_grant_developer($1,$2)", [MOD, "n"]),
      /mfa_not_enrolled/,
    );
    expect((await db.query("select * from admin_developer_audit")).rows).toEqual([]);
  });

  it("la revocación vuelve a moderator (no borra el acceso) y la auditoría es append-only", async () => {
    await fails(
      () => call("operator_revoke_developer($1,$2)", [MOD, "n"]),
      /revoke_requires_developer/,
    );
    const out = await call("operator_revoke_developer($1,$2)", [DEVELOPER, "rotación"]);
    expect(out).toMatchObject({
      ok: true,
      previous_role: "developer",
      new_role: "moderator",
    });
    expect(
      (
        await db.query<{ role: string }>(
          "select role from admin_roles where user_id=$1",
          [DEVELOPER],
        )
      ).rows[0].role,
    ).toBe("moderator");
    await fails(
      () => db.query("update admin_developer_audit set operator_note='x'"),
      /developer_audit_append_only/,
    );
    await fails(
      () => db.query("delete from admin_developer_audit"),
      /developer_audit_append_only/,
    );
  });
});

describe("elegibilidad de otro administrador", () => {
  it("cuenta como elegible: admin distinto, vigente, no bloqueado ni eliminado y con TOTP verificado", async () => {
    expect(await peer(ADMIN)).toBe(true);
  });

  it("no es elegible: sin TOTP verificado, TOTP sin verificar, bloqueado o eliminado", async () => {
    await db.query("delete from auth.mfa_factors where id=$1", [ADMIN2_F]);
    expect(await peer(ADMIN)).toBe(false);
    await db.query(
      "insert into auth.mfa_factors(id,user_id,status) values($1,$2,'unverified')",
      [id(107, "f"), ADMIN2],
    );
    expect(await peer(ADMIN)).toBe(false);
    await db.query("update auth.mfa_factors set status='verified' where user_id=$1", [
      ADMIN2,
    ]);
    expect(await peer(ADMIN)).toBe(true);
    await db.query(
      "update auth.users set banned_until = now() + interval '1 day' where id=$1",
      [ADMIN2],
    );
    expect(await peer(ADMIN)).toBe(false);
    await db.query(
      "update auth.users set banned_until = now() - interval '1 day' where id=$1",
      [ADMIN2],
    );
    expect(await peer(ADMIN)).toBe(true); // un bloqueo vencido no cuenta
    await db.query("update auth.users set deleted_at = now() where id=$1", [ADMIN2]);
    expect(await peer(ADMIN)).toBe(false);
  });

  it("no es elegible quien ya no es admin, ni el propio solicitante; un developer o moderator no cuenta", async () => {
    await soleAdmin();
    expect(await peer(ADMIN)).toBe(false);
    expect(await peer(DEVELOPER)).toBe(true); // para un developer el par admin sí existe
  });

  it("la pérdida declarada del dispositivo o una solicitud propia NO vuelve inelegible al otro admin", async () => {
    const c = await create(ADMIN2);
    expect(c.ok).toBe(true); // ADMIN2 declara haber perdido su dispositivo
    expect(await peer(ADMIN)).toBe(true);
    const rid = await pendingFor(ADMIN);
    expect(await approveEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "peer_available",
    });
  });
});

describe("aprobación excepcional", () => {
  it("el único admin puede solicitar si existe un Developer; sin Developer sigue sin camino", async () => {
    await soleAdmin();
    expect((await create(ADMIN)).ok).toBe(true);
  });

  it("el titular ve «hay quien apruebe» con otro admin o con un Developer; sin ninguno, no", async () => {
    const has = async (user: string) =>
      (await call("admin_mfa_recovery_current($1)", [user])).hasApprover;
    expect(await has(ADMIN)).toBe(true); // otro admin
    await soleAdmin();
    expect(await has(ADMIN)).toBe(true); // un Developer
    await db.query("update admin_roles set role='moderator' where role='developer'");
    expect(await has(ADMIN)).toBe(false); // ninguno
    expect(await has(MOD)).toBe(true); // un moderator siempre tiene un admin
  });

  it("sin Developer ni otro admin la solicitud sigue rechazada (comportamiento de la fase 2)", async () => {
    await soleAdmin();
    await db.query("update admin_roles set role='moderator' where role='developer'");
    expect(await create(ADMIN)).toMatchObject({ ok: false, reason: "no_approver" });
  });

  it("un Developer distinto aprueba SOLO si el solicitante es el único admin elegible; deja constancia", async () => {
    await soleAdmin();
    const rid = await pendingFor(ADMIN);
    const out = await approveEx(rid, DEVELOPER);
    expect(out).toMatchObject({
      ok: true,
      recoveryId: rid,
      userId: ADMIN,
      cancelRotation: 1,
    });
    expect(out.email).toBe("admin@example.test");
    expect(await row(rid)).toMatchObject({
      status: "approved",
      approved_by: DEVELOPER,
      approval_kind: "exceptional",
      approver_role: "developer",
      cancel_hash: CANCEL,
    });
    const ev = await events(rid);
    expect(ev.filter((e) => e.event === "approved")).toEqual([
      { event: "approved", actor_user_id: DEVELOPER, detail: "exceptional:developer" },
    ]);
  });

  it("es idempotente: una segunda aprobación no repite eventos ni cambia la solicitud", async () => {
    await soleAdmin();
    const rid = await pendingFor(ADMIN);
    await approveEx(rid, DEVELOPER);
    expect(await approveEx(rid, DEVELOPER2, sha("otro"))).toMatchObject({
      ok: false,
      reason: "not_pending",
      status: "approved",
    });
    expect((await events(rid)).filter((e) => e.event === "approved")).toHaveLength(1);
    expect((await row(rid)).cancel_hash).toBe(CANCEL);
    expect((await row(rid)).approved_by).toBe(DEVELOPER);
  });

  it("si existe otro admin elegible se rechaza con un estado controlado y la solicitud no cambia", async () => {
    const rid = await pendingFor(ADMIN);
    expect(await approveEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "peer_available",
    });
    expect(await row(rid)).toMatchObject({
      status: "pending_approval",
      approval_kind: "peer",
    });
    expect(await denyEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "peer_available",
    });
    // el flujo normal sigue funcionando para esa misma solicitud
    expect((await approve(rid, ADMIN2)).ok).toBe(true);
    expect(await row(rid)).toMatchObject({ approval_kind: "peer", approver_role: null });
  });

  it("la elegibilidad se revalida en el instante de aprobar (cambios entre la solicitud y la aprobación)", async () => {
    await soleAdmin();
    const rid = await pendingFor(ADMIN);
    // reaparece un admin elegible (p. ej. recupera el rol) después de la solicitud
    await db.query("update admin_roles set role='admin' where user_id=$1", [ADMIN2]);
    expect(await approveEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "peer_available",
    });
    // ese admin pierde su TOTP: vuelve a ser el único elegible
    await db.query("delete from auth.mfa_factors where id=$1", [ADMIN2_F]);
    expect((await approveEx(rid, DEVELOPER)).ok).toBe(true);
  });

  it("toma el lock compartido de roles ANTES de cualquier FOR UPDATE", async () => {
    for (const fn of [
      "public.admin_mfa_recovery_approve_exceptional(uuid,uuid,text)",
      "public.admin_mfa_recovery_deny_exceptional(uuid,uuid,text)",
    ]) {
      const def = (
        await db.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) d", [
          fn,
        ])
      ).rows[0].d;
      expect(def.indexOf("upmina_lock_admin_roles")).toBeGreaterThan(-1);
      expect(def.indexOf("upmina_lock_admin_roles")).toBeLessThan(
        def.indexOf("for update"),
      );
    }
  });

  it("nadie aprueba su propia recuperación (un Developer que pide la suya)", async () => {
    const rid = await pendingFor(DEVELOPER);
    expect(await approveEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "self_approval",
    });
    expect(await denyEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "self_approval",
    });
    expect(await row(rid)).toMatchObject({ status: "pending_approval" });
  });

  it("solo para un solicitante ADMIN: moderators y developers siguen el flujo normal", async () => {
    const rid = await pendingFor(MOD);
    expect(await approveEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "not_eligible",
    });
    expect(await denyEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "not_eligible",
    });
    const rid2 = await pendingFor(DEVELOPER2);
    expect(await approveEx(rid2, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "not_eligible",
    });
  });

  it("solicitud inexistente, caducada, cancelada, con correo o rol cambiado o ya resuelta", async () => {
    await soleAdmin();
    expect(await approveEx(id(900), DEVELOPER)).toMatchObject({
      ok: false,
      reason: "not_found",
    });

    const pending = await create(ADMIN);
    expect(await approveEx(pending.recoveryId as string, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "not_pending",
      status: "pending_email",
    });
    await verify(ADMIN);
    // caducada
    await db.exec(
      "alter table admin_mfa_recoveries disable trigger admin_mfa_recoveries_guard",
    );
    await db.query(
      "update admin_mfa_recoveries set expires_at = now() - interval '1 second' where id=$1",
      [pending.recoveryId],
    );
    await db.exec(
      "alter table admin_mfa_recoveries enable trigger admin_mfa_recoveries_guard",
    );
    expect(await approveEx(pending.recoveryId as string, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(await row(pending.recoveryId as string)).toMatchObject({ status: "expired" });
    expect(await approveEx(pending.recoveryId as string, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "not_pending",
    });

    // correo cambiado
    const rid = await pendingFor(ADMIN);
    await db.query("update auth.users set email='otro@example.test' where id=$1", [
      ADMIN,
    ]);
    expect(await approveEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "email_changed",
    });
    expect(await row(rid)).toMatchObject({
      status: "cancelled",
      closed_reason: "email_changed",
    });
    await db.query("update auth.users set email='admin@example.test' where id=$1", [
      ADMIN,
    ]);

    // rol cambiado: el solicitante deja de ser admin
    const rid2 = await pendingFor(ADMIN);
    await db.query("update admin_roles set role='admin' where user_id=$1", [ADMIN2]);
    await db.query("update admin_roles set role='moderator' where user_id=$1", [ADMIN]);
    expect(await approveEx(rid2, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "role_changed",
    });
    expect(await row(rid2)).toMatchObject({
      status: "cancelled",
      closed_reason: "role_changed",
    });
  });

  it("rechazo: motivo obligatorio, idempotente y distinto del rechazo de un admin", async () => {
    await soleAdmin();
    const rid = await pendingFor(ADMIN);
    expect(await denyEx(rid, DEVELOPER, "  ")).toMatchObject({
      ok: false,
      reason: "reason_required",
    });
    const out = await denyEx(rid, DEVELOPER, "Parece una suplantación");
    expect(out).toMatchObject({ ok: true, recoveryId: rid, userId: ADMIN });
    expect(await row(rid)).toMatchObject({
      status: "denied",
      closed_by: DEVELOPER,
      closed_reason: "denied_by_developer",
      denied_reason: "Parece una suplantación",
    });
    expect(await denyEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "not_pending",
    });
    expect((await events(rid)).filter((e) => e.event === "denied")).toEqual([
      { event: "denied", actor_user_id: DEVELOPER, detail: "denied_by_developer" },
    ]);
    // aprobar una solicitud ya rechazada no es posible
    expect(await approveEx(rid, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "not_pending",
    });
  });

  it("puede revertir SU aprobación excepcional antes de ejecutar, pero no una aprobación entre administradores", async () => {
    await soleAdmin();
    const rid = await pendingFor(ADMIN);
    await approveEx(rid, DEVELOPER);
    expect((await denyEx(rid, DEVELOPER2, "Revocado")).ok).toBe(true);
    expect(await row(rid)).toMatchObject({ status: "denied", cancel_hash: null });

    await db.query("update admin_roles set role='admin' where user_id=$1", [ADMIN2]);
    const rid2 = await pendingFor(MOD);
    await approve(rid2, ADMIN);
    expect(await denyEx(rid2, DEVELOPER)).toMatchObject({
      ok: false,
      reason: "not_pending",
      status: "approved",
    });
  });

  it("el tipo de aprobación es inmutable una vez aprobada, y las solicitudes anteriores quedan como 'peer'", async () => {
    const rid = await pendingFor(MOD);
    await approve(rid, ADMIN);
    expect(await row(rid)).toMatchObject({ approval_kind: "peer", approver_role: null });
    await fails(
      () =>
        db.query(
          "update admin_mfa_recoveries set approval_kind='exceptional', approver_role='developer' where id=$1",
          [rid],
        ),
      /mfa_recovery_approval_immutable/,
    );
    await fails(
      () =>
        db.query(
          "update admin_mfa_recoveries set approval_kind='exceptional' where id=$1",
          [rid],
        ),
      /approval_check|mfa_recovery_approval_immutable/,
    );
  });

  it("reutiliza la fase 2: aviso entregado + espera, instantánea de factores y borrado exacto", async () => {
    await soleAdmin();
    await db.query("delete from auth.mfa_factors where id=$1", [ADMIN2_F]);
    const rid = await pendingFor(ADMIN);
    await approveEx(rid, DEVELOPER);
    // sin aviso entregado no se puede ejecutar
    expect(await begin(ADMIN, rid)).toMatchObject({
      ok: false,
      reason: "notice_pending",
    });
    await mailStart(rid, "approved", `recovery:${rid}:approved:1`);
    await db.query("select admin_mfa_recovery_mail_result($1,true,'prov-ex',null)", [
      `recovery:${rid}:approved:1`,
    ]);
    await db.query("select admin_mfa_recovery_mail_event('prov-ex','delivered')");
    expect(await begin(ADMIN, rid)).toMatchObject({ ok: false, reason: "waiting" });
    await db.query(
      "update admin_mfa_recoveries set approved_at = now() - interval '20 minutes' where id=$1",
      [rid],
    );
    await db.query(
      "update admin_mfa_recovery_mail set delivered_at = now() - interval '20 minutes' where recovery_id=$1",
      [rid],
    );
    const b = await begin(ADMIN, rid);
    expect(b).toMatchObject({ ok: true });
    expect(b.factorIds).toEqual([ADMIN_F]); // instantánea exacta, solo sus ids
    // la aprobación no modifica roles ni factores
    expect(
      (
        await db.query<{ role: string }>(
          "select role from admin_roles where user_id=$1",
          [ADMIN],
        )
      ).rows[0].role,
    ).toBe("admin");
  });

  it("cancelar desde el enlace del correo sigue funcionando y no depende del tipo de aprobación", async () => {
    await soleAdmin();
    const rid = await pendingFor(ADMIN);
    await approveEx(rid, DEVELOPER);
    const out = await call("admin_mfa_recovery_cancel_by_token($1)", [CANCEL]);
    expect(out.ok).toBe(true);
    expect(await row(rid)).toMatchObject({ status: "cancelled" });
  });
});

describe("listas de Developer", () => {
  it("recuperaciones: solo elegibles + historial excepcional, sin correo ni identificadores sensibles", async () => {
    await soleAdmin();
    const rid = await pendingFor(ADMIN);
    const modRid = await pendingFor(MOD); // no elegible para la excepción: no se lista
    const list = await db.query<Record<string, unknown>>(
      "select * from admin_mfa_recoveries_exceptional($1)",
      [DEVELOPER],
    );
    expect(list.rows.map((r) => r.out_id)).toEqual([rid]);
    expect(list.rows[0]).toMatchObject({
      out_username: "unica_admin",
      out_role: "admin",
      out_status: "pending_approval",
      out_eligible: true,
      out_approval_kind: "peer",
    });
    expect(JSON.stringify(list.rows)).not.toMatch(
      /example\.test|hash|cancel|challenge|factor/i,
    );
    expect(list.rows.map((r) => r.out_id)).not.toContain(modRid);

    await approveEx(rid, DEVELOPER);
    const after = await db.query<Record<string, unknown>>(
      "select * from admin_mfa_recoveries_exceptional($1)",
      [DEVELOPER2],
    );
    expect(after.rows[0]).toMatchObject({
      out_status: "approved",
      out_approval_kind: "exceptional",
      out_approver_role: "developer",
      out_approver_username: "el_dev",
      out_eligible: false,
    });
  });

  it("una solicitud deja de listarse si aparece otro admin elegible, y el propio Developer no ve la suya", async () => {
    const rid = await pendingFor(ADMIN);
    expect(
      (await db.query("select * from admin_mfa_recoveries_exceptional($1)", [DEVELOPER]))
        .rows,
    ).toEqual([]);
    await soleAdmin();
    expect(
      (await db.query("select * from admin_mfa_recoveries_exceptional($1)", [DEVELOPER]))
        .rows,
    ).toHaveLength(1);
    expect(rid).toBeTruthy();
  });

  it("limpiezas: solo lectura, correo enmascarado y sin ids de factores", async () => {
    await db.query(
      `insert into admin_mfa_resets(user_id,status,old_role,requested_by,requested_at,factor_ids,attempts,last_error_class)
       values($1,'pending','moderator',$2,now(),array[$3::uuid, $4::uuid],2,'auth_delete_failed')`,
      [MOD, ADMIN, OLD_F, id(102, "f")],
    );
    await db.query(
      `insert into admin_mfa_resets(user_id,status,old_role,requested_by,requested_at,factor_ids,completed_at,factors_deleted)
       values($1,'completed','moderator',$2,now() - interval '1 day',array[$3::uuid],now(),1)`,
      [NOBODY, ADMIN, id(103, "f")],
    );
    const before = JSON.stringify(
      (await db.query("select * from admin_mfa_resets order by id")).rows,
    );
    const list = await db.query<Record<string, unknown>>(
      "select * from admin_mfa_cleanups_for_developer($1)",
      [DEVELOPER],
    );
    expect(list.rows).toHaveLength(2);
    expect(list.rows[0]).toMatchObject({
      out_status: "pending",
      out_attempts: 2,
      out_last_error_class: "auth_delete_failed",
      out_factor_count: 2,
      out_username: "moderadora",
      out_email_masked: "m***@e***.test",
    });
    expect(list.rows[1]).toMatchObject({
      out_status: "completed",
      out_factors_deleted: 1,
    });
    const text = JSON.stringify(list.rows);
    expect(text).not.toContain("mod@example.test");
    expect(text).not.toContain(OLD_F);
    expect(text).not.toContain(id(102, "f"));
    expect(
      JSON.stringify((await db.query("select * from admin_mfa_resets order by id")).rows),
    ).toBe(before); // lectura: no cambia nada
    const vol = await db.query<{ v: string }>(
      "select provolatile v from pg_proc where proname='admin_mfa_cleanups_for_developer'",
    );
    expect(vol.rows[0].v).toBe("s"); // STABLE
  });
});

describe("rollback", () => {
  const rollback = () => readFileSync(resolve(ROLLBACK), "utf8");

  it("se niega con aprobaciones excepcionales, auditoría de Developer o roles Developer vigentes", async () => {
    await fails(() => db.exec(rollback()), /rollback_refused/);
    await soleAdmin();
    const rid = await pendingFor(ADMIN);
    await approveEx(rid, DEVELOPER);
    await db.query("update admin_roles set role='moderator' where role='developer'");
    await fails(
      () => db.exec(rollback()),
      /rollback_refused_exceptional_approvals_exist/,
    );
  });

  it("sin historial restaura las funciones anteriores y quita lo añadido", async () => {
    await db.query("update admin_roles set role='moderator' where role='developer'");
    await db.exec(rollback());
    const cols = await db.query(
      "select column_name from information_schema.columns where table_name='admin_mfa_recoveries' and column_name in ('approval_kind','approver_role')",
    );
    expect(cols.rows).toEqual([]);
    const gone = await db.query(
      "select proname from pg_proc where proname in ('admin_mfa_recovery_approve_exceptional','operator_grant_developer','admin_mfa_cleanups_for_developer','admin_mfa_recovery_peer_available')",
    );
    expect(gone.rows).toEqual([]);
    // versión anterior: Admin vuelve a poder cambiar a developer
    const out = await db.query<{ out_new_role: string }>(
      "select * from change_admin_member_role($1,$2,'developer')",
      [ADMIN, MOD],
    );
    expect(out.rows[0].out_new_role).toBe("developer");
    // y el único admin vuelve a no tener recuperación automática
    await db.query("update admin_roles set role='moderator' where user_id=$1", [ADMIN2]);
    await db.query("update admin_roles set role='moderator' where role='developer'");
    expect(await create(ADMIN)).toMatchObject({ ok: false, reason: "no_approver" });
  });
});

describe("procedimiento del operador (plantilla)", () => {
  const template = readFileSync(resolve("supabase/operator/developer-role.sql"), "utf8");
  const executable = template
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  it("sin marcadores sustituidos no hace nada: falla al convertir el texto a uuid", async () => {
    expect(executable).toContain("'<ID_DE_LA_CUENTA>'::uuid");
    await fails(() => db.exec(executable), /invalid input syntax for type uuid/);
    expect((await db.query("select * from admin_developer_audit")).rows).toEqual([]);
  });

  it("contiene solo marcadores: ningún uuid real y las asignaciones están comentadas", () => {
    expect(template).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(executable).not.toMatch(/operator_(grant|revoke)_developer/);
    expect(template).toMatch(/-- select public\.operator_revoke_developer\(/);
    // el alta por el operador se retiró: la plantilla ya no ofrece asignar Developer
    expect(template).not.toMatch(/select public\.operator_grant_developer/);
  });
});
