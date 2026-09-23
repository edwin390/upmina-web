import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/admin/[action]";
import { verifyInstagramState } from "./instagram-oauth-shared";
import { verifyTikTokState } from "./tiktok-shared";

// POST /api/admin/social-connect (Bloque 8C.2). Se ejecutan el router, el handler, requireAdmin
// (autorización REAL: getClaims + admin_roles + aal2) y el módulo REAL social-oauth-flow; solo
// el cliente de Supabase es un falso en memoria. Los constructores de URL de los proveedores
// son reales salvo cuando un test los sustituye a propósito para forzar una URL inválida.

const IG_APP_ID = "1234567890";
const IG_APP_SECRET = "secreto-de-app-instagram-ficticio";
const TT_KEY = "clave-tiktok-ficticia";
const TT_SECRET = "secreto-de-app-tiktok-ficticio";
const SERVICE_ROLE_KEY = "srk-service-role-ficticia";
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";

const TOKENS: Record<string, { sub: string; aal: string }> = {
  "jwt-admin-aal2": { sub: ADMIN_ID, aal: "aal2" },
  "jwt-admin-aal1": { sub: ADMIN_ID, aal: "aal1" },
  "jwt-moderator-aal2": { sub: MOD_ID, aal: "aal2" },
  "jwt-user-aal2": { sub: USER_ID, aal: "aal2" },
};
const ROLES: Record<string, string> = { [ADMIN_ID]: "admin", [MOD_ID]: "moderator" };

const fake = vi.hoisted(() => ({
  flows: new Map<string, Record<string, unknown>>(),
  upserts: [] as Record<string, unknown>[],
  claimsCalls: 0,
  /** Error de Supabase al leer admin_roles (infraestructura de auth). */
  rolesError: undefined as unknown,
  /** Error de Supabase al escribir social_oauth_flows. */
  flowError: undefined as unknown,
  flowThrow: undefined as unknown,
  /** Sustituciones deliberadas de los constructores de URL. */
  igUrl: undefined as undefined | ((id: string, state: string) => string),
  ttUrl: undefined as undefined | ((id: string, state: string) => string),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      async getClaims(jwt: string) {
        fake.claimsCalls++;
        const claims = TOKENS[jwt];
        return claims
          ? { data: { claims }, error: null }
          : { data: null, error: { message: "jwt inválido" } };
      },
    },
    from: (table: string) => {
      if (table === "admin_roles") {
        return {
          select: () => {
            let userId = "";
            const builder = {
              eq(_column: string, value: string) {
                userId = value;
                return builder;
              },
              async maybeSingle() {
                if (fake.rolesError) return { data: null, error: fake.rolesError };
                const role = ROLES[userId];
                return { data: role ? { role } : null, error: null };
              },
            };
            return builder;
          },
        };
      }
      if (table === "social_oauth_flows") {
        return {
          async upsert(row: Record<string, unknown>) {
            fake.upserts.push(row);
            if (fake.flowThrow) throw fake.flowThrow;
            if (fake.flowError) return { error: fake.flowError };
            fake.flows.set(String(row.provider), { consumed_at: null, ...row });
            return { error: null };
          },
        };
      }
      throw new Error(`tabla inesperada: ${table}`);
    },
  }),
}));

vi.mock("./instagram-oauth-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./instagram-oauth-shared")>();
  return {
    ...actual,
    buildInstagramAuthorizeUrl: (id: string, state: string) =>
      fake.igUrl ? fake.igUrl(id, state) : actual.buildInstagramAuthorizeUrl(id, state),
  };
});
vi.mock("./tiktok-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tiktok-shared")>();
  return {
    ...actual,
    buildTikTokAuthorizeUrl: (id: string, state: string) =>
      fake.ttUrl ? fake.ttUrl(id, state) : actual.buildTikTokAuthorizeUrl(id, state),
  };
});

