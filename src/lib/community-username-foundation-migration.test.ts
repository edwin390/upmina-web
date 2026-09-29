import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo enfoque que profiles-migration.test.ts: sin Postgres real en este entorno de test,
// se verifica ESTÁTICAMENTE el contenido de la migración 9J-1B. No sustituye aplicarla en
// Supabase y comprobar RLS/grants/constraints con datos reales (ya hecho por separado contra
// Upmina Testing).

const MIGRATION_PATH = resolve(
  __dirname,
  "../../supabase/migrations/20261003120000_community_username_foundation.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("migración 20261003120000_community_username_foundation.sql — alcance", () => {
  it("solo toca public.profiles (ninguna otra tabla)", () => {
    const targets = [...code.matchAll(/alter table\s+(\S+)/gi)].map((m) => m[1]);
    expect(targets.every((t) => t === "public.profiles")).toBe(true);
    expect(targets.length).toBeGreaterThan(0);
  });

  it("no crea ni elimina ninguna tabla, función, trigger, policy ni índice", () => {
    expect(code).not.toMatch(/create table/i);
    expect(code).not.toMatch(/drop table/i);
    expect(code).not.toMatch(/create (or replace )?function/i);
    expect(code).not.toMatch(/create trigger/i);
    expect(code).not.toMatch(/drop trigger/i);
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/drop policy/i);
    expect(code).not.toMatch(/create (unique )?index/i);
  });

  it("no toca RLS, grants ni la policy pública existentes", () => {
    expect(code).not.toMatch(/row level security/i);
    expect(code).not.toMatch(/\bgrant\b/i);
    expect(code).not.toMatch(/\brevoke\b/i);
    expect(code).not.toMatch(/profiles_select_public/);
  });

  it("no toca user_id, el trigger profiles_before_update ni updated_at", () => {
    expect(code).not.toMatch(/profiles_before_update/);
    expect(code).not.toMatch(/\buser_id\b/);
    expect(code).not.toMatch(/\bupdated_at\b/);
  });

  it("no modifica ninguna otra migración/tabla previa (cosplay_*, admin_*, media_assets, etc.)", () => {
    expect(code).not.toMatch(
      /alter table public\.(cosplay_\w+|admin_\w+|media_assets|media_asset_variants|social_\w+)/i,
    );
  });

  it("no contiene secretos ni JWT", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(sql).not.toMatch(/service_role_key|sk_live|BEGIN (RSA|PRIVATE)/i);
  });
});

describe("username CHECK: sustituye profiles_username_format por el formato congelado", () => {
  it("elimina el CHECK antiguo y añade uno nuevo con el mismo nombre (widen, no un nombre paralelo)", () => {
    expect(code).toMatch(/drop constraint profiles_username_format/);
    expect(code).toMatch(/add constraint profiles_username_format check/);
  });

  it("no toca profiles_username_key (unicidad global preservada)", () => {
    expect(code).not.toMatch(/profiles_username_key/);
  });

  it("el nuevo CHECK exige 3-24 caracteres de a-z/0-9/_/. y prohíbe punto inicial/final/consecutivo", () => {
    expect(code).toMatch(/username ~ '\^\[a-z0-9_\.\]\{3,24\}\$'/);
    expect(code).toMatch(/left\(username, 1\) <> '\.'/);
    expect(code).toMatch(/right\(username, 1\) <> '\.'/);
    expect(code).toMatch(/username !~ '\\\.\\\.'/);
  });

  it("el patrón base (extraído del SQL) por sí solo acepta el punto en posición interior", () => {
    const match = /username ~ '(\^\[a-z0-9_.\]\{3,24\}\$)'/.exec(code);
    expect(match).not.toBeNull();
    const pattern = new RegExp(match![1]);
    expect(pattern.test("ed.win")).toBe(true);
    expect(pattern.test(".edwin")).toBe(true); // el patrón base SÍ lo acepta: lo rechazan las
    expect(pattern.test("edwin.")).toBe(true); // condiciones left()/right()/!~ '..' aparte,
    expect(pattern.test("ed..win")).toBe(true); // por eso son CUATRO condiciones, no una.
  });

  it("simula la conjunción completa del CHECK (igual que evaluaría Postgres)", () => {
    function checkConstraint(username: string): boolean {
      const base = /^[a-z0-9_.]{3,24}$/.test(username);
      const noLeadingDot = username[0] !== ".";
      const noTrailingDot = username[username.length - 1] !== ".";
      const noConsecutiveDots = !username.includes("..");
      return base && noLeadingDot && noTrailingDot && noConsecutiveDots;
    }
    for (const ok of ["abc", "ed.win", "a.b.c", "x".repeat(24), "edwin_390"]) {
      expect(checkConstraint(ok), ok).toBe(true);
    }
    for (const bad of [
      "ab",
      "x".repeat(25),
      ".edwin",
      "edwin.",
      "ed..win",
      "Edwin",
      "ed win",
      "ed-win",
    ]) {
      expect(checkConstraint(bad), bad).toBe(false);
    }
  });
});

describe("username_changed_at: nueva columna nullable", () => {
  it("añade username_changed_at timestamptz, sin NOT NULL ni DEFAULT", () => {
    expect(code).toMatch(/add column username_changed_at timestamptz;/);
    expect(code).not.toMatch(/username_changed_at timestamptz not null/i);
    expect(code).not.toMatch(/username_changed_at timestamptz.*default/i);
  });

  it("documenta la columna con COMMENT ON", () => {
    expect(sql).toMatch(/comment on column public\.profiles\.username_changed_at is/);
  });

  it("documenta el username con el formato actualizado", () => {
    expect(sql).toMatch(/comment on column public\.profiles\.username is/);
  });
});
