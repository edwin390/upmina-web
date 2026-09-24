import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo enfoque que profiles-migration.test.ts: no hay Postgres real en este entorno de test,
// así que estas pruebas verifican ESTÁTICAMENTE la migración de social_oauth_flows (Bloque
// 8B): esquema, constraints, RLS/FORCE, grants y ausencia de lo que NO debe existir. No
// sustituyen aplicarla en un Postgres real y comprobar RLS/grants con datos.

const MIGRATIONS_DIR = resolve(__dirname, "../../supabase/migrations");
const FILE = "20260925120000_social_oauth_flows.sql";
const sql = readFileSync(resolve(MIGRATIONS_DIR, FILE), "utf8");

/** SQL sin comentarios de línea: las comprobaciones "no debe existir X" no deben dispararse
 *  por texto explicativo en los comentarios. */
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

function tableBody(): string {
  const start = code.indexOf("create table public.social_oauth_flows");
  expect(start).toBeGreaterThanOrEqual(0);
  return code.slice(start, code.indexOf("\n);", start) + 3);
}

describe("migración social_oauth_flows — esquema", () => {
  it("es una migración NUEVA: existe una sola vez y ninguna anterior la reemplaza", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    // Pueden existir migraciones POSTERIORES (p. ej. 9B); ninguna puede ser anterior a esta
    // salvo las históricas ya aplicadas.
    expect(files.filter((f) => f === FILE)).toHaveLength(1);
    expect(files.indexOf(FILE)).toBeGreaterThan(0);
  });

  it("crea la tabla SIN if not exists (debe fallar de forma visible si ya existe)", () => {
    expect(code).toMatch(/create table public\.social_oauth_flows \(/);
    expect(code).not.toMatch(/if not exists/i);
  });

  it("tiene exactamente las 6 columnas previstas con sus tipos y nulabilidad", () => {
    const body = tableBody();
    expect(body).toMatch(/provider\s+text primary key,/);
    expect(body).toMatch(/nonce_hash\s+text\s+not null,/);
    expect(body).toMatch(
      /admin_user_id\s+uuid\s+not null references auth\.users\(id\) on delete cascade,/,
    );
    expect(body).toMatch(/created_at\s+timestamptz not null,/);
    expect(body).toMatch(/expires_at\s+timestamptz not null,/);
    expect(body).toMatch(/consumed_at\s+timestamptz,/);
    const columnLines = body
      .split("\n")
      .filter((l) => /^\s{2}[a-z_]+\s+(text|uuid|timestamptz)\b/.test(l));
    expect(columnLines).toHaveLength(6);
  });

  it("created_at NO tiene default: lo fija el servidor con el mismo instante que expires_at", () => {
    expect(tableBody()).not.toMatch(/created_at[^\n]*default/i);
  });

  it("provider es PRIMARY KEY (una fila por proveedor) y solo admite instagram y tiktok", () => {
    expect(tableBody()).toMatch(/provider\s+text primary key/);
    expect(code).toMatch(
      /constraint social_oauth_flows_provider_check\s+check \(provider in \('instagram', 'tiktok'\)\)/,
    );
  });

  it("admin_user_id referencia auth.users con ON DELETE CASCADE (no SET NULL)", () => {
    expect(tableBody()).toMatch(/references auth\.users\(id\) on delete cascade/);
    expect(tableBody()).not.toMatch(/set null/i);
  });

  it("nonce_hash solo admite SHA-256 en hexadecimal minúsculas", () => {
    expect(code).toMatch(/check \(nonce_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  });

  it("CHECK de tiempos: expires_at > created_at y consumed_at NULL o >= created_at", () => {
    expect(code).toMatch(/check \(expires_at > created_at\)/);
    expect(code).toMatch(/check \(consumed_at is null or consumed_at >= created_at\)/);
  });

  it("no guarda nonce en claro, state, code, tokens ni email", () => {
    const forbidden =
      /^\s*(nonce|state|code|access_token|refresh_token|token|email|role)\b/im;
    expect(tableBody()).not.toMatch(forbidden);
  });

  it("no crea índices adicionales, funciones/RPC, triggers ni policies", () => {
    expect(code).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(code).not.toMatch(/create\s+(or replace\s+)?function/i);
    expect(code).not.toMatch(/create\s+trigger/i);
    expect(code).not.toMatch(/create\s+policy/i);
    expect(code).not.toMatch(/security definer/i);
  });
});

describe("migración social_oauth_flows — seguridad", () => {
  it("RLS activado y FORZADO", () => {
    expect(code).toMatch(
      /alter table public\.social_oauth_flows enable row level security;/,
    );
    expect(code).toMatch(
      /alter table public\.social_oauth_flows force row level security;/,
    );
  });

  it("revoca todo a public, anon, authenticated y service_role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toMatch(
        new RegExp(`revoke all on table public\\.social_oauth_flows from ${role};`),
      );
    }
  });

  it("solo concede SELECT, INSERT y UPDATE, y solo a service_role", () => {
    const grants = code.match(/grant [^;]+;/gi) ?? [];
    expect(grants).toHaveLength(1);
    expect((grants[0] ?? "").replace(/\s+/g, " ")).toBe(
      "grant select, insert, update on table public.social_oauth_flows to service_role;",
    );
  });

  it("NO concede DELETE, TRUNCATE, REFERENCES, TRIGGER ni ALL, y ningún grant a anon/authenticated/public", () => {
    const grants = (code.match(/grant [^;]+;/gi) ?? []).join(" ");
    expect(grants).not.toMatch(/\b(delete|truncate|references|trigger|all)\b/i);
    // Solo se mira el destinatario (tras `to`): "public." es el esquema, no el rol PUBLIC.
    const recipients = grants.replace(/grant [^;]*? to /gi, "");
    expect(recipients).not.toMatch(/\b(anon|authenticated|public)\b/i);
  });

  it("los REVOKE de service_role van ANTES del GRANT (si no, el grant se anularía)", () => {
    expect(code.indexOf("from service_role;")).toBeGreaterThan(-1);
    expect(code.indexOf("from service_role;")).toBeLessThan(code.indexOf("grant select"));
  });

  it("ninguna policy: anon y authenticated no pueden nada", () => {
    expect(code).not.toMatch(/policy/i);
  });

  it("no toca ninguna otra tabla (instagram_oauth_nonces, social_connections, admin_*, profiles)", () => {
    for (const other of [
      "instagram_oauth_nonces",
      "social_connections",
      "admin_roles",
      "admin_invitations",
      "profiles",
    ]) {
      expect(code).not.toContain(other);
    }
  });

  it("la migración de instagram_oauth_nonces sigue existiendo, sin cambios de esta migración", () => {
    expect(
      existsSync(resolve(MIGRATIONS_DIR, "20260921180000_instagram_oauth_nonces.sql")),
    ).toBe(true);
  });
});