interface Captured {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

function mockRes() {
  const state: Captured = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(
  opts: {
    method?: string;
    token?: string | null;
    authorization?: string;
    body?: unknown;
    query?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.authorization) headers.authorization = opts.authorization;
  else if (opts.token !== null)
    headers.authorization = `Bearer ${opts.token ?? "jwt-admin-aal2"}`;
  return {
    method: opts.method ?? "POST",
    headers,
    body: "body" in opts ? opts.body : { provider: "instagram" },
    query: { action: "social-connect", ...(opts.query ?? {}) },
  } as unknown as VercelRequest;
}

async function call(request: VercelRequest) {
  const { res, state } = mockRes();
  await router(request, res);
  return state;
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Nonce en claro tal como lo lleva la cookie Set-Cookie. */
function cookieNonce(setCookie: string): string {
  return setCookie.split(";")[0].split("=").slice(1).join("=");
}

function assertNothingCreated(state: Captured) {
  expect(fake.upserts).toHaveLength(0);
  expect(fake.flows.size).toBe(0);
  expect(state.headers["Set-Cookie"]).toBeUndefined();
  expect(JSON.stringify(state.body)).not.toContain("authorization_url");
}

beforeEach(() => {
  fake.flows.clear();
  fake.upserts = [];
  fake.claimsCalls = 0;
  fake.rolesError = undefined;
  fake.flowError = undefined;
  fake.flowThrow = undefined;
  fake.igUrl = undefined;
  fake.ttUrl = undefined;
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-ficticia");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  vi.stubEnv("INSTAGRAM_APP_ID", IG_APP_ID);
  vi.stubEnv("INSTAGRAM_APP_SECRET", IG_APP_SECRET);
  vi.stubEnv("TIKTOK_CLIENT_KEY", TT_KEY);
  vi.stubEnv("TIKTOK_CLIENT_SECRET", TT_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("routing y método", () => {
  it.each(["GET", "PUT", "PATCH", "DELETE"])(
    "%s → 405 + Allow: POST, antes de autenticar",
    async (method) => {
      const state = await call(req({ method }));
      expect(state.status).toBe(405);
      expect(state.headers.Allow).toBe("POST");
      expect(state.body).toEqual({ error: "Método no permitido" });
      expect(fake.claimsCalls).toBe(0);
      assertNothingCreated(state);
    },
  );

  it("la acción social-connect existe en el dispatcher; una parecida sigue dando 404", async () => {
    const other = await call(req({ query: { action: "social_connect" } }));
    expect(other.status).toBe(404);
    expect(fake.claimsCalls).toBe(0);
  });
});

describe("autorización (requireAdmin real)", () => {
  it("sin Authorization → 401, sin llegar a verificar ni a crear nada", async () => {
    const state = await call(req({ token: null }));
    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: "No autenticado" });
    expect(fake.claimsCalls).toBe(0);
    assertNothingCreated(state);
  });

  it("esquema distinto de Bearer → 401", async () => {
    const state = await call(req({ authorization: "Basic dXNlcjpwYXNz" }));
    expect(state.status).toBe(401);
    assertNothingCreated(state);
  });

  it("JWT inválido → 401", async () => {
    const state = await call(req({ token: "jwt-que-no-existe" }));
    expect(state.status).toBe(401);
    assertNothingCreated(state);
  });

  it("USER (sin rol) con AAL2 → 403", async () => {
    const state = await call(req({ token: "jwt-user-aal2" }));
    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: "No autorizado" });
    assertNothingCreated(state);
  });

  it("MODERATOR con AAL2 → 403", async () => {
    const state = await call(req({ token: "jwt-moderator-aal2" }));
    expect(state.status).toBe(403);
    assertNothingCreated(state);
  });

  it("ADMIN con AAL1 → 403", async () => {
    const state = await call(req({ token: "jwt-admin-aal1" }));
    expect(state.status).toBe(403);
    assertNothingCreated(state);
  });

  it("error de infraestructura al leer admin_roles → 500 genérico (nunca 'sin rol'), sin efectos", async () => {
    fake.rolesError = { code: "57014", message: "detalle interno de postgres" };
    const state = await call(req());
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(JSON.stringify(state.body)).not.toContain("postgres");
    assertNothingCreated(state);
  });

  it("ADMIN con AAL2 → 200 con cada proveedor", async () => {
    for (const provider of ["instagram", "tiktok"]) {
      const state = await call(req({ body: { provider } }));
      expect(state.status).toBe(200);
    }
  });

  it("una petición sin autenticar con body inválido recibe 401, no 400 (autenticación primero)", async () => {
    const state = await call(req({ token: null, body: { provider: "facebook" } }));
    expect(state.status).toBe(401);
    assertNothingCreated(state);
  });

  it("una petición sin autenticar fuera de Production recibe 401, no 403 del guard", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const state = await call(req({ token: null }));
    expect(state.status).toBe(401);
  });
});

describe("body", () => {
  const invalid: [string, unknown][] = [
    ["vacío (undefined)", undefined],
    ["string vacío", ""],
    ["JSON inválido", "{provider:"],
    ["null", null],
    ["array", [{ provider: "instagram" }]],
    ["número", 42],
    ["objeto vacío", {}],
    ["provider ausente", { other: "instagram" }],
    ["provider desconocido", { provider: "facebook" }],
    ["provider vacío", { provider: "" }],
    ["provider en mayúsculas", { provider: "Instagram" }],
    ["provider no string (número)", { provider: 1 }],
    ["provider no string (array)", { provider: ["instagram"] }],
    ["provider null", { provider: null }],
    ["clave extra: user_id", { provider: "instagram", user_id: OTHER_ID }],
    [
      "clave extra: redirect_uri",
      { provider: "instagram", redirect_uri: "https://x.example" },
    ],
    ["clave extra: scope", { provider: "tiktok", scope: "user.info.basic" }],
    ["clave extra: role", { provider: "tiktok", role: "admin" }],
  ];

  it.each(invalid)(
    "%s → 400 {error:'Solicitud inválida'} sin efectos",
    async (_name, body) => {
      const state = await call(req({ body }));
      expect(state.status).toBe(400);
      expect(state.body).toEqual({ error: "Solicitud inválida" });
      assertNothingCreated(state);
    },
  );

  it("no refleja el body recibido en la respuesta", async () => {
    const state = await call(req({ body: { provider: "canary-no-reflejar" } }));
    expect(JSON.stringify(state)).not.toContain("canary-no-reflejar");
  });

  it("un body en forma de string JSON válido también se acepta (mismo criterio que el resto de handlers)", async () => {
    const state = await call(req({ body: '{"provider":"tiktok"}' }));
    expect(state.status).toBe(200);
  });

  it("el provider solo se toma del body, nunca de la query", async () => {
    const state = await call(
      req({ body: { provider: "instagram" }, query: { provider: "tiktok" } }),
    );
    expect(state.status).toBe(200);
    expect(state.headers["Set-Cookie"]).toMatch(/^instagram_oauth_state=/);
    expect(fake.flows.has("instagram")).toBe(true);
    expect(fake.flows.has("tiktok")).toBe(false);
  });

  it("body inválido se responde antes del guard de entorno", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const state = await call(req({ body: { provider: "facebook" } }));
    expect(state.status).toBe(400);
  });
});

