import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo enfoque que admin-invitations-migration.test.ts: no hay Postgres real disponible
// en este entorno de test (ni pg-mem/pglite), así que estas pruebas verifican
// ESTÁTICAMENTE el contenido de la migración de profiles (Bloque 7B): esquema,
// constraints, RLS, grants/policies y triggers. La única "ejecución" es la del patrón del
// username, que se extrae del propio SQL y se prueba con el motor de regex de JS (para
// este patrón `^[a-z0-9_]{3,20}$` la semántica coincide con la de Postgres). NO sustituyen
// aplicar la migración en un Postgres real y comprobar RLS/grants/triggers con datos
// (queda como verificación de solo lectura tras aplicarla en Supabase).

const MIGRATION_PATH = resolve(
  __dirname,
  "../../supabase/migrations/20260924120000_profiles.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

/** SQL sin comentarios de línea (`-- ...`): las comprobaciones "no debe existir X" no
 *  deben dispararse por texto explicativo en los comentarios. */
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

/** Cuerpo del `create table ... ( ... );` de profiles. */
function tableBody(): string {
  const start = code.indexOf("create table public.profiles");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = code.indexOf("\n);", start);
  return code.slice(start, end + 3);
}

describe("migración 20260924120000_profiles.sql — esquema", () => {
  it("crea public.profiles con exactamente las 7 columnas previstas", () => {
    const body = tableBody();
    const columns = [
      /user_id\s+uuid primary key references auth\.users\(id\) on delete cascade/,
      /username\s+text not null/,
      /display_name\s+text,/,
      /bio\s+text,/,
      /avatar_path\s+text,/,
      /created_at\s+timestamptz not null default now\(\)/,
      /updated_at\s+timestamptz not null default now\(\)/,
    ];
    for (const column of columns) expect(body).toMatch(column);
  });

  it("user_id es PK + FK a auth.users(id) + ON DELETE CASCADE", () => {
    expect(tableBody()).toMatch(
      /user_id\s+uuid primary key references auth\.users\(id\) on delete cascade/,
    );
  });

  it("no contiene role/admin/moderator/email/password/MFA/claims/tokens/metadata como columna", () => {
    const body = tableBody();
    const forbidden =
      /^\s*(role|is_admin|is_moderator|admin|moderator|email|password|mfa|aal|claims|metadata|raw_user_meta_data|access_token|refresh_token|avatar_url)\b/im;
    expect(body).not.toMatch(forbidden);
  });

  it("no crea ninguna FK ni dependencia con admin_roles ni admin_invitations", () => {
    // (los COMMENT ON pueden mencionar admin_roles en prosa; lo que no debe existir es
    // ninguna referencia estructural)
    expect(code).not.toMatch(/references\s+(public\.)?admin_(roles|invitations)/i);
    expect(code).not.toMatch(/\bon\s+(table\s+)?public\.admin_(roles|invitations)/i);
    expect(code).not.toMatch(/\bfrom\s+public\.admin_(roles|invitations)/i);
  });

  it("no modifica tablas de migraciones anteriores", () => {
    expect(code).not.toMatch(
      /alter table public\.(admin_roles|admin_invitations|social_connections|instagram_oauth_nonces)/i,
    );
    expect(code).not.toMatch(/alter table auth\./i);
  });

  it("no crea Storage, buckets ni URLs de avatar", () => {
    expect(code).not.toMatch(/storage\./i);
    expect(code).not.toMatch(/bucket/i);
    expect(code).not.toMatch(/avatar_url/i);
  });
});

describe("constraints", () => {
  it("username: NOT NULL, UNIQUE y CHECK de formato ^[a-z0-9_]{3,20}$", () => {
    const body = tableBody();
    expect(body).toMatch(/username\s+text not null/);
    expect(body).toMatch(/constraint profiles_username_key unique \(username\)/);
    expect(body).toMatch(
      /constraint profiles_username_format check \(username ~ '\^\[a-z0-9_\]\{3,20\}\$'\)/,
    );
  });

  it("el patrón de username (extraído del SQL) acepta lo válido y rechaza lo inválido", () => {
    const match = /username ~ '([^']+)'/.exec(code);
    expect(match).not.toBeNull();
    const pattern = new RegExp(match![1]);

    for (const ok of ["abc", "mina_01", "a_b", "0123456789", "x".repeat(20), "___"]) {
      expect(pattern.test(ok), `debería aceptar ${ok}`).toBe(true);
    }
    const bad = [
      "",
      "ab", // demasiado corto
      "x".repeat(21), // demasiado largo
      "Mina", // mayúsculas
      "mina!", // símbolo
      "mi na", // espacio
      "mina-1", // guion
      "minä", // no ASCII
      "аdmin", // homoglifo cirílico
      "mina\n", // salto de línea final
      " mina",
      "mina ",
    ];
    for (const value of bad) {
      expect(pattern.test(value), `debería rechazar ${JSON.stringify(value)}`).toBe(
        false,
      );
    }
  });

  it("display_name: nullable, 1 a 40 caracteres, no solo espacios, sin caracteres de control", () => {
    const body = tableBody();
    expect(body).toMatch(/display_name\s+text,/);
    expect(body).toMatch(
      /profiles_display_name_length check \(\s*display_name is null\s*or \(char_length\(display_name\) between 1 and 40 and btrim\(display_name\) <> ''\)\s*\)/,
    );
    expect(body).toMatch(
      /profiles_display_name_no_control_chars check \(\s*display_name is null or display_name !~ '\[\[:cntrl:\]\]'\s*\)/,
    );
  });

  it("bio: nullable y máximo 280 caracteres", () => {
    const body = tableBody();
    expect(body).toMatch(/bio\s+text,/);
    expect(body).toMatch(
      /constraint profiles_bio_length check \(bio is null or char_length\(bio\) <= 280\)/,
    );
  });

  it("avatar_path: nullable, ruta (no URL con esquema ni //), máximo 255, sin caracteres de control", () => {
    const body = tableBody();
    expect(body).toMatch(/avatar_path\s+text,/);
    expect(body).toMatch(/char_length\(avatar_path\) between 1 and 255/);
    expect(body).toMatch(/avatar_path !~ '\^\[A-Za-z\]\[A-Za-z0-9\+\.-\]\*:'/);
    expect(body).toMatch(/avatar_path !~ '\^\/\/'/);
    expect(body).toMatch(/avatar_path !~ '\[\[:cntrl:\]\]'/);
  });

  it("el patrón anti-esquema de avatar_path (extraído del SQL) rechaza URLs y acepta rutas", () => {
    const match = /avatar_path !~ '(\^\[A-Za-z\]\[A-Za-z0-9\+\.-\]\*:)'/.exec(code);
    expect(match).not.toBeNull();
    const scheme = new RegExp(match![1]);
    for (const url of [
      "https://x.test/a.png",
      "http://x",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
    ]) {
      expect(scheme.test(url), url).toBe(true);
    }
    for (const path of ["avatars/u1/a.png", "u1/a.png", "a.png"]) {
      expect(scheme.test(path), path).toBe(false);
    }
  });
});

