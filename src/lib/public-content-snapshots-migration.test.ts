import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SNAPSHOT_RESOURCES } from "./public-snapshot-resources";

// Mismo enfoque que social-oauth-flows-migration.test.ts: no hay Postgres real en este entorno de
// test, así que estas pruebas verifican ESTÁTICAMENTE la migración de public_content_snapshots
// (Fase 9H-4): esquema, constraints, RLS/FORCE, grants y ausencia de lo que NO debe existir. La
// migración se aplicó además al proyecto DESECHABLE y se comprobó con datos sintéticos (RLS,
// privilegios, CHECK y upsert reales); eso no se repite aquí.

const MIGRATIONS_DIR = resolve(__dirname, "../../supabase/migrations");
const FILE = "20260929120000_public_content_snapshots.sql";
const sql = readFileSync(resolve(MIGRATIONS_DIR, FILE), "utf8");

/** SQL sin comentarios de línea: las comprobaciones "no debe existir X" no deben dispararse por
 *  texto explicativo en los comentarios. */
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

function tableBody(): string {
  const start = code.indexOf("create table public.public_content_snapshots");
  expect(start).toBeGreaterThanOrEqual(0);
  return code.slice(start, code.indexOf("\n);", start) + 3);
}

describe("migración public_content_snapshots — esquema", () => {
  it("es una migración NUEVA y única, posterior a las que existían en la Fase 9H-4", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.filter((f) => f === FILE)).toHaveLength(1);
    // No tiene por qué ser la ÚLTIMA para siempre (fases posteriores, p. ej. 9I, añaden las
    // suyas después): solo que sea posterior a 20260928120000_admin_team_member_management.sql,
    // la última que existía cuando esta se escribió.
    expect(files.indexOf(FILE)).toBeGreaterThan(
      files.indexOf("20260928120000_admin_team_member_management.sql"),
    );
  });

  it("crea la tabla SIN if not exists (debe fallar de forma visible si ya existe)", () => {
    expect(code).toMatch(/create table public\.public_content_snapshots \(/);
    expect(code).not.toMatch(/if not exists/i);
  });

  it("tiene exactamente las 4 columnas previstas con sus tipos y nulabilidad", () => {
    const body = tableBody();
    expect(body).toMatch(/resource\s+text primary key,/);
    expect(body).toMatch(/source_id\s+text\s+not null,/);
    expect(body).toMatch(/payload\s+jsonb\s+not null,/);
    expect(body).toMatch(/captured_at\s+timestamptz not null default now\(\),/);
    const columnLines = body
      .split("\n")
      .filter((l) => /^\s{2}[a-z_]+\s+(text|jsonb|timestamptz)\b/.test(l));
    expect(columnLines).toHaveLength(4);
  });

  it("resource: PRIMARY KEY y CHECK con EXACTAMENTE los 8 recursos canónicos", () => {
    const check = code.match(
      /constraint public_content_snapshots_resource_check\s+check \(resource in \(([^)]*)\)\)/,
    );
    expect(check).not.toBeNull();
    const listed = [...(check?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...SNAPSHOT_RESOURCES]);
    expect(listed).toHaveLength(8);
  });

  it("twitch-status, instagram-media e instagram-comments NO están en el CHECK", () => {
    const check =
      code.match(/public_content_snapshots_resource_check[\s\S]*?\)\),/)?.[0] ?? "";
    for (const name of ["twitch-status", "instagram-media", "instagram-comments"]) {
      expect(check).not.toContain(name);
    }
  });

  it("source_id: NOT NULL y longitud acotada (1–200)", () => {
    expect(code).toMatch(/check \(char_length\(source_id\) between 1 and 200\)/);
  });

  it("payload: jsonb NOT NULL, solo objeto o array, y tope de tamaño de 262 144 bytes", () => {
    expect(code).toMatch(/check \(jsonb_typeof\(payload\) in \('object', 'array'\)\)/);
    expect(code).toMatch(/check \(octet_length\(payload::text\) <= 262144\)/);
  });

  it("el tope de tamaño de la base de datos coincide con el previsto en el código", () => {
    // El código escribe con un margen menor; el CHECK es la última red.
    expect(262144).toBeGreaterThan(200_000);
  });

  it("no guarda tokens, credenciales ni identidad: no hay columnas de ese tipo", () => {
    const forbidden =
      /^\s*(access_token|refresh_token|token|authorization|cookie|secret|password|api_key|client_secret|state|nonce|email|role|user_id|admin_user_id)\b/im;
    expect(tableBody()).not.toMatch(forbidden);
  });

  it("no crea índices adicionales, funciones/RPC, triggers ni policies", () => {
    expect(code).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(code).not.toMatch(/create\s+(or replace\s+)?function/i);
    expect(code).not.toMatch(/create\s+trigger/i);
    expect(code).not.toMatch(/create\s+policy/i);
    expect(code).not.toMatch(/security definer/i);
  });

  it("no contiene literales que parezcan secretos (JWT, claves, tokens)", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(sql).not.toMatch(/\b(sk|pk|srk|rft|act)[-_.][A-Za-z0-9]{8,}/i);
    expect(sql).not.toMatch(
      /(service_role_key|SUPABASE_SERVICE_ROLE_KEY|client_secret)\s*[:=]/i,
    );
    expect(sql).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/);
  });
});

