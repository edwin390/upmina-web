// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";
import { detectImpersonation, type IdentityField } from "./username-impersonation";
import {
  ALLOWED,
  AMBIGUOUS_BLOCKED,
  DISPLAY_ALLOWED,
  DISPLAY_BLOCKED,
  DISPLAY_KNOWN_GAPS,
  UNEQUIVOCAL,
} from "./username-impersonation-vectors";

// SQL REAL (PGlite) de 20261116120000_username_impersonation_guard.sql: la detección de PostgreSQL
// debe coincidir con la del módulo TypeScript (mismos vectores, mismos motivos) para username y
// display_name; el trigger debe cubrir cualquier escritura de profiles; y el mecanismo de grants debe
// ser admin-only, específico de usuario + campo + valor, auditable y sin efectos sobre usuarios,
// roles o permisos. PGlite = una sola conexión (la concurrencia real no es ejecutable aquí).

const migration = (n: string) =>
  readFileSync(`supabase/migrations/${n}`, "utf8").replace(/\r\n/g, "\n");
const GUARD = migration("20261116120000_username_impersonation_guard.sql");
const USERNAME_MIGRATION = migration("20261003120000_community_username_foundation.sql");
const REAL_USERNAME_CHECK = USERNAME_MIGRATION.match(
  /add constraint profiles_username_format check \(([\s\S]*?)\n {2}\);/,
)![1];
const uid = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = uid(1);
const MODERATOR = uid(2);
const MINA = uid(3); // futura titular legítima (hoy un usuario cualquiera)
const OTHER = uid(4);
let db: TestDatabase;

beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`create table admin_roles(user_id uuid primary key, role text);
    alter table profiles add column if not exists username text;
    alter table profiles add column if not exists display_name text;
    alter table profiles add column if not exists bio text;
    alter table profiles add constraint profiles_username_format check (${REAL_USERNAME_CHECK});
    alter table profiles add constraint profiles_display_name_length check (
      display_name is null or (char_length(display_name) between 1 and 40 and btrim(display_name) <> ''));`);
  await db.exec(GUARD);
}, 90000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
  for (const id of [ADMIN, MODERATOR, MINA, OTHER]) {
    await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
      id,
    ]);
  }
  await db.query(
    "insert into admin_roles(user_id,role) values($1,'admin'),($2,'moderator')",
    [ADMIN, MODERATOR],
  );
});
afterEach(async () => {
  try {
    await db.exec("reset role");
  } catch {
    /* transacción abortada */
  }
  await db.exec("rollback");
});

const profileCount = async () =>
  (await db.query<{ n: number }>("select count(*)::int n from profiles")).rows[0].n;

const sqlReason = async (name: string, field: IdentityField = "username") =>
  (
    await db.query<{ r: string | null }>(
      "select public.community_identity_impersonation($1,$2) r",
      [name, field],
    )
  ).rows[0].r;

async function fails(sql: string, params: unknown[], pattern: string | RegExp) {
  await db.exec("savepoint s");
  let message = "";
  let code = "";
  try {
    await db.query(sql, params);
  } catch (e) {
    message = String((e as Error).message);
    code = String((e as { code?: string }).code ?? "");
  }
  await db.exec("rollback to savepoint s");
  expect(message).not.toBe("");
  expect(message).toMatch(pattern);
  return code;
}

