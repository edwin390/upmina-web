import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleProfile, handleProfileUpdate } from "./profile-handlers";
import { BIO_MAX, DISPLAY_NAME_MAX, checkBio, checkDisplayName } from "./profile-fields";

// Contrato de PATCH /api/profile (Bloque 7D.2). Se usa el requireAuthenticated REAL; el
// createClient falso implementa auth.getClaims y from().update().eq().select().maybeSingle().

const JWT_USER_ID = "11111111-1111-4111-8111-111111111111";
const BODY_USER_ID = "99999999-9999-4999-8999-999999999999";
const VALID_TOKEN = "jwt-sintetico-valido";

const fakes = vi.hoisted(() => ({
  tables: [] as string[],
  updates: [] as Record<string, unknown>[],
  eqs: [] as [string, unknown][],
  selects: [] as string[],
  ops: [] as string[],
  clients: 0,
  claims: {} as Record<string, unknown>,
  result: undefined as { data: unknown; error: unknown } | undefined,
  throws: undefined as unknown,
  gate: undefined as Promise<void> | undefined,
  // Estado leído por el pre-check de cambio de username (SELECT previo al UPDATE, ver
  // handleProfileUpdate) — independiente de `result`, que sigue siendo la respuesta del UPDATE
  // final. `undefined` = usar el valor por defecto (username "edwin390", sin cooldown activo).
  currentUsernameRow: undefined as
    { username: string; username_changed_at: string | null } | null | undefined,
  currentUsernameError: undefined as unknown,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    fakes.clients += 1;
    return {
      auth: {
        getClaims: async (token: string) =>
          token === VALID_TOKEN
            ? { data: { claims: fakes.claims }, error: null }
            : { data: null, error: { message: "jwt invalido" } },
      },
      from: (table: string) => {
        fakes.tables.push(table);
        return {
          insert: () => {
            fakes.ops.push("insert");
            throw new Error("insert inesperado");
          },
          upsert: () => {
            fakes.ops.push("upsert");
            throw new Error("upsert inesperado");
          },
          // SELECT de nivel superior (no encadenado tras update()): lo usa el pre-check de
          // cambio de username (lee username + username_changed_at) y el re-lectura no-op
          // cuando el único cambio pedido era el mismo username canónico (ver
          // handleProfileUpdate). Nunca se invoca en un PATCH de solo display_name/bio.
          select: (columns: string) => {
            fakes.ops.push("select");
            fakes.selects.push(columns);
            const chain = {
              eq: (_col: string, _val: unknown) => chain,
              maybeSingle: async () => {
                if (fakes.currentUsernameError !== undefined) {
                  return { data: null, error: fakes.currentUsernameError };
                }
                const row =
                  fakes.currentUsernameRow === undefined
                    ? { username: "edwin390", username_changed_at: null }
                    : fakes.currentUsernameRow;
                if (row === null) return { data: null, error: null };
                if (columns.includes("username_changed_at")) {
                  return {
                    data: {
                      username: row.username,
                      username_changed_at: row.username_changed_at,
                    },
                    error: null,
                  };
                }
                return {
                  data: {
                    username: row.username,
                    display_name: null,
                    bio: null,
                    avatar_path: null,
                    created_at: "2026-09-23T00:00:00Z",
                    updated_at: "2026-09-24T00:00:00Z",
                  },
                  error: null,
                };
              },
            };
            return chain;
          },
          update: (set: Record<string, unknown>) => {
            fakes.ops.push("update");
            fakes.updates.push(set);
            const ctx: { eq?: [string, unknown] } = {};
            const chain = {
              eq: (col: string, val: unknown) => {
                ctx.eq = [col, val];
                fakes.eqs.push([col, val]);
                return chain;
              },
              select: (columns: string) => {
                fakes.selects.push(columns);
                return chain;
              },
              maybeSingle: async () => {
                if (fakes.gate) await fakes.gate;
                if (fakes.throws !== undefined) throw fakes.throws;
                if (fakes.result) return fakes.result;
                return {
                  data: {
                    username: "edwin390",
                    display_name: null,
                    bio: null,
                    avatar_path: null,
                    created_at: "2026-09-23T00:00:00Z",
                    updated_at: "2026-09-24T00:00:00Z",
                    ...set,
                  },
                  error: null,
                };
              },
            };
            return chain;
          },
        };
      },
    };
  },
}));