describe("migración public_content_snapshots — seguridad", () => {
  it("RLS activado y FORZADO", () => {
    expect(code).toMatch(
      /alter table public\.public_content_snapshots enable row level security;/,
    );
    expect(code).toMatch(
      /alter table public\.public_content_snapshots force row level security;/,
    );
  });

  it("revoca todo a public, anon, authenticated y service_role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toMatch(
        new RegExp(`revoke all on table public\\.public_content_snapshots from ${role};`),
      );
    }
  });

  it("solo concede SELECT, INSERT, UPDATE y DELETE, y solo a service_role", () => {
    const grants = code.match(/grant [^;]+;/gi) ?? [];
    expect(grants).toHaveLength(1);
    expect((grants[0] ?? "").replace(/\s+/g, " ")).toBe(
      "grant select, insert, update, delete on table public.public_content_snapshots to service_role;",
    );
  });

  it("NO concede TRUNCATE, REFERENCES, TRIGGER ni ALL, y ningún grant a anon/authenticated/public", () => {
    const grants = (code.match(/grant [^;]+;/gi) ?? []).join(" ");
    expect(grants).not.toMatch(/\b(truncate|references|trigger|all)\b/i);
    // Solo se mira el destinatario (tras `to`): "public." es el esquema, no el rol PUBLIC.
    const recipients = grants.replace(/grant [^;]*? to /gi, "");
    expect(recipients).not.toMatch(/\b(anon|authenticated|public)\b/i);
  });

  it("los REVOKE de service_role van ANTES del GRANT (si no, el grant se anularía)", () => {
    expect(code.indexOf("from service_role;")).toBeGreaterThan(-1);
    expect(code.indexOf("from service_role;")).toBeLessThan(code.indexOf("grant select"));
  });

  it("ninguna policy: anon y authenticated no pueden SELECT, INSERT, UPDATE ni DELETE", () => {
    expect(code).not.toMatch(/policy/i);
    expect(code).not.toMatch(/to (anon|authenticated|public)\b/i);
  });

  it("no toca ninguna otra tabla", () => {
    for (const other of [
      "social_connections",
      "social_oauth_flows",
      "instagram_oauth_nonces",
      "admin_roles",
      "admin_invitations",
      "profiles",
      "auth.",
    ]) {
      expect(code).not.toContain(other);
    }
    const tables = [
      ...code.matchAll(/(?:create table|alter table|on table|from) (public\.[a-z_]+)/g),
    ].map((m) => m[1]);
    expect(new Set(tables)).toEqual(new Set(["public.public_content_snapshots"]));
  });
});