describe("paridad PostgreSQL ↔ TypeScript · username", () => {
  it.each([...UNEQUIVOCAL, ...AMBIGUOUS_BLOCKED])(
    "bloquea y coincide el motivo: %j",
    async (n) => {
      const reason = await sqlReason(n);
      expect(reason).not.toBeNull();
      expect(reason).toBe(detectImpersonation(n));
    },
  );
  it.each(ALLOWED)("permite: %j", async (n) => {
    expect(await sqlReason(n)).toBeNull();
  });
  it("paridad sobre ~600 combinaciones generadas (prefijo × base × separador × sufijo)", async () => {
    const bases = [
      "mina",
      "upmina",
      "m1na",
      "miina",
      "upm1naa",
      "minaa",
      "amina",
      "terminal",
    ];
    const pre = ["", "real", "the", "official", "x", "fan", "1", "r3al"];
    const seps = ["", "_", "."];
    const suf = [
      "",
      "official",
      "oficial",
      "real",
      "fan",
      "fans",
      "fanpage",
      "99",
      "j",
      "x",
    ];
    const names: string[] = [];
    for (const p of pre)
      for (const b of bases)
        for (const s of seps)
          for (const f of suf) names.push([p, b, f].filter(Boolean).join(s));
    let blocked = 0;
    for (const n of names.slice(0, 600)) {
      const sql = await sqlReason(n);
      expect(sql, n).toBe(detectImpersonation(n));
      if (sql) blocked++;
    }
    expect(blocked).toBeGreaterThan(80);
    expect(blocked).toBeLessThan(600);
  });
  it("entradas nulas o vacías no son suplantación; un campo desconocido es un error controlado", async () => {
    expect(await sqlReason("")).toBeNull();
    expect(
      (
        await db.query<{ r: string | null }>(
          "select public.community_identity_impersonation(null,'username') r",
        )
      ).rows[0].r,
    ).toBeNull();
    await fails(
      "select public.community_identity_impersonation('mina','otro')",
      [],
      /invalid_argument/,
    );
    await fails(
      "select public.community_identity_impersonation('mina',null)",
      [],
      /invalid_argument/,
    );
  });
});

describe("paridad PostgreSQL ↔ TypeScript · display_name", () => {
  it.each(DISPLAY_BLOCKED)("bloquea y coincide el motivo: %j", async (n) => {
    const reason = await sqlReason(n, "display_name");
    expect(reason, n).not.toBeNull();
    expect(reason).toBe(detectImpersonation(n, "display_name"));
  });
  it.each([...DISPLAY_ALLOWED, ...DISPLAY_KNOWN_GAPS])("permite: %j", async (n) => {
    expect(await sqlReason(n, "display_name"), n).toBeNull();
  });
  it("sin regla 'embedded' en display_name, con ella en username (misma entrada)", async () => {
    expect(await sqlReason("xupminax", "username")).toBe("embedded");
    expect(await sqlReason("xupminax", "display_name")).toBeNull();
  });
  it("'declared' solo en display_name y con la misma razón que TypeScript", async () => {
    for (const n of [
      "Cuenta oficial de Mina",
      "Upmina Chat",
      "Official Account of Mina",
    ]) {
      expect(await sqlReason(n, "display_name"), n).toBe("declared");
      const u = n.replace(/ /g, "_");
      expect(await sqlReason(u, "username"), u).not.toBe("declared");
      expect(await sqlReason(u, "username"), u).toBe(detectImpersonation(u, "username"));
    }
    expect(await sqlReason("Fan de Mina", "display_name")).toBeNull();
  });
  it("esqueletos largos: cota anti-backtracking idéntica a TypeScript y en tiempo acotado", async () => {
    const t0 = Date.now();
    for (const n of [
      "mina".repeat(30),
      "de".repeat(60) + "x",
      "a".repeat(5000),
      "mina".repeat(2000),
    ]) {
      expect(await sqlReason(n, "display_name"), n.slice(0, 12)).toBe(
        detectImpersonation(n, "display_name"),
      );
    }
    expect(Date.now() - t0).toBeLessThan(15000);
  });
  it("las funciones envoltorio coinciden con la genérica", async () => {
    const r = await db.query<{ u: string | null; d: string | null }>(
      "select public.community_username_impersonation('xupminax') u, public.community_display_name_impersonation('Mina Oficial') d",
    );
    expect(r.rows[0]).toEqual({ u: "embedded", d: "affixed" });
  });
  it("paridad sobre combinaciones con espacios, mayúsculas y adornos", async () => {
    const words = ["mina", "Mina", "UPMINA", "M i n a", "m1na", "Up Mina", "mina 🌸"];
    const pre = ["", "Real ", "The ", "Team ", "Soy ", "Fan de ", "Hola "];
    const suf = ["", " Oficial", " Fanpage", " Staff", " Lopez", " 2", " ✔️", " ™"];
    for (const p of pre)
      for (const w of words)
        for (const s of suf) {
          const n = `${p}${w}${s}`;
          expect(await sqlReason(n, "display_name"), n).toBe(
            detectImpersonation(n, "display_name"),
          );
        }
  });
});