beforeEach(() => {
  fakes.tables = [];
  fakes.updates = [];
  fakes.eqs = [];
  fakes.selects = [];
  fakes.ops = [];
  fakes.clients = 0;
  fakes.claims = { sub: JWT_USER_ID, aal: "aal1" };
  fakes.result = undefined;
  fakes.throws = undefined;
  fakes.gate = undefined;
  fakes.currentUsernameRow = undefined;
  fakes.currentUsernameError = undefined;
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-de-prueba");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key-de-prueba");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function req(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: "PATCH",
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
    query: {},
    body: { display_name: "Edwin" },
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

async function call(body: unknown, overrides: Partial<VercelRequest> = {}) {
  const { res, state } = mockRes();
  await handleProfile(req({ body, ...overrides }), res);
  return state;
}

const emoji = (n: number) => "😀".repeat(n);

describe("auth", () => {
  it("sin Bearer → 401 sin UPDATE", async () => {
    const state = await call({ bio: "x" }, { headers: {} });
    expect(state.status).toBe(401);
    expect(fakes.updates).toHaveLength(0);
  });

  it("JWT inválido → 401 sin UPDATE", async () => {
    const state = await call({ bio: "x" }, { headers: { authorization: "Bearer roto" } });
    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: "No autenticado" });
    expect(fakes.updates).toHaveLength(0);
  });

  it("AAL1 es suficiente y el UPDATE se acota por el user_id del JWT", async () => {
    const state = await call({ bio: "hola" });
    expect(state.status).toBe(200);
    expect(fakes.eqs).toEqual([["user_id", JWT_USER_ID]]);
  });

  it("un user_id en el body no cambia el destino: 400 y cero UPDATE", async () => {
    const state = await call({ bio: "hola", user_id: BODY_USER_ID });
    expect(state.status).toBe(400);
    expect(fakes.updates).toHaveLength(0);
    expect(fakes.eqs).toHaveLength(0);
  });
});

describe("router", () => {
  it("POST sigue llegando al onboarding (no al update)", async () => {
    const { res, state } = mockRes();
    await handleProfile(
      req({ method: "POST", body: { username: "edwin390" } } as Partial<VercelRequest>),
      res,
    );
    // El mock no implementa insert: el handler de creación responde 500 genérico, lo que
    // prueba que se despachó a create y que PATCH no se ejecutó.
    expect(fakes.ops).toEqual(["insert"]);
    expect(fakes.updates).toHaveLength(0);
    expect(state.status).toBe(500);
  });

  it("PATCH funciona", async () => {
    const state = await call({ display_name: "Edwin" });
    expect(state.status).toBe(200);
    expect(fakes.ops).toEqual(["update"]);
  });

  it("GET/PUT/DELETE/OPTIONS → 405 con Allow: POST, PATCH, sin autenticar", async () => {
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
      fakes.clients = 0;
      const state = await call({ bio: "x" }, { method });
      expect(state.status).toBe(405);
      expect(state.headers.Allow).toBe("POST, PATCH");
      expect(state.body).toEqual({ error: "Método no permitido" });
      expect(fakes.clients).toBe(0);
    }
  });

  it("handleProfileUpdate directo rechaza otros métodos", async () => {
    const { res, state } = mockRes();
    await handleProfileUpdate(req({ method: "POST" }), res);
    expect(state.status).toBe(405);
    expect(fakes.clients).toBe(0);
  });
});

describe("body", () => {
  const cases: [string, unknown][] = [
    ["ausente", undefined],
    ["JSON inválido", "{no es json"],
    ["null", null],
    ["array", [{ bio: "x" }]],
    ["string", "texto"],
    ["número", 42],
    ["boolean", true],
    ["{}", {}],
  ];
  it.each(cases)("%s → 400 sin UPDATE", async (_name, body) => {
    const state = await call(body);
    expect(state.status).toBe(400);
    expect(state.body).toEqual({ error: "Solicitud inválida" });
    expect(fakes.updates).toHaveLength(0);
  });

  it("body como string JSON válido funciona", async () => {
    const state = await call(JSON.stringify({ bio: "hola" }));
    expect(state.status).toBe(200);
    expect(fakes.updates).toEqual([{ bio: "hola" }]);
  });

  it.each([
    ["número", 5],
    ["boolean", true],
    ["objeto", { a: 1 }],
    ["array", ["x"]],
  ])("display_name y bio de tipo %s → 400", async (_n, value) => {
    expect((await call({ display_name: value })).status).toBe(400);
    expect((await call({ bio: value })).status).toBe(400);
    expect(fakes.updates).toHaveLength(0);
  });
});