describe("Production guard (después de autenticar y validar el body)", () => {
  it.each(["instagram", "tiktok"])(
    "%s fuera de Production (preview, development, ausente) → 403 sin flujo, cookie ni URL",
    async (provider) => {
      for (const env of ["preview", "development", ""]) {
        vi.stubEnv("VERCEL_ENV", env);
        const state = await call(req({ body: { provider } }));
        expect(state.status).toBe(403);
        expect(state.body).toEqual({ error: "No disponible en este entorno" });
        assertNothingCreated(state);
      }
    },
  );
});

describe("configuración del proveedor", () => {
  it.each([
    ["instagram", "INSTAGRAM_APP_ID"],
    ["instagram", "INSTAGRAM_APP_SECRET"],
    ["tiktok", "TIKTOK_CLIENT_KEY"],
    ["tiktok", "TIKTOK_CLIENT_SECRET"],
  ])("%s sin %s → 503 sin crear flujo", async (provider, variable) => {
    vi.stubEnv(variable, "");
    const state = await call(req({ body: { provider } }));
    expect(state.status).toBe(503);
    expect(state.body).toEqual({ error: "Integración no disponible" });
    expect(JSON.stringify(state.body)).not.toContain(variable);
    assertNothingCreated(state);
  });

  it("la configuración de un proveedor no afecta al otro", async () => {
    vi.stubEnv("TIKTOK_CLIENT_KEY", "");
    expect((await call(req({ body: { provider: "instagram" } }))).status).toBe(200);
  });
});

