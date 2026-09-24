import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "@vercel/node";
import {
  AdminAuthError,
  AdminAuthInfrastructureError,
  getPrivilegedRoleForUser,
  requireCapability,
  requireCapabilityForUser,
  requireAuthenticated,
  capabilitiesForRole,
  roleHasCapability,
  requireModerator,
  type Capability,
  type PrivilegedRole,
  requirePrivileged,
} from "./admin-auth";

// Fijan la frontera de seguridad de Auth/AuthZ server-side: requireAuthenticated (¿quién
// eres?, solo verificación criptográfica del JWT) y requirePrivileged/requireCapability
// requireModerator (¿qué puedes hacer?, solo admin_roles + AAL). Ningún endpoint existe
// todavía: estos tests son la única red de seguridad de este bloque.

const auth = vi.hoisted(() => ({
  /** { data, error } que devuelve getClaims, o undefined para usar el default. */
  getClaimsResult: undefined as { data: unknown; error: unknown } | undefined,
  /** Si está definido, getClaims lanza esto en vez de devolver un resultado. */
  getClaimsThrow: undefined as unknown,
  getClaimsCalls: [] as string[],
}));

const roles = vi.hoisted(() => ({
  /** Fila que "existe" en admin_roles, o null si no hay ninguna. */
  row: null as { role?: unknown } | null,
  /** Error devuelto por Supabase (no una excepción). */
  error: undefined as unknown,
  /** Excepción lanzada por el cliente (p. ej. fallo de red). */
  throwWith: undefined as unknown,
  queries: [] as { table: string; filters: [string, unknown][] }[],
}));

/** Cada llamada real a createClient(url, key, ...): permite comprobar qué key usó cada
 *  cliente (getAuthVerificationClient vs getRolesLookupClient) sin poder confundirlos. */
const clients = vi.hoisted(() => ({
  calls: [] as { url: string; key: string }[],
}));

function resetFakes() {
  auth.getClaimsResult = undefined;
  auth.getClaimsThrow = undefined;
  auth.getClaimsCalls = [];
  roles.row = null;
  roles.error = undefined;
  roles.throwWith = undefined;
  roles.queries = [];
  clients.calls = [];
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string) => {
    clients.calls.push({ url, key });
    return {
      auth: {
        async getClaims(jwt: string) {
          auth.getClaimsCalls.push(jwt);
          if (auth.getClaimsThrow) throw auth.getClaimsThrow;
          return (
            auth.getClaimsResult ?? { data: null, error: { message: "sin configurar" } }
          );
        },
      },
      from: (table: string) => ({
        select: () => {
          const filters: [string, unknown][] = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            async maybeSingle() {
              roles.queries.push({ table, filters });
              if (roles.throwWith) throw roles.throwWith;
              if (roles.error) return { data: null, error: roles.error };
              return { data: roles.row, error: null };
            },
          };
          return builder;
        },
      }),
    };
  },
}));

const SUPABASE_URL = "https://proyecto-ficticio.supabase.co";
const ANON_KEY = "anon-key-ficticia";
const SERVICE_ROLE_KEY = "srk-service-role-ficticia";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function claims(overrides: Record<string, unknown> = {}) {
  return { sub: USER_ID, aal: "aal2", ...overrides };
}

function okClaims(overrides: Record<string, unknown> = {}) {
  auth.getClaimsResult = { data: { claims: claims(overrides) }, error: null };
}

function req(
  headers: Record<string, string | string[] | undefined> = {},
  extra: Partial<VercelRequest> = {},
): VercelRequest {
  return { headers, ...extra } as unknown as VercelRequest;
}

function bearer(token = "un-jwt-cualquiera") {
  return req({ authorization: `Bearer ${token}` });
}