describe("mass assignment", () => {
  const extras: [string, unknown][] = [
    ["user_id", BODY_USER_ID],
    ["avatar_path", "avatars/x.png"],
    ["role", "admin"],
    ["email", "a@b.c"],
    ["created_at", "2020-01-01T00:00:00Z"],
    ["updated_at", "2020-01-01T00:00:00Z"],
    ["is_admin", true],
    ["metadata", { a: 1 }],
    ["constructor", { prototype: {} }],
    ["desconocida", "x"],
  ];

  it.each(extras)("clave %s sola → 400 y cero UPDATE", async (key, value) => {
    const state = await call({ [key]: value });
    expect(state.status).toBe(400);
    expect(fakes.updates).toHaveLength(0);
  });

  it.each(extras)("campo válido + %s → 400 y cero UPDATE", async (key, value) => {
    const state = await call({ display_name: "Ok", [key]: value });
    expect(state.status).toBe(400);
    expect(fakes.updates).toHaveLength(0);
  });

  it("__proto__ como clave propia (JSON.parse) → 400 y cero UPDATE", async () => {
    for (const raw of ['{"__proto__":{"role":"admin"}}', '{"bio":"x","__proto__":1}']) {
      const state = await call(raw);
      expect(state.status).toBe(400);
    }
    expect(fakes.updates).toHaveLength(0);
  });
});

describe("PATCH parcial y UPDATE", () => {
  it("solo display_name → el UPDATE contiene solo display_name", async () => {
    await call({ display_name: "Ana" });
    expect(fakes.updates).toEqual([{ display_name: "Ana" }]);
  });

  it("solo bio → el UPDATE contiene solo bio", async () => {
    await call({ bio: "hola" });
    expect(fakes.updates).toEqual([{ bio: "hola" }]);
  });

  it("ambos → exactamente ambos", async () => {
    await call({ display_name: "Ana", bio: "hola" });
    expect(fakes.updates).toEqual([{ display_name: "Ana", bio: "hola" }]);
  });

  it("el UPDATE nunca incluye user_id, username, avatar_path ni updated_at", async () => {
    await call({ display_name: "Ana", bio: "hola" });
    for (const forbidden of ["user_id", "username", "avatar_path", "updated_at"]) {
      expect(Object.keys(fakes.updates[0])).not.toContain(forbidden);
    }
  });

  it("opera solo sobre profiles, con las columnas públicas, sin insert/upsert", async () => {
    await call({ bio: "x" });
    expect(fakes.tables).toEqual(["profiles"]);
    expect(fakes.selects).toEqual([
      "username, display_name, bio, avatar_path, created_at, updated_at",
    ]);
    expect(fakes.ops).toEqual(["update"]);
  });
});

describe("null, vacío y whitespace", () => {
  const empties: [string, string | null][] = [
    ["null", null],
    ['""', ""],
    ["espacios ASCII", "   "],
    ["NBSP", "\u00a0\u00a0"],
    ["saltos y tabs", " \n\t \r\n "],
  ];
  it.each(empties)("display_name %s → NULL", async (_n, value) => {
    const state = await call({ display_name: value });
    expect(state.status).toBe(200);
    expect(fakes.updates).toEqual([{ display_name: null }]);
  });
  it.each(empties)("bio %s → NULL", async (_n, value) => {
    const state = await call({ bio: value });
    expect(state.status).toBe(200);
    expect(fakes.updates).toEqual([{ bio: null }]);
  });
});

