import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// No hay Postgres real disponible en este entorno de test (ni pg-mem/pglite en
// package.json), así que estas pruebas verifican ESTÁTICAMENTE el contenido de la
// migración: schema, constraints, grants/revokes, SECURITY DEFINER, search_path y
// ausencia de secretos. No sustituyen una verificación estructural contra Supabase real
// (ver informe de Bloque 1) ni una prueba de concurrencia ejecutada de verdad contra
// Postgres — la "prueba" de concurrencia aquí es conceptual: confirma por texto que el
// orden de las operaciones en la función coincide con el diseño aprobado (advisory lock
// solo para bootstrap_admin, comprobación de admin existente DESPUÉS del lock, etc.),
// que es precisamente lo que garantiza la ausencia de la race condition.

const MIGRATION_PATH = resolve(
  __dirname,
  "../../supabase/migrations/20260923120000_admin_invitations.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

/** Índice de la primera ocurrencia de `needle`, o -1. Falla el test con un mensaje claro
 *  si se usa mal (needle vacío), en vez de un `indexOf` silencioso. */
function indexOfOrThrow(needle: string): number {
  if (!needle) throw new Error("needle vacío");
  return sql.indexOf(needle);
}

describe("migración 20260923120000_admin_invitations.sql — schema", () => {
  it("crea admin_invitations con las 8 columnas esperadas", () => {
    expect(sql).toMatch(/create table if not exists public\.admin_invitations/);
    expect(sql).toMatch(/token_hash\s+text primary key/);
    expect(sql).toMatch(
      /role\s+text not null check \(role in \('admin', 'moderator'\)\)/,
    );
    expect(sql).toMatch(
      /invitation_type\s+text not null check \(invitation_type in \('bootstrap_admin', 'standard'\)\)/,
    );
    expect(sql).toMatch(
      /created_by\s+uuid references auth\.users\(id\) on delete set null/,
    );
    expect(sql).toMatch(/expires_at\s+timestamptz not null/);
    expect(sql).toMatch(/created_at\s+timestamptz not null default now\(\)/);
    expect(sql).toMatch(/consumed_at\s+timestamptz/);
    expect(sql).toMatch(
      /consumed_by\s+uuid references auth\.users\(id\) on delete set null/,
    );
  });

  it("no modifica admin_roles en absoluto (ni columnas ni índices)", () => {
    expect(sql).not.toMatch(/alter table public\.admin_roles/i);
    expect(sql).not.toMatch(/create table.*admin_roles/);
    expect(sql).not.toMatch(/create\s+(unique\s+)?index[^;]*on public\.admin_roles/is);
  });
});

describe("migración — constraint de forma bootstrap_admin / standard", () => {
  it("declara admin_invitations_bootstrap_shape combinando ambos casos", () => {
    expect(sql).toMatch(/constraint admin_invitations_bootstrap_shape check/);
  });

  it("prohíbe bootstrap_admin + moderator (la constraint exige role = 'admin' para bootstrap_admin)", () => {
    const constraintStart = indexOfOrThrow("admin_invitations_bootstrap_shape");
    const constraintBody = sql.slice(constraintStart, constraintStart + 400);
    expect(constraintBody).toMatch(
      /invitation_type = 'bootstrap_admin' and role = 'admin' and created_by is null/,
    );
  });

  it("prohíbe bootstrap_admin + created_by distinto de NULL (misma cláusula que exige created_by is null)", () => {
    const constraintStart = indexOfOrThrow("admin_invitations_bootstrap_shape");
    const constraintBody = sql.slice(constraintStart, constraintStart + 400);
    expect(constraintBody).toMatch(/created_by is null/);
  });

  it("prohíbe standard + created_by NULL (la constraint exige created_by is not null)", () => {
    const constraintStart = indexOfOrThrow("admin_invitations_bootstrap_shape");
    const constraintBody = sql.slice(constraintStart, constraintStart + 400);
    expect(constraintBody).toMatch(
      /invitation_type = 'standard' and created_by is not null/,
    );
  });

  it("permite standard con role='admin' o role='moderator' (la rama standard de la constraint no restringe role)", () => {
    const constraintStart = indexOfOrThrow("admin_invitations_bootstrap_shape");
    const constraintBody = sql.slice(constraintStart, constraintStart + 400);
    const standardBranch = constraintBody.slice(
      constraintBody.indexOf("invitation_type = 'standard'"),
    );
    // La rama standard solo exige created_by is not null; a diferencia de la rama
    // bootstrap_admin, no contiene ninguna comparación "role =" que fije un único valor.
    expect(standardBranch).not.toMatch(/role\s*=\s*'admin'/);
    expect(standardBranch).not.toMatch(/role\s*=\s*'moderator'/);
    // El único lugar que restringe los valores posibles de role es el CHECK de columna
    // (admin/moderator), que sí sigue permitiendo ambos para cualquier invitation_type.
    expect(sql).toMatch(
      /role\s+text not null check \(role in \('admin', 'moderator'\)\)/,
    );
  });
});

describe("migración — NO existe ninguna restricción global de un solo admin", () => {
  // La única invariante que este diseño protege es "bootstrap_admin solo prospera
  // mientras existen 0 admins" (garantizada por el advisory lock dentro de la
  // transacción, ver más abajo). NO debe existir ningún índice/constraint que limite
  // admin_roles a una sola fila con role='admin' de forma permanente: eso bloquearía
  // que un ADMIN futuro invite a otro ADMIN vía invitation_type='standard'.
  it("no crea admin_roles_single_admin_guard ni ningún otro índice sobre ese nombre", () => {
    expect(sql).not.toMatch(/admin_roles_single_admin_guard/);
  });

  it("no declara ningún índice/constraint UNIQUE que limite globalmente role='admin' en admin_roles", () => {
    expect(sql).not.toMatch(/unique[^;]*admin_roles[^;]*role\s*=\s*'admin'/is);
    expect(sql).not.toMatch(/admin_roles[^;]*unique[^;]*role\s*=\s*'admin'/is);
  });

  it("no modifica admin_roles con ningún ALTER/CREATE INDEX en esta migración", () => {
    expect(sql).not.toMatch(/create\s+(unique\s+)?index[^;]*on public\.admin_roles/is);
    expect(sql).not.toMatch(/alter table public\.admin_roles/i);
  });
});

describe("migración — RLS y privilegios de tabla", () => {
  it("activa y FUERZA RLS sobre admin_invitations", () => {
    expect(sql).toMatch(
      /alter table public\.admin_invitations enable row level security/,
    );
    expect(sql).toMatch(/alter table public\.admin_invitations force row level security/);
  });

  it("no define ninguna policy (cero policies, igual que admin_roles)", () => {
    expect(sql).not.toMatch(/create policy/i);
  });

  it("revoca todos los privilegios de public/anon/authenticated sobre admin_invitations", () => {
    expect(sql).toMatch(/revoke all on table public\.admin_invitations from public/);
    expect(sql).toMatch(/revoke all on table public\.admin_invitations from anon/);
    expect(sql).toMatch(
      /revoke all on table public\.admin_invitations from authenticated/,
    );
  });

  it("concede a service_role únicamente select/insert/update, nunca delete", () => {
    expect(sql).toMatch(
      /grant select, insert, update on table public\.admin_invitations to service_role/,
    );
    expect(sql).not.toMatch(/grant[^;]*delete[^;]*on table public\.admin_invitations/is);
  });
});

describe("migración — RPC consume_admin_invitation: firma y flags", () => {
  it("es SECURITY DEFINER con search_path fijado a pg_catalog, public", () => {
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/set search_path = pg_catalog, public/);
  });

  it("recibe exactamente (p_token_hash text, p_user_id uuid)", () => {
    expect(sql).toMatch(
      /create or replace function public\.consume_admin_invitation\(\s*p_token_hash text,\s*p_user_id uuid\s*\)/,
    );
  });

  it("nunca referencia un p_role/p_created_by como parámetro (el role sale de la invitación, no del llamador)", () => {
    expect(sql).not.toMatch(/p_role/);
    expect(sql).not.toMatch(/p_created_by/);
  });
});