describe("RLS, grants y policies", () => {
  it("activa Y fuerza RLS", () => {
    expect(code).toMatch(/alter table public\.profiles enable row level security;/);
    expect(code).toMatch(/alter table public\.profiles force row level security;/);
  });

  it("revoca todo a public, anon y authenticated antes de conceder nada", () => {
    const firstGrant = code.indexOf("grant select on table public.profiles");
    for (const role of ["public", "anon", "authenticated"]) {
      const revoke = code.indexOf(`revoke all on table public.profiles from ${role};`);
      expect(revoke, `revoke a ${role}`).toBeGreaterThanOrEqual(0);
      expect(revoke).toBeLessThan(firstGrant);
    }
  });

  it("SELECT queda concedido a anon y authenticated, con una policy SELECT pública", () => {
    expect(code).toMatch(
      /grant select on table public\.profiles to anon, authenticated;/,
    );
    expect(code).toMatch(
      /create policy profiles_select_public\s+on public\.profiles\s+for select\s+to anon, authenticated\s+using \(true\);/,
    );
  });

  /** Privilegios concedidos por `grant ... on table public.profiles to <role>`, por rol. */
  function grantedPrivileges(role: string): string[] {
    const grants = [
      ...code.matchAll(/grant\s+([^;]+?)\s+on table public\.profiles\s+to\s+([^;]+);/gi),
    ];
    const privileges: string[] = [];
    for (const [, list, grantees] of grants) {
      const to = grantees.split(",").map((g) => g.trim().toLowerCase());
      if (to.includes(role)) {
        privileges.push(...list.split(",").map((p) => p.trim().toLowerCase()));
      }
    }
    return privileges.sort();
  }

  it("anon = SELECT solamente", () => {
    expect(grantedPrivileges("anon")).toEqual(["select"]);
  });

  it("authenticated = SELECT solamente", () => {
    expect(grantedPrivileges("authenticated")).toEqual(["select"]);
  });

  it("public no recibe ningún grant", () => {
    expect(grantedPrivileges("public")).toEqual([]);
  });

  it("service_role = SELECT + INSERT + UPDATE + DELETE (y nada más, sin grant all)", () => {
    expect(grantedPrivileges("service_role")).toEqual([
      "delete",
      "insert",
      "select",
      "update",
    ]);
    expect(code).not.toMatch(/grant all[^;]*public\.profiles/i);
  });

  it("ninguna policy INSERT/UPDATE/DELETE/ALL para el navegador: la única policy es SELECT", () => {
    const policies = [
      ...code.matchAll(/create policy\s+(\S+)\s+on public\.profiles\s+for\s+(\w+)/gi),
    ];
    expect(policies.map((p) => p[2].toLowerCase())).toEqual(["select"]);
    expect(code).not.toMatch(/for\s+(insert|update|delete|all)\b/i);
  });

  it("no es artificialmente idempotente: sin DROP de nada ni IF NOT EXISTS/OR REPLACE", () => {
    expect(code).not.toMatch(/\bdrop\s+/i);
    expect(code).not.toMatch(/if not exists/i);
    expect(code).not.toMatch(/or replace/i);
  });
});