describe("normalización", () => {
  it("trim exterior y espacios internos intactos", async () => {
    await call({ display_name: "  Ana   María \u00a0", bio: "\n  hola   mundo  \n" });
    expect(fakes.updates).toEqual([{ display_name: "Ana   María", bio: "hola   mundo" }]);
  });

  it("NFC aplicado: e + acento combinante → é precompuesto", async () => {
    const nfd = "José";
    await call({ display_name: nfd, bio: nfd });
    const set = fakes.updates[0] as { display_name: string; bio: string };
    expect(set.display_name).toBe("José");
    expect(set.bio).toBe("José");
    expect(set.display_name.length).toBe(4);
  });

  it("bio: CRLF y CR → LF; LF y múltiples líneas se conservan", async () => {
    await call({ bio: "a\r\nb\rc\nd\n\ne" });
    expect(fakes.updates).toEqual([{ bio: "a\nb\nc\nd\n\ne" }]);
  });
});

describe("code points", () => {
  it("display_name: 40 OK, 41 → 422", async () => {
    expect((await call({ display_name: "a".repeat(DISPLAY_NAME_MAX) })).status).toBe(200);
    const bad = await call({ display_name: "a".repeat(DISPLAY_NAME_MAX + 1) });
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({ error: "Display name inválido" });
  });

  it("display_name con emoji: 40 emoji (80 unidades UTF-16) OK, 41 → 422", async () => {
    expect(emoji(40).length).toBe(80);
    expect((await call({ display_name: emoji(40) })).status).toBe(200);
    expect((await call({ display_name: emoji(41) })).status).toBe(422);
  });

  it("bio: 280 OK, 281 → 422", async () => {
    expect((await call({ bio: "a".repeat(BIO_MAX) })).status).toBe(200);
    const bad = await call({ bio: "a".repeat(BIO_MAX + 1) });
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({ error: "Bio inválida" });
  });

  it("bio con emoji: 280 emoji OK, 281 → 422", async () => {
    expect((await call({ bio: emoji(280) })).status).toBe(200);
    expect((await call({ bio: emoji(281) })).status).toBe(422);
  });

  it("el límite se cuenta DESPUÉS de NFC (40 × e+combinante caben)", async () => {
    expect((await call({ display_name: "é".repeat(40) })).status).toBe(200);
  });
});

describe("Unicode", () => {
  it("acepta acentos, emoji, CJK y espacios internos", async () => {
    const state = await call({
      display_name: "Ñandú 日本語 😀",
      bio: "canción — 你好 🎉",
    });
    expect(state.status).toBe(200);
    expect(fakes.updates).toEqual([
      { display_name: "Ñandú 日本語 😀", bio: "canción — 你好 🎉" },
    ]);
  });

  it("surrogate suelto (alto o bajo) → 422 en ambos campos", async () => {
    for (const bad of ["a\ud800b", "a\udc00b", "ab\ud83d"]) {
      expect((await call({ display_name: bad })).status).toBe(422);
      expect((await call({ bio: bad })).status).toBe(422);
    }
    expect(fakes.updates).toHaveLength(0);
  });

  const invisibles = [
    "\u202a",
    "\u202e",
    "\u2066",
    "\u2069",
    "\u200b",
    "\u200f",
    "\ufeff",
  ];
  it.each(invisibles)("bidi/invisible U+%s → 422 en ambos campos", async (ch) => {
    expect((await call({ display_name: `a${ch}b` })).status).toBe(422);
    expect((await call({ bio: `a${ch}b` })).status).toBe(422);
    expect(fakes.updates).toHaveLength(0);
  });

  it("controles C0, DEL y C1 interiores → 422 en ambos campos", async () => {
    for (const ch of ["\u0000", "\u0001", "\u001f", "\u007f", "\u0085", "\u009f"]) {
      expect((await call({ display_name: `a${ch}b` })).status).toBe(422);
      expect((await call({ bio: `a${ch}b` })).status).toBe(422);
    }
    expect(fakes.updates).toHaveLength(0);
  });
});

describe("display_name vs bio: saltos y tabs", () => {
  it("display_name: newline y tab interiores → 422", async () => {
    expect((await call({ display_name: "a\nb" })).status).toBe(422);
    expect((await call({ display_name: "a\rb" })).status).toBe(422);
    expect((await call({ display_name: "a\tb" })).status).toBe(422);
  });

  it("bio: newline permitido, tab interior → 422", async () => {
    expect((await call({ bio: "a\nb" })).status).toBe(200);
    expect((await call({ bio: "a\tb" })).status).toBe(422);
  });
});