describe("trigger de profiles · username", () => {
  it("INSERT directo de una variante falla con SQLSTATE UR001 / username_reserved", async () => {
    for (const n of [
      "mina",
      "real_upm1naa",
      "mi.na",
      "upmine",
      "minafan",
      "mina_support",
    ]) {
      const code = await fails(
        "insert into profiles(user_id,username) values($1,$2)",
        [MINA, n],
        /username_reserved/,
      );
      expect(code, n).toBe("UR001");
    }
  });
  it("nombres distintos siguen creándose con normalidad", async () => {
    await db.query("insert into profiles(user_id,username) values($1,'carmina')", [MINA]);
    await db.query("insert into profiles(user_id,username) values($1,'minato')", [OTHER]);
  });
  it("UPDATE de username a una variante falla; a un nombre libre funciona", async () => {
    await db.query("insert into profiles(user_id,username) values($1,'edwin390')", [
      OTHER,
    ]);
    await fails(
      "update profiles set username=$2 where user_id=$1",
      [OTHER, "m1na"],
      /username_reserved/,
    );
    await db.query("update profiles set username='edwin391' where user_id=$1", [OTHER]);
  });
});

describe("trigger de profiles · display_name", () => {
  it("INSERT con un display_name protegido falla con SQLSTATE UR002 / display_name_reserved", async () => {
    for (const n of [
      "Mina",
      "Mina Oficial",
      "Team Upmina",
      "M1na",
      "Up_Mina",
      "Upminaa Web",
    ]) {
      const code = await fails(
        "insert into profiles(user_id,username,display_name) values($1,'persona_normal',$2)",
        [MINA, n],
        /display_name_reserved/,
      );
      expect(code, n).toBe("UR002");
    }
  });
  it("UPDATE del display_name a un valor protegido falla; a uno personal funciona; NULL funciona", async () => {
    await db.query(
      "insert into profiles(user_id,username,display_name) values($1,'persona',$2)",
      [OTHER, "Ana"],
    );
    await fails(
      "update profiles set display_name=$2 where user_id=$1",
      [OTHER, "Mina Staff"],
      /display_name_reserved/,
    );
    await db.query(
      "update profiles set display_name='Fan de Mina desde 2020' where user_id=$1",
      [OTHER],
    );
    await db.query("update profiles set display_name=null where user_id=$1", [OTHER]);
    await db.query("update profiles set display_name='   ' where user_id=$1 and false", [
      OTHER,
    ]);
  });
  it("frases personales que mencionan a Mina o Upmina se permiten", async () => {
    const base = await profileCount();
    let i = 0;
    for (const n of [
      "Mina Lopez",
      "Soy fan de Mina",
      "Me encanta Upmina",
      "Mina's biggest fan",
    ]) {
      const id = uid(100 + i);
      await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
        id,
      ]);
      await db.query(
        "insert into profiles(user_id,username,display_name) values($1,$2,$3)",
        [id, `persona_${i}`, n],
      );
      i++;
    }
    expect(await profileCount()).toBe(base + 4);
  });
});