describe("trigger: user_id inmutable y updated_at", () => {
  it("define profiles_before_update y lo engancha como BEFORE UPDATE FOR EACH ROW", () => {
    expect(code).toMatch(
      /create function public\.profiles_before_update\(\)\s+returns trigger/,
    );
    expect(code).toMatch(
      /create trigger profiles_before_update\s+before update on public\.profiles\s+for each row\s+execute function public\.profiles_before_update\(\);/,
    );
  });

  it("rechaza cambiar user_id (IS DISTINCT FROM old.user_id → excepción)", () => {
    expect(code).toMatch(
      /if new\.user_id is distinct from old\.user_id then\s+raise exception 'profiles_user_id_immutable';/,
    );
  });

  it("fija updated_at := now() ignorando el valor enviado", () => {
    expect(code).toMatch(/new\.updated_at := now\(\);\s+return new;/);
  });

  it("no es SECURITY DEFINER, fija search_path y no expone EXECUTE", () => {
    const fnStart = code.indexOf("create function public.profiles_before_update()");
    const fnHeader = code.slice(fnStart, code.indexOf("as $$", fnStart));
    expect(fnHeader).not.toMatch(/security definer/i);
    expect(fnHeader).toMatch(/set search_path = pg_catalog/);
    expect(code).toMatch(
      /revoke all on function public\.profiles_before_update\(\) from public;/,
    );
    for (const role of ["anon", "authenticated"]) {
      expect(code).toMatch(
        new RegExp(
          `revoke execute on function public\\.profiles_before_update\\(\\) from ${role};`,
        ),
      );
    }
    expect(code).not.toMatch(/grant execute on function public\.profiles_before_update/i);
  });
});

describe("comentarios y ausencia de secretos", () => {
  it("documenta tabla, columnas y función con COMMENT ON", () => {
    expect(sql).toMatch(/comment on table public\.profiles is/);
    for (const column of [
      "user_id",
      "username",
      "display_name",
      "bio",
      "avatar_path",
      "updated_at",
    ]) {
      expect(sql).toMatch(
        new RegExp(`comment on column public\\.profiles\\.${column} is`),
      );
    }
    expect(sql).toMatch(/comment on function public\.profiles_before_update\(\) is/);
  });

  it("no contiene secretos ni JWT", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(sql).not.toMatch(/service_role_key|sk_live|BEGIN (RSA|PRIVATE)/i);
  });
});

// ---------------------------------------------------------------------------------------
// Privilegios EFECTIVOS finales (Bloque 7B.3). El estado final de public.profiles depende
// de la migración histórica 20260924120000_profiles.sql MÁS la correctiva
// 20260924130000_profiles_service_role_privileges.sql (la histórica ya está aplicada en
// remoto y no se modifica). La verificación real mostró que service_role conservaba
// TRUNCATE/REFERENCES/TRIGGER: los default privileges de Supabase en `public` conceden
// todos los privilegios a anon/authenticated/service_role sobre tablas nuevas, y la
// migración histórica solo revocaba `all` a public/anon/authenticated.
// ---------------------------------------------------------------------------------------

const FIX_PATH = resolve(
  __dirname,
  "../../supabase/migrations/20260924130000_profiles_service_role_privileges.sql",
);
const fixSql = readFileSync(FIX_PATH, "utf8");
const fixCode = fixSql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

const ALL_TABLE_PRIVILEGES = [
  "select",
  "insert",
  "update",
  "delete",
  "truncate",
  "references",
  "trigger",
];

/** Simula los GRANT/REVOKE sobre public.profiles de las migraciones dadas, en orden,
 *  partiendo de los default privileges de Supabase (todo a anon/authenticated/service_role,
 *  nada a PUBLIC). Solo entiende sentencias `grant|revoke <privs|all> on table
 *  public.profiles to|from <roles>`. */