beforeEach(() => {
  resetFakes();
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", ANON_KEY);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function catchError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("se esperaba que la promesa rechazara");
}

describe("requireAuthenticated", () => {
  it("1) sin Authorization → 401", async () => {
    const error = await catchError(() => requireAuthenticated(req()));
    expect(error).toBeInstanceOf(AdminAuthError);
    expect((error as AdminAuthError).status).toBe(401);
    expect(auth.getClaimsCalls).toHaveLength(0);
  });

  it("2) esquema Basic (no Bearer) → 401, sin llamar a getClaims", async () => {
    const error = await catchError(() =>
      requireAuthenticated(req({ authorization: "Basic dXNlcjpwYXNz" })),
    );
    expect((error as AdminAuthError).status).toBe(401);
    expect(auth.getClaimsCalls).toHaveLength(0);
  });

  it("3) Bearer vacío (sin token, o solo espacios) → 401, sin llamar a getClaims", async () => {
    for (const value of ["Bearer", "Bearer ", "Bearer    "]) {
      resetFakes();
      const error = await catchError(() =>
        requireAuthenticated(req({ authorization: value })),
      );
      expect((error as AdminAuthError).status).toBe(401);
      expect(auth.getClaimsCalls).toHaveLength(0);
    }
  });

  it("4) JWT inválido (getClaims devuelve error) → 401", async () => {
    auth.getClaimsResult = { data: null, error: { message: "invalid JWT" } };
    const error = await catchError(() => requireAuthenticated(bearer("token-malo")));
    expect((error as AdminAuthError).status).toBe(401);
    expect((error as Error).message).not.toContain("token-malo");
  });

  it("5) getClaims lanza (JWT expirado / fallo de red al resolver JWKS) → 401", async () => {
    auth.getClaimsThrow = new Error("fetch failed al resolver JWKS");
    const error = await catchError(() =>
      requireAuthenticated(bearer("token-cualquiera")),
    );
    expect(error).toBeInstanceOf(AdminAuthError);
    expect((error as AdminAuthError).status).toBe(401);
  });

  it("6) claims sin sub (ausente, vacío o no string) → 401", async () => {
    for (const bad of [undefined, "", 42, null]) {
      resetFakes();
      okClaims({ sub: bad });
      const error = await catchError(() => requireAuthenticated(bearer()));
      expect((error as AdminAuthError).status).toBe(401);
    }
  });

  it("6b) claims sin aal (ausente, vacío o no string) → 401", async () => {
    for (const bad of [undefined, "", 42, null]) {
      resetFakes();
      okClaims({ aal: bad });
      const error = await catchError(() => requireAuthenticated(bearer()));
      expect((error as AdminAuthError).status).toBe(401);
    }
  });

  it("7) sub válido + aal1 → identidad autenticada (NO rechazada; requireAuthenticated no exige aal2)", async () => {
    okClaims({ aal: "aal1" });
    const identity = await requireAuthenticated(bearer());
    expect(identity).toEqual({ userId: USER_ID, aal: "aal1" });
  });

  it("8) sub válido + aal2 → identidad autenticada", async () => {
    okClaims();
    const identity = await requireAuthenticated(bearer("el-jwt"));
    expect(identity).toEqual({ userId: USER_ID, aal: "aal2" });
    expect(auth.getClaimsCalls).toEqual(["el-jwt"]);
  });

  it("nunca consulta admin_roles", async () => {
    okClaims();
    await requireAuthenticated(bearer());
    expect(roles.queries).toHaveLength(0);
  });

  it("Supabase de verificación sin configurar → AdminAuthInfrastructureError, sin llamar a getClaims", async () => {
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    const error = await catchError(() => requireAuthenticated(bearer()));
    expect(error).toBeInstanceOf(AdminAuthInfrastructureError);
    expect(auth.getClaimsCalls).toHaveLength(0);
  });
});

describe("requirePrivileged", () => {
  it("9) usuario autenticado sin fila en admin_roles → 403", async () => {
    okClaims();
    roles.row = null;
    const error = await catchError(() => requirePrivileged(bearer()));
    expect(error).toBeInstanceOf(AdminAuthError);
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("10) fallo de Supabase al leer admin_roles → AdminAuthInfrastructureError (fail closed, NO 403)", async () => {
    okClaims();
    roles.error = { code: "08006", message: `caída de conexión con ${USER_ID}` };
    const error = await catchError(() => requirePrivileged(bearer()));
    expect(error).toBeInstanceOf(AdminAuthInfrastructureError);
    expect(error).not.toBeInstanceOf(AdminAuthError);
    expect((error as AdminAuthInfrastructureError).code).toBe("08006");
  });

  it("10b) excepción de red al leer admin_roles → AdminAuthInfrastructureError, sin filtrar el mensaje original", async () => {
    okClaims();
    roles.throwWith = new TypeError(`fetch failed ${SERVICE_ROLE_KEY}`);
    const error = await catchError(() => requirePrivileged(bearer()));
    expect(error).toBeInstanceOf(AdminAuthInfrastructureError);
    expect((error as Error).message).not.toContain(SERVICE_ROLE_KEY);
  });

  it("11) role desconocido/malformado en la fila → 403 (fail closed, no se trata como admin/moderator)", async () => {
    okClaims();
    roles.row = { role: "superadmin" };
    const error = await catchError(() => requirePrivileged(bearer()));
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("12) admin + aal1 → 403", async () => {
    okClaims({ aal: "aal1" });
    roles.row = { role: "admin" };
    const error = await catchError(() => requirePrivileged(bearer()));
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("13) moderator + aal1 → 403", async () => {
    okClaims({ aal: "aal1" });
    roles.row = { role: "moderator" };
    const error = await catchError(() => requirePrivileged(bearer()));
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("14) admin + aal2 → permitido", async () => {
    okClaims();
    roles.row = { role: "admin" };
    await expect(requirePrivileged(bearer())).resolves.toEqual({
      userId: USER_ID,
      role: "admin",
    });
  });

  it("15) moderator + aal2 → permitido", async () => {
    okClaims();
    roles.row = { role: "moderator" };
    await expect(requirePrivileged(bearer())).resolves.toEqual({
      userId: USER_ID,
      role: "moderator",
    });
  });

  it("consulta admin_roles exactamente por el user_id verificado del JWT", async () => {
    okClaims();
    roles.row = { role: "admin" };
    await requirePrivileged(bearer());
    expect(roles.queries).toHaveLength(1);
    expect(roles.queries[0].table).toBe("admin_roles");
    expect(roles.queries[0].filters).toEqual([["user_id", USER_ID]]);
  });
});

describe("requireCapability(social_admin)", () => {
  it("16) admin + aal2 → PASS", async () => {
    okClaims();
    roles.row = { role: "admin" };
    await expect(requireCapability(bearer(), "social_admin")).resolves.toMatchObject({
      userId: USER_ID,
      role: "admin",
    });
  });

  it("17) moderator + aal2 → 403", async () => {
    okClaims();
    roles.row = { role: "moderator" };
    const error = await catchError(() => requireCapability(bearer(), "social_admin"));
    expect(error).toBeInstanceOf(AdminAuthError);
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("sin fila → 403 (no se confunde con moderator)", async () => {
    okClaims();
    const error = await catchError(() => requireCapability(bearer(), "social_admin"));
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("fallo de infraestructura se propaga sin convertirse en 403", async () => {
    okClaims();
    roles.throwWith = new Error("boom");
    const error = await catchError(() => requireCapability(bearer(), "social_admin"));
    expect(error).toBeInstanceOf(AdminAuthInfrastructureError);
  });
});

describe("requireModerator", () => {
  it("18) moderator + aal2 → PASS", async () => {
    okClaims();
    roles.row = { role: "moderator" };
    await expect(requireModerator(bearer())).resolves.toEqual({
      userId: USER_ID,
      role: "moderator",
      capabilities: ["moderation"],
    });
  });

  it("19) admin + aal2 → PASS (ADMIN hereda capacidad de moderación)", async () => {
    okClaims();
    roles.row = { role: "admin" };
    await expect(requireModerator(bearer())).resolves.toEqual({
      userId: USER_ID,
      role: "admin",
      capabilities: ["moderation", "technical", "social_admin", "team_admin"],
    });
  });

  it("aal1 → 403 igual que requirePrivileged", async () => {
    okClaims({ aal: "aal1" });
    roles.row = { role: "moderator" };
    const error = await catchError(() => requireModerator(bearer()));
    expect((error as AdminAuthError).status).toBe(403);
  });
});

describe("seguridad: nada enviado por el request afecta la autorización", () => {
  it("20) un user_id inyectado en headers/query/body ajenos NO sustituye al `sub` verificado del JWT", async () => {
    okClaims({ sub: USER_ID }); // el JWT real es de un usuario SIN fila privilegiada
    roles.row = null;

    const attackerReq = req(
      {
        authorization: "Bearer el-jwt-real",
        "x-user-id": "00000000-0000-4000-8000-000000000000",
      },
      {
        query: { user_id: "00000000-0000-4000-8000-000000000000" },
        body: { userId: "00000000-0000-4000-8000-000000000000" },
      } as never,
    );

    const error = await catchError(() => requirePrivileged(attackerReq));
    expect((error as AdminAuthError).status).toBe(403);
    // La consulta a admin_roles usó el user_id del JWT verificado, nunca el inyectado.
    expect(roles.queries[0].filters).toEqual([["user_id", USER_ID]]);
  });

  it("21) un role='admin' inyectado en headers/query/body NO concede privilegios sin fila real", async () => {
    okClaims();
    roles.row = null; // sin fila real en admin_roles

    const attackerReq = req({ authorization: "Bearer el-jwt-real", "x-role": "admin" }, {
      query: { role: "admin" },
      body: { role: "admin" },
    } as never);

    const error = await catchError(() => requireCapability(attackerReq, "social_admin"));
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("22) un aal='aal2' inyectado en headers/query/body NO sustituye al aal real del JWT (aal1)", async () => {
    okClaims({ aal: "aal1" }); // el JWT real solo tiene aal1
    roles.row = { role: "admin" };

    const attackerReq = req({ authorization: "Bearer el-jwt-real", "x-aal": "aal2" }, {
      query: { aal: "aal2" },
      body: { aal: "aal2" },
    } as never);

    const error = await catchError(() => requirePrivileged(attackerReq));
    expect((error as AdminAuthError).status).toBe(403);
  });
});

describe("separación de keys entre clientes", () => {
  it("getAuthVerificationClient (usado por getClaims) usa VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY, nunca la service_role", async () => {
    okClaims();
    await requireAuthenticated(bearer());

    expect(clients.calls).toHaveLength(1);
    expect(clients.calls[0]).toEqual({ url: SUPABASE_URL, key: ANON_KEY });
    expect(clients.calls[0].key).not.toBe(SERVICE_ROLE_KEY);
  });

  it("getRolesLookupClient (usado para admin_roles) usa VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, nunca la anon key", async () => {
    okClaims();
    roles.row = { role: "admin" };
    await requirePrivileged(bearer());

    // Llamada 1 (requireAuthenticated → getClaims): anon key.
    expect(clients.calls[0]).toEqual({ url: SUPABASE_URL, key: ANON_KEY });
    // Llamada 2 (getPrivilegedRole → admin_roles): service_role key, nunca la anon.
    expect(clients.calls[1]).toEqual({ url: SUPABASE_URL, key: SERVICE_ROLE_KEY });
    expect(clients.calls[1].key).not.toBe(ANON_KEY);
  });
});

describe("el token solo se acepta en Authorization: Bearer", () => {
  it("sin Authorization, con user_id/role/aal/access_token en query, body y cookie → 401, getClaims nunca llega a llamarse", async () => {
    // Configurado para que, SI algo de esto se leyera por error, la petición tendría
    // éxito con privilegios de admin: hace que el test sea una prueba real de que nada
    // de esto se usa, no solo de que el resultado final sea 401 por casualidad.
    okClaims();
    roles.row = { role: "admin" };

    const maliciousReq = req(
      {
        // Sin "authorization". Un header de cookie con nombres plausibles de sesión.
        cookie: "sb-access-token=jwt-de-cookie-que-no-cuenta; role=admin; aal=aal2",
      },
      {
        query: {
          user_id: USER_ID,
          role: "admin",
          aal: "aal2",
          access_token: "jwt-de-query-que-no-cuenta",
        },
        body: {
          user_id: USER_ID,
          role: "admin",
          aal: "aal2",
          access_token: "jwt-de-body-que-no-cuenta",
        },
      } as never,
    );

    const error = await catchError(() => requireAuthenticated(maliciousReq));
    expect(error).toBeInstanceOf(AdminAuthError);
    expect((error as AdminAuthError).status).toBe(401);
    // No solo "no tuvo éxito con esos valores": getClaims ni siquiera se invocó.
    expect(auth.getClaimsCalls).toHaveLength(0);
    expect(clients.calls).toHaveLength(0);
  });
});

describe("errores nunca filtran datos sensibles", () => {
  it("AdminAuthError/AdminAuthInfrastructureError nunca incluyen el JWT, claims completas ni el contenido de admin_roles", async () => {
    const TOKEN = "jwt-secreto-que-nunca-deberia-aparecer";
    okClaims({ sub: USER_ID, aal: "aal1", email: "mina@example.com" });
    roles.error = { code: "42501", message: `permission denied para ${USER_ID}` };

    const error = await catchError(() => requirePrivileged(bearer(TOKEN)));
    const serialized = JSON.stringify({
      message: (error as Error).message,
      code: (error as AdminAuthInfrastructureError).code,
    });
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("mina@example.com");
    expect(serialized).not.toContain("permission denied");
  });
});

describe("requireCapabilityForUser(social_admin) / getPrivilegedRoleForUser (recomprobación sin sesión)", () => {
  it("admin → resuelve; consulta admin_roles con el user_id dado y la service_role key", async () => {
    roles.row = { role: "admin" };
    await expect(
      requireCapabilityForUser(USER_ID, "social_admin"),
    ).resolves.toBeUndefined();
    expect(roles.queries).toEqual([
      { table: "admin_roles", filters: [["user_id", USER_ID]] },
    ]);
    expect(clients.calls).toEqual([{ url: SUPABASE_URL, key: SERVICE_ROLE_KEY }]);
    expect(auth.getClaimsCalls).toHaveLength(0);
  });

  it("moderator → 403 (MODERATOR no hereda ADMIN)", async () => {
    roles.row = { role: "moderator" };
    const error = await catchError(() =>
      requireCapabilityForUser(USER_ID, "social_admin"),
    );
    expect(error).toBeInstanceOf(AdminAuthError);
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("sin fila en admin_roles → 403", async () => {
    roles.row = null;
    const error = await catchError(() =>
      requireCapabilityForUser(USER_ID, "social_admin"),
    );
    expect(error).toBeInstanceOf(AdminAuthError);
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("fila con un rol no reconocido → 403", async () => {
    roles.row = { role: "superadmin" };
    const error = await catchError(() =>
      requireCapabilityForUser(USER_ID, "social_admin"),
    );
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("error de Supabase → AdminAuthInfrastructureError (fail closed, nunca 'sin rol')", async () => {
    roles.error = { code: "57014", message: "timeout" };
    const error = await catchError(() =>
      requireCapabilityForUser(USER_ID, "social_admin"),
    );
    expect(error).toBeInstanceOf(AdminAuthInfrastructureError);
    expect(error).not.toBeInstanceOf(AdminAuthError);
    expect((error as AdminAuthInfrastructureError).code).toBe("57014");
  });

  it("excepción del cliente (red) → AdminAuthInfrastructureError", async () => {
    roles.throwWith = new Error("ECONNRESET");
    const error = await catchError(() =>
      requireCapabilityForUser(USER_ID, "social_admin"),
    );
    expect(error).toBeInstanceOf(AdminAuthInfrastructureError);
    expect(error.message).not.toContain("ECONNRESET");
  });

  it("sin configuración de Supabase → AdminAuthInfrastructureError", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const error = await catchError(() =>
      requireCapabilityForUser(USER_ID, "social_admin"),
    );
    expect(error).toBeInstanceOf(AdminAuthInfrastructureError);
  });

  it("userId vacío o no string → 403 sin consultar la base de datos", async () => {
    for (const bad of ["", undefined, null, 42]) {
      const error = await catchError(() =>
        requireCapabilityForUser(bad as never, "social_admin"),
      );
      expect((error as AdminAuthError).status).toBe(403);
    }
    expect(roles.queries).toHaveLength(0);
  });

  it("getPrivilegedRoleForUser distingue admin, moderator y sin rol", async () => {
    roles.row = { role: "admin" };
    expect(await getPrivilegedRoleForUser(USER_ID)).toBe("admin");
    roles.row = { role: "moderator" };
    expect(await getPrivilegedRoleForUser(USER_ID)).toBe("moderator");
    roles.row = null;
    expect(await getPrivilegedRoleForUser(USER_ID)).toBeNull();
  });

  it("no cambia requireCapability(social_admin): sigue exigiendo aal2 aunque exista la recomprobación", async () => {
    okClaims({ aal: "aal1" });
    roles.row = { role: "admin" };
    const error = await catchError(() => requireCapability(bearer(), "social_admin"));
    expect((error as AdminAuthError).status).toBe(403);
  });
});

describe("9C — capacidades explícitas (matriz rol → capacidad)", () => {
  const ALL: Capability[] = ["moderation", "technical", "social_admin", "team_admin"];
  // undefined = USER (sin fila en admin_roles)
  const MATRIX: Record<
    Capability,
    Record<"admin" | "developer" | "moderator" | "user", boolean>
  > = {
    moderation: { admin: true, developer: true, moderator: true, user: false },
    technical: { admin: true, developer: true, moderator: false, user: false },
    social_admin: { admin: true, developer: false, moderator: false, user: false },
    team_admin: { admin: true, developer: false, moderator: false, user: false },
  };

  for (const capability of ALL) {
    for (const who of ["admin", "developer", "moderator", "user"] as const) {
      const allowed = MATRIX[capability][who];
      it(`requireCapability(${capability}) con ${who} + aal2 → ${allowed ? "permitido" : "403"}`, async () => {
        okClaims();
        roles.row = who === "user" ? null : { role: who };
        if (allowed) {
          const id = await requireCapability(bearer(), capability);
          expect(id.userId).toBe(USER_ID);
          expect(id.role).toBe(who);
          expect(id.capabilities).toContain(capability);
        } else {
          const error = await catchError(() => requireCapability(bearer(), capability));
          expect(error).toBeInstanceOf(AdminAuthError);
          expect((error as AdminAuthError).status).toBe(403);
        }
      });

      it(`requireCapability(${capability}) con ${who} + aal1 → 403 siempre`, async () => {
        okClaims({ aal: "aal1" });
        roles.row = who === "user" ? null : { role: who };
        const error = await catchError(() => requireCapability(bearer(), capability));
        expect((error as AdminAuthError).status).toBe(403);
      });

      if (who !== "user") {
        it(`requireCapabilityForUser(${capability}) con ${who} → ${allowed ? "resuelve" : "403"}`, async () => {
          roles.row = { role: who };
          if (allowed) {
            await expect(
              requireCapabilityForUser(USER_ID, capability),
            ).resolves.toBeUndefined();
          } else {
            const error = await catchError(() =>
              requireCapabilityForUser(USER_ID, capability),
            );
            expect((error as AdminAuthError).status).toBe(403);
          }
        });
      }
    }
  }

  it("la matriz exportada coincide con la requerida (sin jerarquía implícita)", () => {
    for (const cap of ALL) {
      for (const role of ["admin", "developer", "moderator"] as PrivilegedRole[]) {
        expect(roleHasCapability(role, cap)).toBe(MATRIX[cap][role]);
      }
    }
    expect(capabilitiesForRole("developer")).toEqual(["moderation", "technical"]);
    expect(capabilitiesForRole("moderator")).toEqual(["moderation"]);
  });

  it("capabilitiesForRole devuelve una copia: mutarla no altera la matriz", () => {
    capabilitiesForRole("moderator").push("team_admin");
    expect(roleHasCapability("moderator", "team_admin")).toBe(false);
    expect(capabilitiesForRole("moderator")).toEqual(["moderation"]);
  });

  it("requireModerator = capacidad moderation: developer permitido, USER 403", async () => {
    okClaims();
    roles.row = { role: "developer" };
    await expect(requireModerator(bearer())).resolves.toMatchObject({
      role: "developer",
    });
    roles.row = null;
    const error = await catchError(() => requireModerator(bearer()));
    expect((error as AdminAuthError).status).toBe(403);
  });

  it("resolución de rol: reconoce developer; valores inesperados fail-closed (null, nunca un rol válido)", async () => {
    roles.row = { role: "developer" };
    expect(await getPrivilegedRoleForUser(USER_ID)).toBe("developer");
    for (const bad of [
      "superadmin",
      "ADMIN",
      "Developer",
      "",
      " admin",
      null,
      undefined,
      1,
      {},
    ]) {
      roles.row = { role: bad };
      expect(await getPrivilegedRoleForUser(USER_ID)).toBeNull();
    }
    roles.row = null;
    expect(await getPrivilegedRoleForUser(USER_ID)).toBeNull();
  });

  it("rol inesperado con aal2 → 403 en cualquier capacidad", async () => {
    okClaims();
    roles.row = { role: "owner" };
    for (const cap of ALL) {
      const error = await catchError(() => requireCapability(bearer(), cap));
      expect((error as AdminAuthError).status).toBe(403);
    }
  });

  it("un solo acceso a admin_roles por autorización (sin consultas duplicadas)", async () => {
    okClaims();
    roles.row = { role: "admin" };
    await requireCapability(bearer(), "team_admin");
    expect(roles.queries).toHaveLength(1);
  });
});
