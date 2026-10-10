// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// Rollback LOCAL (PGlite) de 20261101120000_username_impersonation_guard.sql. Nunca se ejecuta contra
// Supabase: el archivo vive en supabase/rollbacks/ (fuera de supabase/migrations).

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const GUARD = read("supabase/migrations/20261101120000_username_impersonation_guard.sql");
const ROLLBACK = read(
  "supabase/rollbacks/20261101120000_username_impersonation_guard.rollback.sql",
);
const USERNAME_MIGRATION = read(
  "supabase/migrations/20261003120000_community_username_foundation.sql",
);
const REAL_USERNAME_CHECK = USERNAME_MIGRATION.match(
  /add constraint profiles_username_format check \(([\s\S]*?)\n {2}\);/,
)![1];
const U1 = "0e000000-0000-4000-8000-000000000001";
const U2 = "0e000000-0000-4000-8000-000000000002";
let db: TestDatabase;

const catalog = async () => {
  const fns = await db.query<{ n: string }>(
    `select p.oid::regprocedure::text n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' order by 1`,
  );
  const trg = await db.query<{ n: string }>(
    `select tgrelid::regclass::text || '.' || tgname n from pg_trigger where not tgisinternal order by 1`,
  );
  const tbl = await db.query<{ n: string }>(
    "select tablename n from pg_tables where schemaname = 'public' order by 1",
  );
  return {
    fns: fns.rows.map((r) => r.n),
    trg: trg.rows.map((r) => r.n),
    tbl: tbl.rows.map((r) => r.n),
  };
};

describe("rollback de la protección de identidad (solo local)", () => {
  let before: Awaited<ReturnType<typeof catalog>>;
  let withGuard: Awaited<ReturnType<typeof catalog>>;

  beforeAll(async () => {
    db = await createAtomicTestDatabase();
    await db.exec(`create table admin_roles(user_id uuid primary key, role text);
      alter table profiles add column if not exists username text;
      alter table profiles add column if not exists display_name text;
      alter table profiles add constraint profiles_username_format check (${REAL_USERNAME_CHECK});`);
    before = await catalog();
    await db.exec(GUARD);
    withGuard = await catalog();
    await db.query(
      "insert into auth.users(id,email_confirmed_at) values($1,now()),($2,now())",
      [U1, U2],
    );
    await db.query(
      "insert into profiles(user_id,username,display_name) values($1,'edwin390','Edwin')",
      [U1],
    );
  }, 90000);
  afterAll(async () => {
    await db?.close();
  });

  it("antes del rollback la protección está activa", async () => {
    await expect(
      db.query("insert into profiles(user_id,username) values($1,'mina')", [U2]),
    ).rejects.toMatchObject({ code: "UR001" });
  });

  it("desactiva la protección sin tocar perfiles ni usuarios, y es idempotente", async () => {
    const profilesBefore = (await db.query("select * from profiles order by user_id"))
      .rows;
    const usersBefore = (await db.query("select id from auth.users order by id")).rows;
    await db.exec(ROLLBACK);
    await db.exec(ROLLBACK); // idempotente
    expect((await db.query("select * from profiles order by user_id")).rows).toEqual(
      profilesBefore,
    );
    expect((await db.query("select id from auth.users order by id")).rows).toEqual(
      usersBefore,
    );
    // Ya no protege: nombres antes reservados se aceptan (comportamiento previo al guard).
    await db.query(
      "insert into profiles(user_id,username,display_name) values($1,'mina','Cuenta oficial de Mina')",
      [U2],
    );
    await db.query("update profiles set username = 'upmina' where user_id = $1", [U2]);
  });

  it("elimina solo objetos del guard: el resto del catálogo queda idéntico al previo", async () => {
    const after = await catalog();
    const guardOnly = (xs: string[], base: string[]) =>
      xs.filter((x) => !base.includes(x));
    // Funciones y triggers: vuelven EXACTAMENTE al estado previo al guard.
    expect(
      after.fns.filter((f) => !f.startsWith("username_reservation_audit_append_only")),
    ).toEqual(before.fns);
    expect(
      after.trg.filter((t) => !t.includes("username_reservation_audit_no_")),
    ).toEqual(before.trg);
    // Se conservan solo las tablas de auditoría (y su trigger append-only).
    expect(guardOnly(after.tbl, before.tbl)).toEqual([
      "username_reservation_audit",
      "username_reservation_grants",
    ]);
    expect(guardOnly(withGuard.fns, before.fns).length).toBeGreaterThan(8);
  });

  it("la auditoría sigue siendo append-only tras el rollback", async () => {
    await expect(db.exec("truncate public.username_reservation_audit")).rejects.toThrow(
      /audit_append_only/,
    );
  });

  it("el script no escribe datos ni toca R7/media/cron/auth/roles", () => {
    const active = ROLLBACK.split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(active).not.toMatch(/\b(insert|update|delete|truncate|grant|alter)\b/i);
    expect(active).not.toMatch(
      /media|abandon|r7|cron|auth\.|admin_roles|moderation|strike/i,
    );
    expect(active.match(/drop (trigger|function)/gi)!.length).toBe(12);
    expect(active).not.toMatch(/drop table/i);
  });

  it("no está en supabase/migrations (db push no puede aplicarlo)", async () => {
    const { readdirSync } = await import("node:fs");
    expect(readdirSync("supabase/migrations").some((f) => f.includes("rollback"))).toBe(
      false,
    );
  });
});