describe("no hay forma de eludirlo", () => {
  it("UPSERT (INSERT … ON CONFLICT DO UPDATE) con valores protegidos falla en ambos campos", async () => {
    await db.query(
      "insert into profiles(user_id,username,display_name) values($1,'persona','Ana')",
      [OTHER],
    );
    await fails(
      `insert into profiles(user_id,username) values($1,'mina')
       on conflict (user_id) do update set username = excluded.username`,
      [OTHER],
      /username_reserved/,
    );
    await fails(
      `insert into profiles(user_id,username,display_name) values($1,'persona','Mina')
       on conflict (user_id) do update set display_name = excluded.display_name`,
      [OTHER],
      /display_name_reserved/,
    );
  });
  it("un INSERT de varias filas es atómico: una fila protegida impide todas", async () => {
    const base = await profileCount();
    await fails(
      "insert into profiles(user_id,username) values($1,'persona_a'),($2,'real_mina')",
      [MINA, OTHER],
      /username_reserved/,
    );
    expect(await profileCount()).toBe(base);
  });
  it("una función 'RPC' SECURITY DEFINER (dueño postgres) que escribe en profiles tampoco lo elude", async () => {
    await db.exec(`create function tmp_rpc_create(p_user uuid, p_username text, p_display text)
      returns void language plpgsql security definer set search_path = pg_catalog, public as $f$
      begin insert into profiles(user_id,username,display_name) values(p_user,p_username,p_display); end $f$;
      create function tmp_rpc_rename(p_user uuid, p_display text)
      returns void language plpgsql security definer set search_path = pg_catalog, public as $f$
      begin update profiles set display_name = p_display where user_id = p_user; end $f$;`);
    await fails("select tmp_rpc_create($1,'upmina','Ana')", [MINA], /username_reserved/);
    await fails(
      "select tmp_rpc_create($1,'persona','Official Mina')",
      [MINA],
      /display_name_reserved/,
    );
    await db.query("select tmp_rpc_create($1,'persona','Ana')", [MINA]);
    await fails(
      "select tmp_rpc_rename($1,'Team Upmina')",
      [MINA],
      /display_name_reserved/,
    );
  });
  it("con los roles de API (service_role) el trigger sigue aplicándose; las sesiones normales no escriben en profiles", async () => {
    const roles = await db.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname in ('service_role','authenticated','anon')",
    );
    const present = new Set(roles.rows.map((r) => r.rolname));
    if (present.has("service_role")) {
      await db.exec("grant select, insert, update on profiles to service_role");
      await db.exec("set local role service_role");
      await fails(
        "insert into profiles(user_id,username) values($1,'mina')",
        [MINA],
        /username_reserved/,
      );
      await fails(
        "insert into profiles(user_id,username,display_name) values($1,'persona','Mina')",
        [MINA],
        /display_name_reserved/,
      );
      await db.exec("reset role");
    }
    for (const role of ["authenticated", "anon"]) {
      if (!present.has(role)) continue;
      const r = await db.query<{ ok: boolean }>(
        "select has_table_privilege($1,'public.profiles','insert,update') ok",
        [role],
      );
      expect(r.rows[0].ok, role).toBe(false);
    }
  });
  it("un nombre protegido no concede privilegios: sin roles, sin filas auxiliares", async () => {
    const before = await db.query<{ r: number; u: number }>(
      "select (select count(*) from admin_roles)::int r, (select count(*) from auth.users)::int u",
    );
    await fails(
      "insert into profiles(user_id,username) values($1,'official_mina')",
      [MINA],
      /username_reserved/,
    );
    const after = await db.query<{ r: number; u: number }>(
      "select (select count(*) from admin_roles)::int r, (select count(*) from auth.users)::int u",
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(
      (await db.query("select 1 from admin_roles where user_id=$1", [MINA])).rows,
    ).toHaveLength(0);
  });
});

describe("perfiles existentes (compatibilidad)", () => {
  it("un perfil previo con username o display_name conflictivos NO se bloquea en cambios ajenos", async () => {
    await db.exec("set local session_replication_role = replica");
    await db.query(
      "insert into profiles(user_id,username,display_name,bio) values($1,'upmina','Mina Oficial','x')",
      [OTHER],
    );
    await db.exec("set local session_replication_role = origin");
    await db.query("update profiles set bio='nueva bio' where user_id=$1", [OTHER]);
    await db.query("update profiles set username='upmina' where user_id=$1", [OTHER]); // sin cambio real
    await db.query("update profiles set display_name='Mina Oficial' where user_id=$1", [
      OTHER,
    ]); // sin cambio real
    const row = await db.query<{ username: string; display_name: string; bio: string }>(
      "select username, display_name, bio from profiles where user_id=$1",
      [OTHER],
    );
    expect(row.rows[0]).toEqual({
      username: "upmina",
      display_name: "Mina Oficial",
      bio: "nueva bio",
    });
  });
  it("cambiar uno de los campos a otro valor protegido sí se rechaza; a uno libre se permite", async () => {
    await db.exec("set local session_replication_role = replica");
    await db.query(
      "insert into profiles(user_id,username,display_name) values($1,'upmina','Mina Oficial')",
      [OTHER],
    );
    await db.exec("set local session_replication_role = origin");
    await fails(
      "update profiles set username='themina' where user_id=$1",
      [OTHER],
      /username_reserved/,
    );
    await fails(
      "update profiles set display_name='Real Mina' where user_id=$1",
      [OTHER],
      /display_name_reserved/,
    );
    await db.query(
      "update profiles set display_name='Ana', username='ana_01' where user_id=$1",
      [OTHER],
    );
  });
  it("el trigger solo se dispara en INSERT y en UPDATE OF username, display_name", async () => {
    const t = await db.query<{ tgname: string; def: string }>(
      `select tgname, pg_get_triggerdef(oid) def from pg_trigger
        where tgrelid='public.profiles'::regclass and tgname like 'profiles_guard_reserved_identity%' order by 1`,
    );
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].def).toMatch(/BEFORE INSERT/);
    expect(t.rows[1].def).toMatch(/BEFORE UPDATE OF username, display_name/);
  });
});