describe("HTML", () => {
  it("se almacena literalmente, sin sanitizar ni rechazar", async () => {
    const html = "<script>alert(1)</script>";
    const state = await call({ display_name: "<b>x</b>", bio: html });
    expect(state.status).toBe(200);
    expect(fakes.updates).toEqual([{ display_name: "<b>x</b>", bio: html }]);
  });
});

describe("profile inexistente", () => {
  it("UPDATE sin fila → 404 y nunca INSERT/UPSERT", async () => {
    fakes.result = { data: null, error: null };
    const state = await call({ bio: "x" });
    expect(state.status).toBe(404);
    expect(state.body).toEqual({ error: "Perfil no encontrado" });
    expect(fakes.ops).toEqual(["update"]);
  });
});

describe("errores de DB", () => {
  it("23514 → 422 Datos inválidos, sin detalles", async () => {
    fakes.result = {
      data: null,
      error: {
        code: "23514",
        message: "violates profiles_bio_length",
        details: "secreto",
      },
    };
    const state = await call({ bio: "x" });
    expect(state.status).toBe(422);
    expect(state.body).toEqual({ error: "Datos inválidos" });
    expect(JSON.stringify(state.body)).not.toContain("profiles_bio_length");
  });

  it("message con '23514' pero code distinto → 500 (solo importa error.code)", async () => {
    fakes.result = {
      data: null,
      error: { code: "XX000", message: "23514 check violation" },
    };
    expect((await call({ bio: "x" })).status).toBe(500);
  });

  it.each(["23505", "23503", "42501", "PGRST116", undefined])(
    "código %s → 500 genérico",
    async (code) => {
      fakes.result = {
        data: null,
        error: { code, message: "detalle interno", hint: "h" },
      };
      const state = await call({ bio: "x" });
      expect(state.status).toBe(500);
      expect(state.body).toEqual({ error: "Error interno" });
    },
  );

  it("throw → 500 genérico", async () => {
    fakes.throws = new Error("conexión rota con secreto");
    const state = await call({ bio: "x" });
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
  });

  it("sin variables de entorno del servidor → 500 sin UPDATE", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const state = await call({ bio: "x" });
    expect(state.status).toBe(500);
    expect(fakes.updates).toHaveLength(0);
  });
});

describe("respuesta", () => {
  it("200 tiene exactamente las seis claves públicas aunque la DB devuelva más", async () => {
    fakes.result = {
      data: {
        user_id: JWT_USER_ID,
        role: "admin",
        email: "a@b.c",
        metadata: { x: 1 },
        username: "edwin390",
        display_name: "Ana",
        bio: null,
        avatar_path: null,
        created_at: "2026-09-23T00:00:00Z",
        updated_at: "2026-09-24T00:00:00Z",
      },
      error: null,
    };
    const state = await call({ display_name: "Ana" });
    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      profile: {
        username: "edwin390",
        display_name: "Ana",
        bio: null,
        avatar_path: null,
        created_at: "2026-09-23T00:00:00Z",
        updated_at: "2026-09-24T00:00:00Z",
      },
    });
    expect(Object.keys((state.body as { profile: object }).profile).sort()).toEqual([
      "avatar_path",
      "bio",
      "created_at",
      "display_name",
      "updated_at",
      "username",
    ]);
    expect(JSON.stringify(state.body)).not.toContain(JWT_USER_ID);
  });
});

describe("no escalación", () => {
  it("solo toca profiles: ni admin_roles, ni rpc, ni fetch de /api/admin/me", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    fakes.claims = { sub: JWT_USER_ID, aal: "aal1", role: "authenticated" };
    const state = await call({ display_name: "Ana", bio: "x" });
    vi.unstubAllGlobals();
    expect(state.status).toBe(200);
    expect(fakes.tables).toEqual(["profiles"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(state.body)).not.toMatch(/role|admin/);
  });
});

