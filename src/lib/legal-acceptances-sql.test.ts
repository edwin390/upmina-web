// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// SQL REAL (PGlite) de 20261118120000_legal_acceptances.sql. Sintético.
const SQL = readFileSync(
  "supabase/migrations/20261118120000_legal_acceptances.sql",
  "utf8",
).replace(/\r\n/g, "\n");
const ROLLBACK = readFileSync(
  "supabase/rollbacks/20261118120000_legal_acceptances.rollback.sql",
  "utf8",
);
const ALL = { terms: "v0.1", privacy: "v0.1", community_rules: "v0.1" };
let db: TestDatabase;
let n = 0;
const uid = () => `0f000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const signup = (meta: unknown) =>
  db.query("insert into auth.users(id, raw_user_meta_data) values($1, $2::jsonb)", [
    uid(),
    JSON.stringify(meta),
  ]);
const count = async () =>
  Number((await db.query("select count(*)::int c from legal_acceptances")).rows[0].c);

beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(
    "alter table auth.users add column if not exists raw_user_meta_data jsonb",
  );
  await db.exec(SQL);
}, 90000);
afterAll(async () => {
  await db?.close();
});

describe("legal_acceptances", () => {
  it("sin versiones aprobadas y sin enforcement: el alta pasa y no registra nada", async () => {
    await signup({ legal_acceptance: ALL });
    await signup({});
    expect(await count()).toBe(0);
  });

  it("con versiones aprobadas registra las tres, con fecha de servidor y sin IP", async () => {
    for (const d of ["terms", "privacy", "community_rules"])
      await db.query(
        "insert into legal_document_versions(document,version,is_current,approved_at) values($1,'v0.1',true,now())",
        [d],
      );
    await signup({ legal_acceptance: ALL });
    expect(await count()).toBe(3);
    const cols = (
      await db.query(
        "select column_name from information_schema.columns where table_name='legal_acceptances'",
      )
    ).rows.map((r) => String(r.column_name));
    expect(cols.sort()).toEqual([
      "accepted_at",
      "document",
      "source",
      "user_id",
      "version",
    ]);
  });

  it("sin enforcement, versiones inválidas o parciales no bloquean ni registran de más", async () => {
    const before = await count();
    await signup({ legal_acceptance: { terms: "v9.9", privacy: "v0.1" } });
    await signup({ legal_acceptance: "texto" });
    expect(await count()).toBe(before + 1);
  });

  it("con enforcement rechaza altas sin las tres aceptaciones vigentes y acepta las completas", async () => {
    await db.exec("update legal_settings set enforce_signup = true");
    await expect(signup({})).rejects.toThrow(/legal_acceptance_required/);
    await expect(
      signup({ legal_acceptance: { terms: "v0.1", privacy: "v0.1" } }),
    ).rejects.toThrow(/legal_acceptance_required/);
    await expect(
      signup({ legal_acceptance: { ...ALL, privacy: "v0.2" } }),
    ).rejects.toThrow(/legal_acceptance_required/);
    await signup({ legal_acceptance: ALL });
    await db.exec("update legal_settings set enforce_signup = false");
  });

  it("las tablas no son accesibles para anon/authenticated y el rollback las retira", async () => {
    const g = await db.query(
      "select count(*)::int c from information_schema.role_table_grants where table_name in ('legal_acceptances','legal_settings','legal_document_versions') and grantee in ('anon','authenticated','public')",
    );
    expect(Number(g.rows[0].c)).toBe(0);
    await db.exec(ROLLBACK);
    const t = await db.query(
      "select count(*)::int c from pg_tables where tablename like 'legal_%'",
    );
    expect(Number(t.rows[0].c)).toBe(0);
    await signup({});
  });
});
