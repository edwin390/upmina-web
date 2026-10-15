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
const ALL = {
  adult_declaration: "v1.0",
  terms: "v1.0",
  privacy: "v1.0",
  community_rules: "v1.0",
};
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
  it("la migración siembra la v1.0 vigente de los 4 documentos y deja el bloqueo apagado", async () => {
    const v = await db.query(
      "select document, version from legal_document_versions where is_current order by document",
    );
    expect(v.rows.map((r) => `${r.document}:${r.version}`)).toEqual([
      "adult_declaration:v1.0",
      "community_rules:v1.0",
      "privacy:v1.0",
      "terms:v1.0",
    ]);
    expect(
      (await db.query("select enforce_signup from legal_settings")).rows[0]
        .enforce_signup,
    ).toBe(false);
  });

  it("sin bloqueo: un alta completa registra los 4 (fecha de servidor, sin IP); uno vacío pasa y no registra", async () => {
    await signup({ legal_acceptance: ALL });
    expect(await count()).toBe(4);
    await signup({});
    expect(await count()).toBe(4);
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

  it("sin bloqueo, versiones inválidas o parciales no bloquean y solo registran las válidas", async () => {
    const before = await count();
    await signup({ legal_acceptance: { terms: "v9.9", privacy: "v1.0" } });
    await signup({ legal_acceptance: "texto" });
    expect(await count()).toBe(before + 1);
  });

  it("con bloqueo: rechaza altas sin los 4 reconocimientos vigentes (incluida la mayoría de edad) y acepta las completas", async () => {
    await db.exec("update legal_settings set enforce_signup = true");
    await expect(signup({})).rejects.toThrow(/legal_acceptance_required/);
    const { adult_declaration: _a, ...sinEdad } = ALL;
    void _a;
    await expect(signup({ legal_acceptance: sinEdad })).rejects.toThrow(
      /legal_acceptance_required/,
    );
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
    expect(
      Number(
        (
          await db.query(
            "select count(*)::int c from pg_tables where tablename like 'legal_%'",
          )
        ).rows[0].c,
      ),
    ).toBe(0);
    await signup({});
  });
});