describe("validación defensiva de la URL (antes de persistir)", () => {
  const badInstagram: [string, (id: string, state: string) => string][] = [
    [
      "host ajeno",
      (_id, s) =>
        `https://evil.example/oauth/authorize?redirect_uri=${encodeURIComponent("https://upmina-web.vercel.app/api/instagram-callback")}&state=${s}`,
    ],
    [
      "http en vez de https",
      (_id, s) =>
        `http://www.instagram.com/oauth/authorize?redirect_uri=${encodeURIComponent("https://upmina-web.vercel.app/api/instagram-callback")}&state=${s}`,
    ],
    [
      "ruta distinta",
      (_id, s) =>
        `https://www.instagram.com/otra/ruta?redirect_uri=${encodeURIComponent("https://upmina-web.vercel.app/api/instagram-callback")}&state=${s}`,
    ],
    [
      "redirect_uri distinto",
      (_id, s) =>
        `https://www.instagram.com/oauth/authorize?redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=${s}`,
    ],
    [
      "credenciales en la URL",
      (_id, s) =>
        `https://user:pass@www.instagram.com/oauth/authorize?redirect_uri=${encodeURIComponent("https://upmina-web.vercel.app/api/instagram-callback")}&state=${s}`,
    ],
    ["no es una URL", () => "no-es-una-url"],
  ];

  it.each(badInstagram)("Instagram: %s → 500, sin flujo ni cookie", async (_n, build) => {
    fake.igUrl = build;
    const state = await call(req({ body: { provider: "instagram" } }));
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    assertNothingCreated(state);
  });

  it.each([
    [
      "host ajeno",
      (_id: string, s: string) =>
        `https://evil.example/v2/auth/authorize/?redirect_uri=${encodeURIComponent("https://upmina-web.vercel.app/api/tiktok-callback")}&state=${s}`,
    ],
    [
      "redirect_uri distinto",
      (_id: string, s: string) =>
        `https://www.tiktok.com/v2/auth/authorize/?redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=${s}`,
    ],
    [
      "ruta distinta",
      (_id: string, s: string) =>
        `https://www.tiktok.com/otra/?redirect_uri=${encodeURIComponent("https://upmina-web.vercel.app/api/tiktok-callback")}&state=${s}`,
    ],
  ])("TikTok: %s → 500, sin flujo ni cookie", async (_n, build) => {
    fake.ttUrl = build;
    const state = await call(req({ body: { provider: "tiktok" } }));
    expect(state.status).toBe(500);
    assertNothingCreated(state);
  });

  it("un constructor que lanza → 500 genérico, sin flujo", async () => {
    fake.igUrl = () => {
      throw new Error("detalle interno");
    };
    const state = await call(req({ body: { provider: "instagram" } }));
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain("detalle interno");
    assertNothingCreated(state);
  });
});

describe("éxito: Instagram", () => {
  it("200 con authorization_url, cookie exacta y no-store; JSON con una única clave", async () => {
    const state = await call(req({ body: { provider: "instagram" } }));
    expect(state.status).toBe(200);
    expect(Object.keys(state.body as object)).toEqual(["authorization_url"]);
    expect(state.headers["Cache-Control"]).toBe("no-store");

    const url = new URL((state.body as { authorization_url: string }).authorization_url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://www.instagram.com/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(IG_APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://upmina-web.vercel.app/api/instagram-callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_comments",
    );
    expect(url.searchParams.get("state")).toBeTruthy();

    const cookie = state.headers["Set-Cookie"];
    expect(cookie).toMatch(/^instagram_oauth_state=[\w-]+; /);
    expect(cookie).toContain("Path=/api/instagram-callback");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
  });

  it("el state conserva el formato <nonce>.<exp>.<HMAC> y lo acepta el verificador del callback", async () => {
    const state = await call(req({ body: { provider: "instagram" } }));
    const url = new URL((state.body as { authorization_url: string }).authorization_url);
    const st = url.searchParams.get("state")!;
    expect(st.split(".")).toHaveLength(3);
    const nonce = cookieNonce(state.headers["Set-Cookie"]);
    expect(st.startsWith(`${nonce}.`)).toBe(true);
    expect(verifyInstagramState(st, nonce, IG_APP_SECRET)).not.toBeNull();
    // Con otro secreto o sin cookie, no valida.
    expect(verifyInstagramState(st, nonce, "otro-secreto")).toBeNull();
    expect(verifyInstagramState(st, undefined, IG_APP_SECRET)).toBeNull();
  });
});

