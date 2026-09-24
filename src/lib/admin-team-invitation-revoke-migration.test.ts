import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Verificación ESTÁTICA de la migración del Bloque 9D (revoke_admin_invitation). No sustituye las
// pruebas contra PostgreSQL real (consume vs revoke, doble revoke, SET ROLE), que se hacen con el
// harness contra una base desechable; solo fija por texto las decisiones aprobadas.

const MIGRATIONS_DIR = resolve(__dirname, "../../supabase/migrations");
const FILE = "20260927120000_admin_team_invitation_revoke.sql";
const raw = readFileSync(resolve(MIGRATIONS_DIR, FILE), "utf8");
const code = raw
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");
const handlerSrc = readFileSync(resolve(__dirname, "admin-team-invitations.ts"), "utf8");

const bodyStart = code.indexOf("$$");
const body = code.slice(bodyStart, code.indexOf("$$;", bodyStart + 2) + 3);
const header = code.slice(0, bodyStart);

describe("migración 9D — archivo", () => {
  it("es nueva, única, posterior a 9B y no toca migraciones históricas", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.filter((f) => f === FILE)).toHaveLength(1);
    expect(files[files.indexOf(FILE) - 1]).toBe(
      "20260926120000_admin_team_roles_invariants.sql",
    );
  });

  it("solo crea la función de revocación: sin DDL de tablas, sin DML masivo, sin secretos", () => {
    expect(code).not.toMatch(/\b(alter|drop|truncate)\b/i);
    expect(code).not.toMatch(/create table|create trigger|create type/i);
    expect(code).not.toMatch(/insert into|delete from/i);
    expect(code).not.toMatch(/service_role_key|eyJ|(?<![\w])sk_/i);
    expect(code.match(/create or replace function/gi)).toHaveLength(1);
  });
});

describe("migración 9D — revoke_admin_invitation", () => {
  it("SECURITY DEFINER con search_path fijado y firma (uuid, uuid)", () => {
    expect(header).toMatch(
      /create or replace function public\.revoke_admin_invitation\(\s*p_invitation_id uuid,\s*p_actor_user_id uuid\s*\)/,
    );
    expect(header).toMatch(/security definer/);
    expect(header).toMatch(/set search_path = pg_catalog, public/);
  });

  it("toma el lock compartido PRIMERO, antes de cualquier consulta o FOR UPDATE", () => {
    const lock = body.indexOf("public.upmina_lock_admin_roles()");
    expect(lock).toBeGreaterThan(-1);
    for (const later of [
      "from public.admin_roles",
      "for update",
      "update public.admin_invitations",
    ]) {
      const at = body.indexOf(later);
      expect(at, later).toBeGreaterThan(-1);
      expect(lock, later).toBeLessThan(at);
    }
  });

  it("valida al actor (sigue siendo ADMIN) bajo el lock y ANTES de leer la invitación", () => {
    const actor = body.indexOf("actor_not_admin");
    const select = body.indexOf("for update");
    expect(actor).toBeGreaterThan(-1);
    expect(actor).toBeLessThan(select);
    expect(body).toMatch(/ar\.user_id = p_actor_user_id and ar\.role = 'admin'/);
    expect(body).toMatch(/p_actor_user_id is null/);
  });

  it("bloquea la fila por id y valida tipo, consumo, revocación y expiración en ese orden", () => {
    expect(body).toMatch(/where i\.id = p_invitation_id\s+for update/);
    const order = [
      "invitation_not_found",
      "invitation_not_revocable",
      "invitation_already_consumed",
      "invitation_already_revoked",
      "invitation_expired",
    ].map((m) => body.indexOf(`raise exception '${m}'`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toMatch(/v_row\.invitation_type <> 'standard'/);
    expect(body).toMatch(/v_row\.expires_at < v_now/);
  });

  it("el único UPDATE fija revoked_at y revoked_by (transición de 9B); nada de DELETE ni otras columnas", () => {
    const updates = body.match(/update public\.admin_invitations[\s\S]*?;/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(
      /set revoked_at = v_now, revoked_by = p_actor_user_id\s+where id = p_invitation_id;/,
    );
    expect(body).not.toMatch(/\bdelete\b/i);
    expect(updates[0]).not.toMatch(
      /consumed_|expires_at|role|token_hash|invitation_type/,
    );
  });

  it("no captura excepciones (last_admin_protected / 23001 y errores de trigger se propagan)", () => {
    expect(body).not.toMatch(/\bexception\s+when\b/i);
    expect(body).not.toMatch(/\bwhen others\b/i);
  });

  it("los literales de error son EXACTAMENTE los que reconoce el handler (lista cerrada)", () => {
    const raised = [
      ...new Set([...body.matchAll(/raise exception '(\w+)'/g)].map((m) => m[1])),
    ].sort();
    expect(raised).toEqual(
      [
        "actor_not_admin",
        "invitation_already_consumed",
        "invitation_already_revoked",
        "invitation_expired",
        "invitation_not_found",
        "invitation_not_revocable",
      ].sort(),
    );
    for (const literal of raised) expect(handlerSrc).toContain(`"${literal}"`);
  });
});

describe("migración 9D — privilegios", () => {
  it("EXECUTE solo para service_role; revocado a PUBLIC, anon y authenticated", () => {
    const sig = "public.revoke_admin_invitation(uuid, uuid)";
    expect(code).toContain(`revoke all on function ${sig} from public;`);
    expect(code).toContain(`revoke execute on function ${sig} from anon;`);
    expect(code).toContain(`revoke execute on function ${sig} from authenticated;`);
    expect(code).toContain(`grant execute on function ${sig} to service_role;`);
    expect(code.match(/\bgrant\b/gi)).toHaveLength(1);
  });

  it("NO restaura UPDATE/DELETE/INSERT ni ningún privilegio de tabla a service_role", () => {
    expect(code).not.toMatch(
      /grant\s+[^;]*\bon\s+(table\s+)?public\.admin_(roles|invitations)/i,
    );
    expect(code).not.toMatch(/\bgrant\s+(all|update|delete|truncate)\b/i);
  });
});