describe("migración — orden de operaciones de la RPC (garantía de concurrencia)", () => {
  it("bloquea la invitación con FOR UPDATE antes de cualquier otra validación", () => {
    const selectIdx = indexOfOrThrow("select * into v_row");
    const forUpdateIdx = indexOfOrThrow("for update;");
    const notFoundIdx = indexOfOrThrow("invitation_not_found");
    expect(selectIdx).toBeLessThan(forUpdateIdx);
    expect(forUpdateIdx).toBeLessThan(notFoundIdx);
  });

  it("valida consumed_at y expires_at ANTES de considerar el advisory lock", () => {
    const consumedCheckIdx = indexOfOrThrow("invitation_already_consumed");
    const expiredCheckIdx = indexOfOrThrow("invitation_expired");
    const lockIdx = indexOfOrThrow("pg_advisory_xact_lock(hashtext('admin_bootstrap'))");
    expect(consumedCheckIdx).toBeLessThan(lockIdx);
    expect(expiredCheckIdx).toBeLessThan(lockIdx);
  });

  it("el advisory lock solo se adquiere dentro del branch invitation_type = 'bootstrap_admin'", () => {
    const branchIdx = indexOfOrThrow("if v_row.invitation_type = 'bootstrap_admin' then");
    const lockIdx = indexOfOrThrow("pg_advisory_xact_lock(hashtext('admin_bootstrap'))");
    const endIfIdx = sql.indexOf("end if;", lockIdx);
    expect(branchIdx).toBeLessThan(lockIdx);
    expect(lockIdx).toBeLessThan(endIfIdx);
  });

  it("comprueba admin_already_exists DESPUÉS de adquirir el advisory lock, no antes", () => {
    const lockIdx = indexOfOrThrow("pg_advisory_xact_lock(hashtext('admin_bootstrap'))");
    const adminExistsIdx = indexOfOrThrow("admin_already_exists");
    expect(lockIdx).toBeLessThan(adminExistsIdx);
  });

  it("la comprobación de admin existente usa el alias calificado ar.role (evita ambigüedad con el OUT parameter)", () => {
    expect(sql).toMatch(/from public\.admin_roles ar where ar\.role = 'admin'/);
  });

  it("marca la invitación consumida ANTES del insert en admin_roles, dentro de la misma función (mismo commit/rollback)", () => {
    const updateIdx = indexOfOrThrow("set consumed_at = now(), consumed_by = p_user_id");
    const insertIdx = indexOfOrThrow("insert into public.admin_roles");
    expect(updateIdx).toBeLessThan(insertIdx);
  });

  it("no hay ningún bloque EXCEPTION que capture errores del INSERT (un fallo debe abortar toda la transacción, no dejarla a medias)", () => {
    expect(sql).not.toMatch(/exception\s+when/i);
  });

  it("el rol insertado en admin_roles sale de la invitación (v_row.role), nunca de un parámetro del llamador", () => {
    expect(sql).toMatch(/values \(p_user_id, v_row\.role, v_row\.created_by\)/);
  });
});