describe("éxito: TikTok", () => {
  it("200 con authorization_url, cookie exacta y no-store; JSON con una única clave", async () => {
    const state = await call(req({ body: { provider: "tiktok" } }));
    expect(state.status).toBe(200);
    expect(Object.keys(state.body as object)).toEqual(["authorization_url"]);
    expect(state.headers["Cache-Control"]).toBe("no-store");

    const url = new URL((state.body as { authorization_url: string }).authorization_url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://www.tiktok.com/v2/auth/authorize/",
    );
    expect(url.searchParams.get("client_key")).toBe(TT_KEY);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://upmina-web.vercel.app/api/tiktok-callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.list");

    const cookie = state.headers["Set-Cookie"];
    expect(cookie).toMatch(/^tiktok_oauth_state=[\w-]+; /);
    expect(cookie).toContain("Path=/api/tiktok-callback");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
  });

  it("el state conserva el formato y lo acepta el verificador del callback", async () => {
    const state = await call(req({ body: { provider: "tiktok" } }));
    const url = new URL((state.body as { authorization_url: string }).authorization_url);
    const st = url.searchParams.get("state")!;
    expect(st.split(".")).toHaveLength(3);
    const nonce = cookieNonce(state.headers["Set-Cookie"]);
    expect(verifyTikTokState(st, nonce, TT_SECRET)).toBe(true);
    expect(verifyTikTokState(st, nonce, "otro-secreto")).toBe(false);
  });

  it("no cruza proveedores: cookie e identificador de cada uno son los suyos", async () => {
    const ig = await call(req({ body: { provider: "instagram" } }));
    const tt = await call(req({ body: { provider: "tiktok" } }));
    expect(ig.headers["Set-Cookie"]).not.toContain("tiktok");
    expect(tt.headers["Set-Cookie"]).not.toContain("instagram");
    const igUrl = new URL((ig.body as { authorization_url: string }).authorization_url);
    const ttUrl = new URL((tt.body as { authorization_url: string }).authorization_url);
    expect(igUrl.host).toBe("www.instagram.com");
    expect(ttUrl.host).toBe("www.tiktok.com");
    expect(igUrl.searchParams.has("client_key")).toBe(false);
    expect(ttUrl.searchParams.has("client_id")).toBe(false);
  });
});

