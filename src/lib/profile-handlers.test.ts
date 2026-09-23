import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleProfileCreate } from "./profile-handlers";
import { checkUsername, RESERVED_USERNAMES } from "./profile-username";

// Contrato de POST /api/profile (Bloque 7C.1). Se usa el requireAuthenticated REAL: el
// createClient falso implementa auth.getClaims (verificación de JWT) y from().insert()
// (service_role), de modo que la identidad del INSERT se comprueba de extremo a extremo
// sin tocar Supabase remoto.

const SUPABASE_URL = "https://proyecto.supabase.co";
const ANON_KEY = "anon-key-de-prueba";
const SERVICE_ROLE_KEY = "service-role-key-de-prueba";
const JWT_USER_ID = "11111111-1111-4111-8111-111111111111";
const BODY_USER_ID = "99999999-9999-4999-8999-999999999999";
const VALID_TOKEN = "jwt-sintetico-valido";

const fakes = vi.hoisted(() => ({
  clients: [] as { url: string; key: string }[],
  tables: [] as string[],
  rpcCalls: [] as string[],
  inserts: [] as unknown[],
  selects: [] as string[],
  claims: { sub: "", aal: "aal1" } as Record<string, unknown>,
  insertResult: undefined as { data: unknown; error: unknown } | undefined,
  insertThrows: undefined as unknown,
  ops: [] as string[],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string) => {
    fakes.clients.push({ url, key });
    return {
      auth: {
        getClaims: async (token: string) =>
          token === VALID_TOKEN
            ? { data: { claims: fakes.claims }, error: null }
            : { data: null, error: { message: "jwt invalido" } },
      },
      rpc: async (name: string) => {
        fakes.rpcCalls.push(name);
        return { data: null, error: null };
      },
      from: (table: string) => {
        fakes.tables.push(table);
        return {
          insert: (row: unknown) => {
            fakes.ops.push("insert");
            fakes.inserts.push(row);
            return {
              select: (columns: string) => {
                fakes.selects.push(columns);
                return {
                  single: async () => {
                    if (fakes.insertThrows !== undefined) throw fakes.insertThrows;
                    if (fakes.insertResult) return fakes.insertResult;
                    const { username } = row as { username: string };
                    return {
                      data: {
                        username,
                        display_name: null,
                        bio: null,
                        avatar_path: null,
                        created_at: "2026-09-23T00:00:00Z",
                        updated_at: "2026-09-23T00:00:00Z",
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  },
}));

const fetchSpy = vi.fn();

beforeEach(() => {
  fakes.clients = [];
  fakes.tables = [];
  fakes.rpcCalls = [];
  fakes.inserts = [];
  fakes.selects = [];
  fakes.claims = { sub: JWT_USER_ID, aal: "aal1" };
  fakes.insertResult = undefined;
  fakes.insertThrows = undefined;
  fakes.ops = [];
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", ANON_KEY);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function req(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
    query: {},
    body: { username: "edwin390" },
    ...overrides,
  } as unknown as VercelRequest;
}

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    setHeader(key: string, value: string) {
      state.headers[key] = value;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

async function call(overrides: Partial<VercelRequest> = {}) {
  const { res, state } = mockRes();
  await handleProfileCreate(req(overrides), res);
  return state;
}

function insertedUsername(): string {
  return (fakes.inserts[0] as { username: string }).username;
}

describe("autenticación", () => {
  it("sin Authorization → 401, sin insertar", async () => {
    const state = await call({ headers: {} });
    expect(state.status).toBe(401);
    expect(fakes.inserts).toHaveLength(0);
  });

  it("JWT inválido → 401, sin insertar", async () => {
    const state = await call({ headers: { authorization: "Bearer roto" } });
    expect(state.status).toBe(401);
    expect(fakes.inserts).toHaveLength(0);
  });

  it("método distinto de POST → 405 con Allow, sin autenticar ni insertar", async () => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      fakes.clients = [];
      const state = await call({ method });
      expect(state.status).toBe(405);
      expect(state.headers.Allow).toBe("POST");
      expect(fakes.clients).toHaveLength(0);
    }
  });
});

describe("creación", () => {
  it("usuario autenticado + username válido → 201 con perfil público mínimo", async () => {
    const state = await call();
    expect(state.status).toBe(201);
    expect(state.body).toEqual({
      profile: {
        username: "edwin390",
        display_name: null,
        bio: null,
        avatar_path: null,
        created_at: "2026-09-23T00:00:00Z",
        updated_at: "2026-09-23T00:00:00Z",
      },
    });
    expect(fakes.tables).toEqual(["profiles"]);
  });

  it("el user_id insertado viene del JWT, no del body", async () => {
    // El body con user_id se rechaza (400); y con un body válido el user_id es el del JWT.
    const rejected = await call({
      body: { username: "edwin390", user_id: BODY_USER_ID },
    });
    expect(rejected.status).toBe(400);
    expect(fakes.inserts).toHaveLength(0);

    await call();
    expect(fakes.inserts).toEqual([{ user_id: JWT_USER_ID, username: "edwin390" }]);
  });

  it("usa service_role solo para el INSERT; la verificación de JWT usa la anon key", async () => {
    await call();
    const keys = fakes.clients.map((c) => c.key);
    expect(keys).toContain(ANON_KEY);
    expect(keys).toContain(SERVICE_ROLE_KEY);
    expect(fakes.clients.every((c) => c.url === SUPABASE_URL)).toBe(true);
  });

  it("solo selecciona columnas públicas (nunca user_id)", async () => {
    await call();
    expect(fakes.selects[0].split(",").map((c) => c.trim())).toEqual([
      "username",
      "display_name",
      "bio",
      "avatar_path",
      "created_at",
      "updated_at",
    ]);
  });

  it("una fila con campos extra de la base de datos no los filtra a la respuesta", async () => {
    fakes.insertResult = {
      data: {
        user_id: JWT_USER_ID,
        role: "admin",
        email: "a@b.c",
        username: "edwin390",
        display_name: null,
        bio: null,
        avatar_path: null,
        created_at: "x",
        updated_at: "y",
      },
      error: null,
    };
    const state = await call();
    expect(state.status).toBe(201);
    const json = JSON.stringify(state.body);
    expect(json).not.toMatch(/user_id|role|email|admin/);
  });
});

describe("body", () => {
  const rejectedBodies: [string, unknown][] = [
    ["user_id adicional", { username: "edwin390", user_id: BODY_USER_ID }],
    ["role adicional", { username: "edwin390", role: "admin" }],
    ["is_admin adicional", { username: "edwin390", is_admin: true }],
    ["display_name adicional", { username: "edwin390", display_name: "Edwin" }],
    ["bio adicional", { username: "edwin390", bio: "hola" }],
    ["avatar_path adicional", { username: "edwin390", avatar_path: "a/b.png" }],
    ["email adicional", { username: "edwin390", email: "a@b.c" }],
    ["created_at adicional", { username: "edwin390", created_at: "2020-01-01" }],
    ["metadata adicional", { username: "edwin390", metadata: {} }],
    ["sin username", {}],
    ["otro campo en vez de username", { user: "edwin390" }],
    ["username no string (número)", { username: 12345 }],
    ["username null", { username: null }],
    ["username array", { username: ["edwin390"] }],
    ["array", ["edwin390"]],
    ["null", null],
    ["undefined", undefined],
    ["string no JSON", "esto no es json"],
  ];

  it.each(rejectedBodies)("%s → 400, sin insertar", async (_name, body) => {
    const state = await call({ body });
    expect(state.status).toBe(400);
    expect(fakes.inserts).toHaveLength(0);
  });

  it("body como string JSON válido se acepta", async () => {
    const state = await call({ body: JSON.stringify({ username: "edwin390" }) });
    expect(state.status).toBe(201);
  });
});

describe("normalización y formato del username", () => {
  it("hace trim", async () => {
    await call({ body: { username: "  Edwin390  " } });
    expect(insertedUsername()).toBe("edwin390");
  });

  it("convierte a lowercase", async () => {
    const state = await call({ body: { username: "Edwin_390" } });
    expect(state.status).toBe(201);
    expect(insertedUsername()).toBe("edwin_390");
  });

  it("acepta límites 3 y 20; rechaza 2 y 21 con 422", async () => {
    expect((await call({ body: { username: "abc" } })).status).toBe(201);
    expect((await call({ body: { username: "a".repeat(20) } })).status).toBe(201);
    fakes.inserts = [];
    expect((await call({ body: { username: "ab" } })).status).toBe(422);
    expect((await call({ body: { username: "a".repeat(21) } })).status).toBe(422);
    expect(fakes.inserts).toHaveLength(0);
  });

  const invalid: [string, string][] = [
    ["string vacío", ""],
    ["solo espacios", "     "],
    ["espacio interno", "edwin 390"],
    ["guion", "edwin-390"],
    ["punto", "edwin.390"],
    ["arroba", "edwin@390"],
    ["ñ (sin transliterar)", "edwín390"],
    ["ñ literal", "peña"],
    ["homoglyph cirílico", "еdwin390"],
    ["salto de línea interno", "edwin\n390"],
  ];

  it.each(invalid)("%s → 422, sin insertar", async (_name, username) => {
    const state = await call({ body: { username } });
    expect(state.status).toBe(422);
    expect(fakes.inserts).toHaveLength(0);
  });

  it("no translitera Unicode: edwín no equivale a edwin", () => {
    expect(checkUsername("edwín")).toEqual({ ok: false, reason: "invalid" });
    expect(checkUsername("Edwin")).toEqual({ ok: true, username: "edwin" });
  });
});

describe("usernames reservados", () => {
  const initial = [
    "admin",
    "administrator",
    "moderator",
    "mod",
    "staff",
    "support",
    "official",
    "mina",
    "upmina",
    "upminaa",
    "root",
    "system",
  ];

  it("la lista inicial contiene exactamente los nombres exigidos", () => {
    expect([...RESERVED_USERNAMES].sort()).toEqual([...initial].sort());
  });

  it.each(initial)("%s → 422, sin insertar", async (name) => {
    const state = await call({ body: { username: name } });
    expect(state.status).toBe(422);
    expect(fakes.inserts).toHaveLength(0);
  });

  it("la comparación es case-insensitive y tras trim", async () => {
    for (const username of ["ADMIN", "Admin", "  Moderator ", "UpMina", "ROOT"]) {
      const state = await call({ body: { username } });
      expect(state.status).toBe(422);
    }
    expect(fakes.inserts).toHaveLength(0);
  });

  it("un nombre que solo contiene una reservada sí se permite", async () => {
    expect((await call({ body: { username: "admin1" } })).status).toBe(201);
  });

  it("reservado e inválido se distinguen del formato inválido sin filtrar la lista", async () => {
    const reserved = await call({ body: { username: "admin" } });
    expect(reserved.body).toEqual({ error: "Username no disponible" });
  });
});

describe("conflictos y errores de base de datos", () => {
  const PUBLIC_409 = { error: "Username no disponible" };
  const conflictErrors: [string, Record<string, unknown>][] = [
    ["message vacío", { code: "23505", message: "" }],
    ["sin message ni details", { code: "23505" }],
    ["sin nombre de constraint", { code: "23505", message: "duplicate key" }],
    [
      "menciona profiles_pkey",
      {
        code: "23505",
        message: 'duplicate key value violates unique constraint "profiles_pkey"',
      },
    ],
    [
      "menciona profiles_username_key",
      {
        code: "23505",
        message: 'duplicate key value violates unique constraint "profiles_username_key"',
      },
    ],
    [
      "constraint desconocida en message",
      { code: "23505", message: 'violates unique constraint "otra_cosa"' },
    ],
    ["texto arbitrario", { code: "23505", message: "zzz", details: "yyy", hint: "xxx" }],
    ["message no string", { code: "23505", message: 42, details: null }],
  ];

  it.each(conflictErrors)("23505 (%s) → mismo 409 genérico", async (_name, error) => {
    fakes.insertResult = { data: null, error };
    const state = await call();
    expect(state.status).toBe(409);
    expect(state.body).toEqual(PUBLIC_409);
  });

  it("todas las variantes de 23505 producen exactamente la misma respuesta", async () => {
    const responses = new Set<string>();
    for (const [, error] of conflictErrors) {
      fakes.insertResult = { data: null, error };
      const state = await call();
      responses.add(JSON.stringify([state.status, state.body]));
    }
    expect(responses.size).toBe(1);
  });

  it("solo el code decide: mismo message con otro code no es conflicto", async () => {
    fakes.insertResult = {
      data: null,
      error: {
        code: "XX000",
        message: 'duplicate key value violates unique constraint "profiles_pkey"',
      },
    };
    expect((await call()).status).toBe(500);
  });

  it("no hay pre-check SELECT: la única operación es un INSERT", async () => {
    // El from() falso solo expone insert(); un select() previo lanzaría y daría 500.
    const state = await call();
    expect(state.status).toBe(201);
    expect(fakes.ops).toEqual(["insert"]);
    fakes.ops = [];
    fakes.insertResult = { data: null, error: { code: "23505", message: "" } };
    expect((await call()).status).toBe(409);
    expect(fakes.ops).toEqual(["insert"]);
  });

  it("el 409 no expone message/details/hint de Postgres ni al otro usuario", async () => {
    fakes.insertResult = {
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "profiles_username_key"',
        details: `Key (username)=(edwin390) already exists. ${BODY_USER_ID}`,
        hint: "pista-interna",
      },
    };
    const state = await call();
    const json = JSON.stringify(state.body);
    expect(json).not.toContain(BODY_USER_ID);
    expect(json).not.toMatch(/constraint|profiles_|duplicate|Key|pista|edwin390|23505/);
  });

  it("FK a auth.users inexistente (usuario borrado) → 401", async () => {
    fakes.insertResult = {
      data: null,
      error: {
        code: "23503",
        message: 'violates foreign key constraint "profiles_user_id_fkey"',
      },
    };
    expect((await call()).status).toBe(401);
  });

  it("error inesperado de DB → 500 genérico, sin detalles SQL", async () => {
    fakes.insertResult = {
      data: null,
      error: {
        code: "XX000",
        message: 'relation "public.profiles" secreto-sql',
        details: "detalle-interno",
        hint: "pista-interna",
      },
    };
    const state = await call();
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(JSON.stringify(state.body)).not.toMatch(/secreto-sql|detalle|pista|XX000/);
  });

  it("check violation inesperada (23514) → 500 genérico", async () => {
    fakes.insertResult = {
      data: null,
      error: {
        code: "23514",
        message: 'violates check constraint "profiles_username_format"',
      },
    };
    expect((await call()).status).toBe(500);
  });

  it("excepción lanzada por el cliente → 500 genérico", async () => {
    fakes.insertThrows = new Error("ECONNRESET secreto-red");
    const state = await call();
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain("secreto-red");
  });

  it("respuesta sin error ni data → 500 genérico", async () => {
    fakes.insertResult = { data: null, error: null };
    expect((await call()).status).toBe(500);
  });

  it("sin variables de Supabase de servicio → 500 genérico, sin insertar", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const state = await call();
    expect(state.status).toBe(500);
    expect(fakes.inserts).toHaveLength(0);
  });
});

describe("no hay escalación de privilegios ni acoplamiento con admin", () => {
  it("no exige MFA: una sesión aal1 y una aal2 crean perfil igual", async () => {
    fakes.claims = { sub: JWT_USER_ID, aal: "aal1" };
    expect((await call()).status).toBe(201);
    fakes.claims = { sub: JWT_USER_ID, aal: "aal2" };
    expect((await call({ body: { username: "otro_user" } })).status).toBe(201);
  });

  it("solo toca la tabla profiles: nunca admin_roles, invitaciones ni RPC", async () => {
    await call();
    await call({ body: { username: "admin" } });
    await call({ body: { username: "edwin390", role: "admin" } });
    expect(fakes.tables.every((t) => t === "profiles")).toBe(true);
    expect(fakes.rpcCalls).toHaveLength(0);
  });

  it("nunca llama a /api/admin/me ni a ninguna otra URL (sin fetch)", async () => {
    await call();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("el INSERT contiene únicamente user_id y username (sin role ni campos privilegiados)", async () => {
    await call();
    expect(Object.keys(fakes.inserts[0] as object).sort()).toEqual([
      "user_id",
      "username",
    ]);
  });

  it("la respuesta no expone token, role, email ni service_role", async () => {
    const state = await call();
    const json = JSON.stringify(state.body);
    expect(json).not.toContain(VALID_TOKEN);
    expect(json).not.toContain(SERVICE_ROLE_KEY);
    expect(json).not.toContain(JWT_USER_ID);
    expect(json).not.toMatch(/role|email|token|service/i);
  });

  it("los errores tampoco exponen token ni service_role", async () => {
    fakes.insertResult = {
      data: null,
      error: { code: "XX000", message: SERVICE_ROLE_KEY },
    };
    const state = await call();
    const json = JSON.stringify(state.body);
    expect(json).not.toContain(SERVICE_ROLE_KEY);
    expect(json).not.toContain(VALID_TOKEN);
  });
});