describe("9J-1B — cambio de username: formato/reservados vía el endpoint", () => {
  it("username inválido → 422 code invalid_username, sin UPDATE", async () => {
    const state = await call({ username: "ab" });
    expect(state.status).toBe(422);
    expect(state.body).toEqual({ error: "Username inválido", code: "invalid_username" });
    expect(fakes.updates).toHaveLength(0);
  });

  it("username reservado → 422 code username_reserved, sin UPDATE", async () => {
    const state = await call({ username: "community" });
    expect(state.status).toBe(422);
    expect(state.body).toEqual({
      error: "Username no disponible",
      code: "username_reserved",
    });
    expect(fakes.updates).toHaveLength(0);
  });

  it("username se canonicaliza (trim + lowercase) antes de compararlo/guardarlo", async () => {
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: null };
    await call({ username: "  NuevoUser  " });
    expect(fakes.updates).toEqual([expect.objectContaining({ username: "nuevouser" })]);
  });
});

describe("9J-1B — creación NO arranca el cooldown; primer cambio siempre permitido", () => {
  it("username_changed_at NULL (perfil recién creado, nunca cambiado): el cambio se permite sin comprobar antigüedad", async () => {
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: null };
    const state = await call({ username: "nuevonombre" });
    expect(state.status).toBe(200);
    expect(fakes.updates).toEqual([expect.objectContaining({ username: "nuevonombre" })]);
  });

  it("el cambio exitoso fija username_changed_at a la hora del servidor (ISO), no la que envíe el cliente", async () => {
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: null };
    const before = Date.now();
    await call({ username: "nuevonombre" });
    const set = fakes.updates[0] as { username_changed_at: string };
    const ts = new Date(set.username_changed_at).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });
});

describe("9J-1B — cooldown de 30 días entre cambios", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("cambio 29 días después del último cambio → 409 cooldown_active con nextChangeAllowedAt", async () => {
    const changedAt = new Date(Date.now() - 29 * DAY_MS).toISOString();
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: changedAt };
    const state = await call({ username: "otronombre" });
    expect(state.status).toBe(409);
    const body = state.body as {
      error: string;
      code: string;
      nextChangeAllowedAt: string;
    };
    expect(body.code).toBe("cooldown_active");
    // nextChangeAllowedAt debe ser ~1 día en el futuro (30 - 29): ni el username actual ni
    // ningún dato sensible viaja en el error, solo esta fecha.
    const remainingMs = new Date(body.nextChangeAllowedAt).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(0.5 * DAY_MS);
    expect(remainingMs).toBeLessThan(1.5 * DAY_MS);
    expect(fakes.updates).toHaveLength(0);
  });

  it("cambio exactamente 30 días después (o más) del último cambio → permitido", async () => {
    const changedAt = new Date(Date.now() - 30 * DAY_MS - 1000).toISOString();
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: changedAt };
    const state = await call({ username: "otronombre" });
    expect(state.status).toBe(200);
    expect(fakes.updates).toEqual([expect.objectContaining({ username: "otronombre" })]);
  });

  it("cambio 1 día después del último cambio → sigue bloqueado", async () => {
    const changedAt = new Date(Date.now() - 1 * DAY_MS).toISOString();
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: changedAt };
    const state = await call({ username: "otronombre" });
    expect(state.status).toBe(409);
    expect(fakes.updates).toHaveLength(0);
  });
});

describe("9J-1B — mismo username canónico: no-op explícito", () => {
  it("enviar el mismo username (ya canonicalizado) no toca username_changed_at ni consume el cooldown, incluso con cooldown activo", async () => {
    const changedAt = new Date(Date.now() - 1000).toISOString(); // cooldown recién empezado
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: changedAt };
    const state = await call({ username: "edwin390" });
    expect(state.status).toBe(200);
    expect(fakes.updates).toHaveLength(0);
  });

  it("enviar el mismo username con distinto casing/espacios también es no-op (se canonicaliza antes de comparar)", async () => {
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: null };
    const state = await call({ username: "  Edwin390  " });
    expect(state.status).toBe(200);
    expect(fakes.updates).toHaveLength(0);
  });

  it("mismo username + display_name distinto: solo se actualiza display_name, username_changed_at no se toca", async () => {
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: null };
    const state = await call({ username: "edwin390", display_name: "Nuevo nombre" });
    expect(state.status).toBe(200);
    expect(fakes.updates).toEqual([{ display_name: "Nuevo nombre" }]);
  });
});