function effectivePrivileges(...sources: string[]): Record<string, Set<string>> {
  const acl: Record<string, Set<string>> = {
    public: new Set(),
    anon: new Set(ALL_TABLE_PRIVILEGES),
    authenticated: new Set(ALL_TABLE_PRIVILEGES),
    service_role: new Set(ALL_TABLE_PRIVILEGES),
  };
  for (const source of sources) {
    for (const statement of source.split(";")) {
      const match =
        /^\s*(grant|revoke)\s+([\s\S]+?)\s+on table public\.profiles\s+(?:to|from)\s+([\s\S]+)$/i.exec(
          statement,
        );
      if (!match) continue;
      const [, verb, rawPrivileges, rawRoles] = match;
      const privileges = /^all$/i.test(rawPrivileges.trim())
        ? ALL_TABLE_PRIVILEGES
        : rawPrivileges.split(",").map((p) => p.trim().toLowerCase());
      for (const role of rawRoles.split(",").map((r) => r.trim().toLowerCase())) {
        acl[role] ??= new Set();
        for (const privilege of privileges) {
          if (verb.toLowerCase() === "grant") acl[role].add(privilege);
          else acl[role].delete(privilege);
        }
      }
    }
  }
  return acl;
}

function expectPrivileges(
  acl: Record<string, Set<string>>,
  role: string,
  granted: string[],
) {
  for (const privilege of ALL_TABLE_PRIVILEGES) {
    expect(
      acl[role].has(privilege),
      `${role} ${privilege.toUpperCase()} debería ser ${granted.includes(privilege)}`,
    ).toBe(granted.includes(privilege));
  }
}

describe("migración correctiva 20260924130000_profiles_service_role_privileges.sql", () => {
  it("solo revoca TRUNCATE, REFERENCES y TRIGGER de service_role sobre public.profiles", () => {
    const statements = fixCode
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(statements[0].replace(/\s+/g, " ")).toBe(
      "revoke truncate, references, trigger on table public.profiles from service_role",
    );
  });

  it("no toca anon, authenticated, PUBLIC, RLS, policies, trigger, función, columnas ni datos", () => {
    expect(fixCode).not.toMatch(
      /\b(anon|authenticated|public\s*;|to public|from public)\b/i,
    );
    expect(fixCode).not.toMatch(
      /\b(grant|alter|create|drop|insert|update|delete|truncate\s+table|policy|trigger\s+\w+\s+(before|after)|function)\b/i,
    );
    expect(fixCode).not.toMatch(/revoke\s+all/i);
  });

  it("no revoca SELECT/INSERT/UPDATE/DELETE de service_role", () => {
    const revoked = /revoke\s+([^;]+?)\s+on table/i.exec(fixCode)![1];
    for (const kept of ["select", "insert", "update", "delete"]) {
      expect(revoked.toLowerCase()).not.toContain(kept);
    }
  });

  it("no contiene secretos", () => {
    expect(fixSql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|sk_live|BEGIN (RSA|PRIVATE)/i);
  });
});

describe("estado final efectivo = migración histórica + correctiva", () => {
  const acl = effectivePrivileges(code, fixCode);

  it("anon: solo SELECT", () => expectPrivileges(acl, "anon", ["select"]));
  it("authenticated: solo SELECT", () =>
    expectPrivileges(acl, "authenticated", ["select"]));
  it("PUBLIC: ningún privilegio", () => expectPrivileges(acl, "public", []));
  it("service_role: SELECT, INSERT, UPDATE y DELETE; sin TRUNCATE, REFERENCES ni TRIGGER", () =>
    expectPrivileges(acl, "service_role", ["select", "insert", "update", "delete"]));

  it("documenta el hallazgo: solo con la migración histórica service_role conservaba TRUNCATE/REFERENCES/TRIGGER", () => {
    const historicalOnly = effectivePrivileges(code);
    expect([...historicalOnly.service_role].sort()).toEqual(
      [...ALL_TABLE_PRIVILEGES].sort(),
    );
    // Y la correctiva elimina exactamente esos tres, nada más.
    const removed = [...historicalOnly.service_role].filter(
      (p) => !acl.service_role.has(p),
    );
    expect(removed.sort()).toEqual(["references", "trigger", "truncate"]);
  });

  it("la migración histórica sigue intacta: no menciona la corrección", () => {
    expect(sql).not.toMatch(/truncate|references, trigger/i);
    expect(sql).toMatch(
      /grant select, insert, update, delete on table public\.profiles to service_role;/,
    );
  });
});