describe("excepción administrativa futura (grants por usuario + campo + valor)", () => {
  const grant = (
    actor: string,
    user: string,
    field: string,
    value: string,
    reason = "Cuenta oficial verificada fuera de banda",
  ) =>
    db.query<{ id: string }>(
      "select public.community_identity_reservation_grant($1,$2,$3,$4,$5) id",
      [actor, user, field, value, reason],
    );

  it("grant de username: vale solo para ese usuario y ese valor exacto, no para variantes ni para el otro campo", async () => {
    const g = (await grant(ADMIN, MINA, "username", "Mina")).rows[0].id;
    expect(g).toBeTruthy();
    await db.query("insert into profiles(user_id,username) values($1,'mina')", [MINA]);
    await fails(
      "insert into profiles(user_id,username) values($1,'mina')",
      [OTHER],
      /username_reserved/,
    );
    await db.query("delete from profiles where user_id=$1", [MINA]);
    await fails(
      "insert into profiles(user_id,username) values($1,'real_mina')",
      [MINA],
      /username_reserved/,
    );
    // El grant de username NO autoriza el display_name "Mina".
    await fails(
      "insert into profiles(user_id,username,display_name) values($1,'persona','Mina')",
      [MINA],
      /display_name_reserved/,
    );
  });

  it("grant de display_name: vale solo para ese usuario y ese valor (espacios y mayúsculas normalizados)", async () => {
    await grant(ADMIN, MINA, "display_name", "  MINA   Oficial ");
    await db.query(
      "insert into profiles(user_id,username,display_name) values($1,'persona','Mina Oficial')",
      [MINA],
    );
    await db.query("delete from profiles where user_id=$1", [MINA]);
    await fails(
      "insert into profiles(user_id,username,display_name) values($1,'persona','Mina Oficial')",
      [OTHER],
      /display_name_reserved/,
    );
    await fails(
      "insert into profiles(user_id,username,display_name) values($1,'persona','Official Mina')",
      [MINA],
      /display_name_reserved/,
    );
    // Ni el display_name concede el username.
    await fails(
      "insert into profiles(user_id,username) values($1,'mina')",
      [MINA],
      /username_reserved/,
    );
  });

  it("no concede permisos ni insignias ni modifica usuarios o perfiles", async () => {
    const q =
      "select (select count(*) from admin_roles)::int r, (select count(*) from profiles)::int p, (select count(*) from auth.users)::int u";
    const before = (await db.query(q)).rows[0];
    await grant(ADMIN, MINA, "username", "upmina");
    await grant(ADMIN, MINA, "display_name", "Upmina");
    expect((await db.query(q)).rows[0]).toEqual(before);
    expect(
      (await db.query("select 1 from admin_roles where user_id=$1", [MINA])).rows,
    ).toHaveLength(0);
  });

  it("deja un registro de auditoría por campo y valor", async () => {
    await grant(ADMIN, MINA, "display_name", "Mina");
    await grant(ADMIN, MINA, "username", "mina");
    const audit = await db.query<{
      action: string;
      field: string;
      value: string;
      actor_user_id: string;
    }>(
      "select action, field, value, actor_user_id from username_reservation_audit order by id",
    );
    expect(audit.rows).toEqual([
      { action: "grant", field: "display_name", value: "mina", actor_user_id: ADMIN },
      { action: "grant", field: "username", value: "mina", actor_user_id: ADMIN },
    ]);
  });

  it("rechaza: no admin, auto-concesión, motivo corto, valor no protegido, valor inválido, campo inválido, usuario inexistente", async () => {
    const call = "select public.community_identity_reservation_grant($1,$2,$3,$4,$5)";
    const ok = "motivo suficiente aquí";
    await fails(call, [MODERATOR, MINA, "username", "mina", ok], /actor_not_admin/);
    await fails(call, [OTHER, MINA, "username", "mina", ok], /actor_not_admin/);
    await fails(call, [ADMIN, ADMIN, "username", "mina", ok], /self_grant_forbidden/);
    await fails(call, [ADMIN, MINA, "username", "mina", "corto"], /reason_required/);
    await fails(call, [ADMIN, MINA, "username", "edwin390", ok], /not_reserved/);
    await fails(call, [ADMIN, MINA, "display_name", "Ana", ok], /not_reserved/);
    await fails(call, [ADMIN, MINA, "username", ".mina", ok], /invalid_value/);
    await fails(call, [ADMIN, MINA, "display_name", "x".repeat(41), ok], /invalid_value/);
    await fails(call, [ADMIN, MINA, "bio", "mina", ok], /invalid_argument/);
    await fails(call, [ADMIN, uid(99), "username", "mina", ok], /user_not_found/);
    expect(
      (await db.query("select 1 from username_reservation_audit")).rows,
    ).toHaveLength(0);
  });

  it("un solo titular vigente por campo y valor; el mismo valor en el otro campo es independiente", async () => {
    await grant(ADMIN, MINA, "username", "mina");
    await fails(
      "select public.community_identity_reservation_grant($1,$2,'username','mina','motivo suficiente aquí')",
      [ADMIN, OTHER],
      /already_granted/,
    );
    await grant(ADMIN, OTHER, "display_name", "Mina");
  });

  it("revocar vuelve a bloquear el valor y queda auditado; no se revoca dos veces ni por un no admin", async () => {
    const id = (await grant(ADMIN, MINA, "username", "mina")).rows[0].id;
    await db.query(
      "select public.community_identity_reservation_revoke($1,$2,'Concesión retirada por error')",
      [ADMIN, id],
    );
    await fails(
      "insert into profiles(user_id,username) values($1,'mina')",
      [MINA],
      /username_reserved/,
    );
    await fails(
      "select public.community_identity_reservation_revoke($1,$2,'Concesión retirada por error')",
      [ADMIN, id],
      /already_revoked/,
    );
    await fails(
      "select public.community_identity_reservation_revoke($1,$2,'Concesión retirada por error')",
      [MODERATOR, id],
      /actor_not_admin/,
    );
    const audit = await db.query<{ action: string; field: string }>(
      "select action, field from username_reservation_audit order by id",
    );
    expect(audit.rows).toEqual([
      { action: "grant", field: "username" },
      { action: "revoke", field: "username" },
    ]);
  });

  it("la auditoría es append-only (UPDATE, DELETE y TRUNCATE fallan)", async () => {
    await grant(ADMIN, MINA, "username", "mina");
    await fails(
      "update username_reservation_audit set reason='x'",
      [],
      /audit_append_only/,
    );
    await fails("delete from username_reservation_audit", [], /audit_append_only/);
    await fails("truncate username_reservation_audit", [], /audit_append_only/);
  });
});