describe("migración — EXECUTE privileges de la RPC", () => {
  it("revoca EXECUTE de public/anon/authenticated", () => {
    expect(sql).toMatch(
      /revoke all on function public\.consume_admin_invitation\(text, uuid\) from public/,
    );
    expect(sql).toMatch(
      /revoke execute on function public\.consume_admin_invitation\(text, uuid\) from anon/,
    );
    expect(sql).toMatch(
      /revoke execute on function public\.consume_admin_invitation\(text, uuid\) from authenticated/,
    );
  });

  it("concede EXECUTE únicamente a service_role", () => {
    expect(sql).toMatch(
      /grant execute on function public\.consume_admin_invitation\(text, uuid\) to service_role/,
    );
  });
});

describe("migración — sin secretos ni credenciales", () => {
  it("no contiene ningún valor que parezca una clave/token/contraseña", () => {
    expect(sql).not.toMatch(/service_role.*key\s*=\s*['"]/i);
    expect(sql).not.toMatch(/password\s*=\s*['"]/i);
    expect(sql).not.toMatch(/-----BEGIN/);
    expect(sql).not.toMatch(/eyJ[a-zA-Z0-9_-]{10,}/); // forma de un JWT real
  });

  it("no implementa ninguna comprobación de aal2/MFA en SQL (solo se menciona en comentarios como responsabilidad del backend)", () => {
    // La función no debe comparar ni condicionar nada contra 'aal2': esa verificación
    // vive exclusivamente en requireAuthenticated()/requirePrivileged() (Vercel), nunca
    // aquí. Las menciones a "aal2"/"MFA" en este archivo son solo comentarios.
    expect(sql).not.toMatch(/=\s*'aal2'/);
    expect(sql).not.toMatch(/aal\s*!==?\s*'aal2'/);
  });
});

describe("migración — no toca la migración ya aplicada de Bloque 1", () => {
  it("el archivo de Bloque 1 (admin_roles) permanece con su propio nombre, sin fusionar", () => {
    const bloque1 = readFileSync(
      resolve(__dirname, "../../supabase/migrations/20260922120000_admin_roles.sql"),
      "utf8",
    );
    expect(bloque1).not.toMatch(/admin_invitations/);
    expect(bloque1).not.toMatch(/consume_admin_invitation/);
  });
});