describe("9J-1B — display_name/bio nunca afectan el cooldown de username", () => {
  it("un PATCH de solo display_name/bio nunca incluye username ni username_changed_at en el UPDATE", async () => {
    await call({ display_name: "Ana", bio: "hola" });
    expect(fakes.updates).toEqual([{ display_name: "Ana", bio: "hola" }]);
    expect(fakes.ops).toEqual(["update"]);
  });
});

describe("9J-1B — unicidad: username ya en uso", () => {
  it("23505 en el UPDATE de username → 409 code username_taken", async () => {
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: null };
    fakes.result = {
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "profiles_username_key"',
      },
    };
    const state = await call({ username: "yaexiste" });
    expect(state.status).toBe(409);
    expect(state.body).toEqual({
      error: "Username no disponible",
      code: "username_taken",
    });
  });

  it("23505 en un UPDATE que NO incluye username sigue siendo 500 genérico (comportamiento previo intacto)", async () => {
    fakes.result = { data: null, error: { code: "23505", message: "x" } };
    const state = await call({ bio: "x" });
    expect(state.status).toBe(500);
  });
});

describe("9J-1B — ownership: solo el propio perfil", () => {
  it("el pre-check y el UPDATE de username están acotados por el user_id del JWT, nunca por el body", async () => {
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: null };
    await call({ username: "nuevonombre", user_id: BODY_USER_ID });
    // user_id extra en el body → 400 (mass assignment), cero UPDATE: ni siquiera llega a leer.
    expect(fakes.updates).toHaveLength(0);
  });

  it("perfil inexistente para este user_id (pre-check de username) → 404, nunca crea ni asume otro perfil", async () => {
    fakes.currentUsernameRow = null;
    const state = await call({ username: "nuevonombre" });
    expect(state.status).toBe(404);
    expect(fakes.updates).toHaveLength(0);
  });
});

describe("9J-1B — la respuesta pública nunca expone datos sensibles", () => {
  it("respuesta de un cambio de username exitoso: exactamente las seis claves públicas, sin user_id/role/email", async () => {
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: null };
    const state = await call({ username: "nuevonombre" });
    expect(state.status).toBe(200);
    const profile = (state.body as { profile: Record<string, unknown> }).profile;
    expect(Object.keys(profile).sort()).toEqual([
      "avatar_path",
      "bio",
      "created_at",
      "display_name",
      "updated_at",
      "username",
    ]);
    expect(JSON.stringify(state.body)).not.toMatch(/user_id|role|email|JWT|token/i);
  });

  it("el error de cooldown activo tampoco expone el username actual ni el user_id", async () => {
    const changedAt = new Date(Date.now() - 1000).toISOString();
    fakes.currentUsernameRow = { username: "edwin390", username_changed_at: changedAt };
    const state = await call({ username: "otronombre" });
    const json = JSON.stringify(state.body);
    expect(json).not.toContain(JWT_USER_ID);
    expect(json).not.toContain("edwin390");
  });
});

describe("concurrencia unitaria", () => {
  it("PATCH bio y PATCH display_name simultáneos construyen UPDATE independientes", async () => {
    let release!: () => void;
    fakes.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = call({ bio: "solo bio" });
    const b = call({ display_name: "Solo nombre" });
    await vi.waitFor(() => expect(fakes.updates).toHaveLength(2));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(fakes.updates).toContainEqual({ bio: "solo bio" });
    expect(fakes.updates).toContainEqual({ display_name: "Solo nombre" });
    expect(fakes.updates.every((u) => Object.keys(u).length === 1)).toBe(true);
    expect(
      (ra.body as { profile: { display_name: unknown } }).profile.display_name,
    ).toBeNull();
    expect((rb.body as { profile: { bio: unknown } }).profile.bio).toBeNull();
  });
});

describe("profile-fields (unidad)", () => {
  it("checkDisplayName / checkBio: null y vacío → NULL", () => {
    expect(checkDisplayName(null)).toEqual({ ok: true, value: null });
    expect(checkBio("  ")).toEqual({ ok: true, value: null });
  });
});