describe("errores controlados y concurrencia (lo ejecutable con una sola conexión)", () => {
  it("un rechazo no deja filas parciales ni rompe la transacción siguiente", async () => {
    const base = await profileCount();
    await fails(
      "insert into profiles(user_id,username,display_name) values($1,'persona','Mina')",
      [MINA],
      /display_name_reserved/,
    );
    expect(await profileCount()).toBe(base);
    await db.query(
      "insert into profiles(user_id,username,display_name) values($1,'persona','Ana')",
      [MINA],
    );
  });
  it("las funciones puras son IMMUTABLE y no toman locks propios (sin advisory locks)", async () => {
    const v = await db.query<{ proname: string; provolatile: string }>(
      `select proname, provolatile from pg_proc where pronamespace='public'::regnamespace
         and proname in ('community_username_skeleton','community_username_within_one_edit','community_identity_impersonation',
                         'community_username_impersonation','community_display_name_impersonation','community_identity_grant_value')`,
    );
    expect(v.rows).toHaveLength(6);
    for (const r of v.rows) expect(r.provolatile, r.proname).toBe("i");
    expect(GUARD).not.toMatch(/pg_advisory|lock table/i);
  });
  it("el índice único parcial impide dos grants vigentes simultáneos del mismo campo y valor", async () => {
    const idx = await db.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'username_reservation_grants_active_value'",
    );
    expect(idx.rows[0].indexdef).toMatch(
      /UNIQUE.*\(field, value\).*WHERE \(revoked_at IS NULL\)/,
    );
  });
});