describe("social_oauth_flows (módulo real)", () => {
  it("crea exactamente UN flujo por inicio, ligado al sub verificado del JWT", async () => {
    await call(req({ body: { provider: "instagram" } }));
    expect(fake.upserts).toHaveLength(1);
    expect(fake.flows.get("instagram")).toMatchObject({
      provider: "instagram",
      admin_user_id: ADMIN_ID,
      consumed_at: null,
    });
  });

  it("el body no puede elegir el userId: con user_id en el body → 400 y sin flujo; el del flujo es siempre el del JWT", async () => {
    const rejected = await call(
      req({ body: { provider: "instagram", user_id: OTHER_ID } }),
    );
    expect(rejected.status).toBe(400);
    expect(fake.flows.size).toBe(0);
    await call(req({ body: { provider: "instagram" } }));
    expect(fake.flows.get("instagram")?.admin_user_id).toBe(ADMIN_ID);
    expect(fake.flows.get("instagram")?.admin_user_id).not.toBe(OTHER_ID);
  });

  it("guarda el SHA-256 del nonce de la cookie; el nonce en claro y el state no se persisten", async () => {
    const state = await call(req({ body: { provider: "tiktok" } }));
    const nonce = cookieNonce(state.headers["Set-Cookie"]);
    const row = fake.flows.get("tiktok")!;
    expect(row.nonce_hash).toBe(sha256(nonce));
    expect(row.nonce_hash).toMatch(/^[0-9a-f]{64}$/);
    const persisted = JSON.stringify([...fake.upserts, ...fake.flows.values()]);
    expect(persisted).not.toContain(nonce);
    const st = new URL(
      (state.body as { authorization_url: string }).authorization_url,
    ).searchParams.get("state")!;
    expect(persisted).not.toContain(st);
  });

  it("el state no contiene el userId, el JWT ni identidad alguna", async () => {
    for (const provider of ["instagram", "tiktok"]) {
      const state = await call(req({ body: { provider } }));
      const st = new URL(
        (state.body as { authorization_url: string }).authorization_url,
      ).searchParams.get("state")!;
      expect(st).not.toContain(ADMIN_ID);
      expect(st).not.toContain("jwt-admin-aal2");
      expect(st).not.toContain("admin");
      expect(st.split(".")).toHaveLength(3);
    }
  });

  it("latest-wins: dos inicios del mismo provider dejan UNA fila con el hash del segundo", async () => {
    const first = await call(req({ body: { provider: "instagram" } }));
    const second = await call(req({ body: { provider: "instagram" } }));
    expect(fake.upserts).toHaveLength(2);
    expect(fake.flows.size).toBe(1);
    const n1 = cookieNonce(first.headers["Set-Cookie"]);
    const n2 = cookieNonce(second.headers["Set-Cookie"]);
    expect(n1).not.toBe(n2);
    expect(fake.flows.get("instagram")?.nonce_hash).toBe(sha256(n2));
    expect(fake.flows.get("instagram")?.nonce_hash).not.toBe(sha256(n1));
  });

  it("Instagram y TikTok mantienen una fila independiente cada uno", async () => {
    await call(req({ body: { provider: "instagram" } }));
    await call(req({ body: { provider: "tiktok" } }));
    expect(fake.flows.size).toBe(2);
    expect(fake.flows.get("instagram")?.nonce_hash).not.toBe(
      fake.flows.get("tiktok")?.nonce_hash,
    );
  });

  it("fallo de Supabase al crear el flujo → 500 genérico, sin cookie ni authorization_url", async () => {
    fake.flowError = { code: "42501", message: "permission denied secreto-interno" };
    const state = await call(req({ body: { provider: "instagram" } }));
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(state.headers["Set-Cookie"]).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("secreto-interno");
    expect(JSON.stringify(state)).not.toContain("authorization_url");
    expect(fake.flows.size).toBe(0);
  });

  it("excepción del cliente al crear el flujo → 500 genérico, sin cookie ni URL", async () => {
    fake.flowThrow = new Error("ECONNRESET interno");
    const state = await call(req({ body: { provider: "tiktok" } }));
    expect(state.status).toBe(500);
    expect(state.headers["Set-Cookie"]).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("ECONNRESET");
  });
});

describe("no se filtra nada sensible", () => {
  it("la respuesta de éxito no contiene secretos, JWT, service role, hash, userId ni rol", async () => {
    for (const provider of ["instagram", "tiktok"]) {
      const state = await call(req({ body: { provider } }));
      const nonce = cookieNonce(state.headers["Set-Cookie"]);
      const wire = JSON.stringify(state);
      for (const secret of [
        IG_APP_SECRET,
        TT_SECRET,
        SERVICE_ROLE_KEY,
        "jwt-admin-aal2",
        ADMIN_ID,
        sha256(nonce),
        "aal2",
      ]) {
        expect(wire).not.toContain(secret);
      }
    }
  });

  it("no registra nada en consola en ningún camino", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    fake.flowError = { code: "42501" };
    await call(req({ body: { provider: "instagram" } }));
    fake.flowError = undefined;
    await call(req({ body: { provider: "tiktok" } }));
    await call(req({ token: "jwt-user-aal2" }));
    await call(req({ body: { provider: "facebook" } }));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("no añade cabeceras CORS", async () => {
    const state = await call(req());
    expect(
      Object.keys(state.headers).some((h) =>
        h.toLowerCase().startsWith("access-control"),
      ),
    ).toBe(false);
  });
});