describe("permisos y estructura", () => {
  it("anon/authenticated no ejecutan nada ni leen las tablas; service_role solo grant/revoke", async () => {
    const roles = await db.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname in ('anon','authenticated','service_role')",
    );
    const present = new Set(roles.rows.map((r) => r.rolname));
    const can = async (role: string, fn: string) =>
      (
        await db.query<{ ok: boolean }>(
          "select has_function_privilege($1,$2,'execute') ok",
          [role, fn],
        )
      ).rows[0].ok;
    const internal = [
      "public.community_username_skeleton(text,boolean)",
      "public.community_identity_impersonation(text,text)",
      "public.community_username_impersonation(text)",
      "public.community_display_name_impersonation(text)",
      "public.community_identity_grant_value(text,text)",
      "public.community_assert_identity_allowed(uuid,text,text)",
      "public.profiles_guard_reserved_identity()",
    ];
    const grantFn =
      "public.community_identity_reservation_grant(uuid,uuid,text,text,text)";
    const revokeFn = "public.community_identity_reservation_revoke(uuid,uuid,text)";
    for (const role of ["anon", "authenticated", "service_role"]) {
      if (!present.has(role)) continue;
      for (const fn of internal) expect(await can(role, fn), `${role} ${fn}`).toBe(false);
    }
    for (const role of ["anon", "authenticated"]) {
      if (!present.has(role)) continue;
      expect(await can(role, grantFn), role).toBe(false);
      expect(await can(role, revokeFn), role).toBe(false);
    }
    if (present.has("service_role")) {
      expect(await can("service_role", grantFn)).toBe(true);
      expect(await can("service_role", revokeFn)).toBe(true);
      for (const t of ["username_reservation_grants", "username_reservation_audit"]) {
        const r = await db.query<{ ok: boolean }>(
          "select has_table_privilege('service_role',$1,'select,insert,update,delete') ok",
          [`public.${t}`],
        );
        expect(r.rows[0].ok, t).toBe(false);
      }
    }
  });
  it("tablas con RLS activada y forzada, sin policies", async () => {
    const r = await db.query<{
      relname: string;
      rls: boolean;
      force: boolean;
      pol: number;
    }>(
      `select c.relname, c.relrowsecurity rls, c.relforcerowsecurity force,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) pol
         from pg_class c where c.relname in ('username_reservation_grants','username_reservation_audit') order by 1`,
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows)
      expect(row).toMatchObject({ rls: true, force: true, pol: 0 });
  });
  it("la migración no escribe en profiles ni en admin_roles, no crea cuentas ni insignias", () => {
    expect(GUARD).not.toMatch(/insert\s+into\s+public\.profiles/i);
    expect(GUARD).not.toMatch(/update\s+public\.profiles/i);
    expect(GUARD).not.toMatch(
      /(insert\s+into|update|delete\s+from)\s+public\.admin_roles/i,
    );
    expect(GUARD).not.toMatch(/insert\s+into\s+auth\.users/i);
    expect(GUARD).not.toMatch(/\bgrant\s+(select|insert|update|delete|all)\b/i);
  });
  it("funciones SECURITY DEFINER con search_path fijo; errcodes UR001/UR002 definidos", () => {
    const defs = GUARD.match(/create function[\s\S]*?\n\$\$;/g)!;
    for (const d of defs.filter((x) => /security definer/i.test(x))) {
      expect(d).toMatch(/set search_path = pg_catalog, public/);
    }
    expect(GUARD).toMatch(/errcode = 'UR001'/);
    expect(GUARD).toMatch(/errcode = 'UR002'/);
  });
});
