// @vitest-environment node
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalClient,
  clientAddress,
  clientKeys,
  defaultDeps,
  handlePasswordRecoveryRequest,
  normalizeEmail,
  type PasswordRecoveryDeps,
} from "./password-recovery-handlers";
import { handleProfile } from "./profile-handlers";

// «Olvidé mi contraseña» con comprobación del correo. Se ejecuta el handler real; Supabase es un doble. No se envía nada.

const SECRET = "synthetic-server-secret";

interface Reply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}
function call(
  handler: (req: VercelRequest, res: VercelResponse) => unknown,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, unknown>;
    query?: object;
  },
): Promise<Reply> {
  const reply: Reply = { status: 0, body: undefined, headers: {} };
  const res = {
    setHeader: (k: string, v: string) => {
      reply.headers[k] = v;
      return res;
    },
    status: (s: number) => {
      reply.status = s;
      return res;
    },
    json: (b: unknown) => {
      reply.body = b;
      return res;
    },
  } as unknown as VercelResponse;
  const req = {
    method: init.method ?? "POST",
    body: init.body,
    headers: init.headers ?? {},
    query: init.query ?? {},
  } as unknown as VercelRequest;
  return Promise.resolve(handler(req, res)).then(() => reply);
}

/** Doble de Supabase: SOLO existe la RPC permitida; cualquier otra cosa reventaría. */
function fakes(
  rpcImpl: (name: string, args: Record<string, unknown>) => unknown = () => ({
    data: { status: "confirmed" },
    error: null,
  }),
) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) =>
    rpcImpl(name, args),
  );
  const deps: PasswordRecoveryDeps = {
    lookupClient: () => ({ rpc }) as unknown as SupabaseClient,
    ipSecret: () => SECRET,
  };
  return { deps, rpc };
}
const post = (
  deps: PasswordRecoveryDeps,
  body: unknown,
  headers: Record<string, unknown> = {},
) => call((req, res) => handlePasswordRecoveryRequest(req, res, deps), { body, headers });
const rpcStatus =
  (status: string, extra: object = {}) =>
  () => ({
    data: { status, ...extra },
    error: null,
  });
const req = (headers: Record<string, unknown>) =>
  ({ headers }) as unknown as VercelRequest;
const hmac = (label: string, value: string, secret = SECRET) =>
  createHmac("sha256", secret).update(`upmina:lookup:${label}:v1:${value}`).digest("hex");
const keysOf = (headers: Record<string, unknown>, secret = SECRET) =>
  clientKeys(req(headers), secret);

describe("forma de la petición", () => {
  it("solo POST: otro método → 405 con Allow y sin tocar la base", async () => {
    const f = fakes();
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const r = await call((rq, rs) => handlePasswordRecoveryRequest(rq, rs, f.deps), {
        method,
        body: { email: "a@b.co" },
      });
      expect(r.status, method).toBe(405);
      expect(r.headers.Allow).toBe("POST");
    }
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["sin cuerpo", undefined],
    ["cuerpo no objeto", "texto"],
    ["array", []],
    ["JSON inválido", "{no es json"],
    ["campos extra", { email: "a@b.co", extra: 1 }],
    ["redirectTo", { email: "a@b.co", redirectTo: "https://evil.test" }],
    ["otro campo", { correo: "a@b.co" }],
    ["email no string", { email: 5 }],
    ["email vacío", { email: "" }],
    ["sin arroba", { email: "persona" }],
    ["sin dominio", { email: "a@b" }],
    ["con espacios", { email: "a b@c.co" }],
    ["demasiado largo", { email: `${"x".repeat(250)}@e.co` }],
    ["control", { email: "a\u0000@b.co" }],
    ["salto de línea", { email: "a@b.co\nbcc:x@y.co" }],
  ])("entrada inválida (%s) → 400, sin consultar la base", async (_n, body) => {
    const f = fakes();
    const r = await post(f.deps, body);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Solicitud inválida" });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("normaliza el correo (trim + minúsculas) antes de consultar", async () => {
    const f = fakes();
    await post(
      f.deps,
      { email: "  Persona@Example.TEST  " },
      { "x-vercel-forwarded-for": "203.0.113.9" },
    );
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_email: "persona@example.test" });
    expect(normalizeEmail("  A@B.co ")).toBe("a@b.co");
    expect(normalizeEmail("x")).toBeNull();
  });

  it("nunca se cachea (no-store)", async () => {
    const f = fakes();
    expect((await post(f.deps, { email: "a@b.co" })).headers["Cache-Control"]).toBe(
      "no-store",
    );
  });
});

describe("los tres estados del correo (el servidor NO envía nada)", () => {
  it.each([
    ["confirmed", "confirmed"],
    ["unconfirmed", "unconfirmed"],
    ["none", "unregistered"],
  ])("%s → 200 {status:'%s'} y solo eso", async (db, api) => {
    const f = fakes(rpcStatus(db));
    const r = await post(f.deps, { email: "a@b.co" });
    expect(r).toMatchObject({ status: 200, body: { status: api } });
    expect(Object.keys(r.body as object)).toEqual(["status"]);
  });

  it("no se filtran datos de auth.users aunque la base los devolviera", async () => {
    for (const status of ["confirmed", "unconfirmed", "none"]) {
      const f = fakes(() => ({
        data: {
          status,
          id: "SENTINEL-ID",
          email: "SENTINEL@x.co",
          created_at: "SENTINEL",
        },
        error: null,
      }));
      const r = await post(f.deps, { email: "a@b.co" });
      expect(JSON.stringify(r.body)).not.toMatch(/SENTINEL/);
    }
  });

  it("el módulo del servidor no envía correos ni crea usuarios: ninguna llamada a resetPasswordForEmail, signUp, OTP ni signIn", () => {
    const src = readFileSync("src/lib/password-recovery-handlers.ts", "utf8");
    expect(src).not.toMatch(
      /\.(resetPasswordForEmail|signUp|signInWith\w+|resend|admin\.\w+)\(/,
    );
    expect(src).not.toMatch(/fetch\(|nodemailer|resend\.com/i);
  });

  it("sin datos sensibles en logs: el módulo no usa console ni escribe nada", () => {
    const src = readFileSync("src/lib/password-recovery-handlers.ts", "utf8");
    expect(src).not.toMatch(/console\.|process\.stdout|process\.stderr|writeFile/);
  });
});

describe("límites y errores técnicos (nunca «inexistente»)", () => {
  it("límite de consultas → 429 con Retry-After y retryAfterSeconds acotado", async () => {
    for (const [given, expected] of [
      [42, 42],
      [0, 1],
      [-5, 1],
      [99999, 3600],
      [12.2, 13],
    ] as const) {
      const f = fakes(rpcStatus("rate_limited", { retryAfterSeconds: given }));
      const r = await post(f.deps, { email: "a@b.co" });
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ status: "rate_limited", retryAfterSeconds: expected });
      expect(r.headers["Retry-After"]).toBe(String(expected));
    }
    const g = fakes(rpcStatus("rate_limited"));
    expect((await post(g.deps, { email: "a@b.co" })).body).toEqual({
      status: "rate_limited",
      retryAfterSeconds: 60,
    });
  });

  it.each([
    ["error de la RPC", () => ({ data: null, error: { message: "boom SENTINEL" } })],
    ["RPC sin datos", () => ({ data: null, error: null })],
    ["datos que no son objeto", () => ({ data: "x", error: null })],
    ["sin status", () => ({ data: {}, error: null })],
    ["status desconocido", rpcStatus("quizas")],
    [
      "la RPC lanza",
      () => {
        throw new Error("network SENTINEL");
      },
    ],
  ])(
    "fallo técnico (%s) → 502 {status:'error'}; NO es 'unregistered'",
    async (_n, impl) => {
      const f = fakes(impl);
      const r = await post(f.deps, { email: "a@b.co" });
      expect(r.status).toBe(502);
      expect(r.body).toEqual({ status: "error" });
      expect(JSON.stringify(r.body)).not.toMatch(/SENTINEL|boom|network/);
    },
  );

  it("sin configuración (service_role o secreto) → 503 {status:'error'}", async () => {
    const base = fakes();
    for (const deps of [
      { ...base.deps, lookupClient: () => null },
      { ...base.deps, ipSecret: () => null },
    ]) {
      const r = await post(deps, { email: "a@b.co" });
      expect(r).toMatchObject({ status: 503, body: { status: "error" } });
    }
    expect(base.rpc).not.toHaveBeenCalled();
  });

  it("solicitudes concurrentes: cada una pasa por la cuota ATÓMICA de la base y comparten la clave de IP", async () => {
    const seen = new Map<string, number>();
    const f = fakes((_n, args) => {
      const ip = String(args.p_ip);
      const n = (seen.get(ip) ?? 0) + 1;
      seen.set(ip, n);
      return n <= 5
        ? { data: { status: "confirmed" }, error: null }
        : { data: { status: "rate_limited", retryAfterSeconds: 30 }, error: null };
    });
    const replies = await Promise.all(
      Array.from({ length: 8 }, () =>
        post(f.deps, { email: "a@b.co" }, { "x-vercel-forwarded-for": "203.0.113.9" }),
      ),
    );
    expect(replies.filter((r) => r.status === 200)).toHaveLength(5);
    expect(replies.filter((r) => r.status === 429)).toHaveLength(3);
    expect(f.rpc).toHaveBeenCalledTimes(8);
    expect(seen.size).toBe(1);
  });
});

describe("IP confiable (lote 3P-S)", () => {
  const A = "203.0.113.9";

  it("precedencia documentada de Vercel: x-vercel-forwarded-for > x-real-ip > x-forwarded-for", () => {
    expect(
      clientAddress(
        req({
          "x-vercel-forwarded-for": A,
          "x-real-ip": "198.51.100.1",
          "x-forwarded-for": "192.0.2.1",
        }),
      ),
    ).toBe(A);
    expect(clientAddress(req({ "x-real-ip": A, "x-forwarded-for": "192.0.2.1" }))).toBe(
      A,
    );
    expect(clientAddress(req({ "x-forwarded-for": A }))).toBe(A);
  });

  it("x-forwarded-for: se usa el ÚLTIMO elemento; un valor inicial falseado por el cliente no cambia la clave", () => {
    const honest = keysOf({ "x-forwarded-for": A });
    for (const forged of [
      `1.1.1.1, ${A}`,
      `8.8.8.8,9.9.9.9, ${A}`,
      `::1, ${A}`,
      ` 10.0.0.1 ,  ${A} `,
    ]) {
      expect(keysOf({ "x-forwarded-for": forged }), forged).toEqual(honest);
    }
    // y un último elemento distinto SÍ cambia la clave
    expect(keysOf({ "x-forwarded-for": `${A}, 203.0.113.99` }).ip).not.toBe(honest.ip);
  });

  it("un valor inválido en la cabecera preferida se descarta y se prueba la siguiente; si ninguna es válida → unknown", () => {
    expect(
      clientAddress(req({ "x-vercel-forwarded-for": "no-es-ip", "x-real-ip": A })),
    ).toBe(A);
    expect(
      clientAddress(
        req({ "x-vercel-forwarded-for": "1.1.1.1, 2.2.2.2", "x-real-ip": A }),
      ),
    ).toBe(A);
    for (const bad of [
      "",
      " ",
      "unknown",
      "localhost",
      "203.0.113.9; drop table",
      "203.0.113.9:8080",
      "999.1.1.1",
      "1.2.3",
      "fe80::1%eth0",
      "<script>",
      "x".repeat(100),
      "203.0.113.9\r\nX-Evil: 1",
      "0x7f.0.0.1",
      "2001:db8::g",
      "1::2::3",
    ]) {
      expect(
        clientAddress(req({ "x-vercel-forwarded-for": bad })),
        JSON.stringify(bad),
      ).toBeNull();
      expect(keysOf({ "x-forwarded-for": bad }), JSON.stringify(bad)).toEqual({
        ip: "unknown",
        net: "unknown",
      });
    }
    expect(keysOf({})).toEqual({ ip: "unknown", net: "unknown" });
  });

  it("cabeceras repetidas (array) se tratan como una lista; nada de lo que no sea IP llega a la clave", () => {
    expect(clientAddress(req({ "x-forwarded-for": ["1.1.1.1", A] }))).toBe(A);
    expect(clientAddress(req({ "x-real-ip": [123] }))).toBeNull();
    expect(clientAddress(req({ "x-real-ip": 123 }))).toBeNull();
  });

  it("IPv4: la clave de IP es la dirección; la red agrupa el /24", () => {
    const a = keysOf({ "x-real-ip": "203.0.113.9" });
    const b = keysOf({ "x-real-ip": "203.0.113.200" });
    const c = keysOf({ "x-real-ip": "203.0.114.9" });
    expect(a.ip).not.toBe(b.ip);
    expect(a.net).toBe(b.net);
    expect(a.net).not.toBe(c.net);
    expect(a.ip).toBe(hmac("ip", "v4:203.0.113.9"));
    expect(a.net).toBe(hmac("net", "v4:203.0.113"));
  });

  it("IPv6: se agrupa por /64 la IP y por /48 la red, con la misma clave para cualquier forma de escribirla", () => {
    const a = keysOf({ "x-real-ip": "2001:db8:1:2:aaaa::1" });
    const sameSlash64 = keysOf({ "x-real-ip": "2001:0DB8:0001:0002:bbbb:0:0:9" });
    const otherSlash64 = keysOf({ "x-real-ip": "2001:db8:1:3::1" });
    const otherSlash48 = keysOf({ "x-real-ip": "2001:db8:2:2::1" });
    expect(a.ip).toBe(sameSlash64.ip);
    expect(a.net).toBe(sameSlash64.net);
    expect(a.ip).not.toBe(otherSlash64.ip);
    expect(a.net).toBe(otherSlash64.net); // mismo /48
    expect(a.net).not.toBe(otherSlash48.net);
    expect(a.ip).toBe(hmac("ip", "v6:2001:0db8:0001:0002"));
    expect(a.net).toBe(hmac("net", "v6:2001:0db8:0001"));
    expect(canonicalClient("::")).toEqual({
      ip: "v6:0000:0000:0000:0000",
      net: "v6:0000:0000:0000",
    });
    expect(canonicalClient("1::")?.ip).toBe("v6:0001:0000:0000:0000");
  });

  it("IPv4 mapeada en IPv6 es la misma persona que su IPv4", () => {
    expect(keysOf({ "x-real-ip": "::ffff:203.0.113.9" })).toEqual(
      keysOf({ "x-real-ip": "203.0.113.9" }),
    );
    expect(keysOf({ "x-real-ip": "::ffff:cb00:7109" })).toEqual(
      keysOf({ "x-real-ip": "203.0.113.9" }),
    );
  });

  it("las claves son HMAC-SHA256 de 64 hex con el secreto del servidor: dependen de él y no revelan la IP", () => {
    const k = keysOf({ "x-real-ip": A });
    expect(k.ip).toMatch(/^[0-9a-f]{64}$/);
    expect(k.net).toMatch(/^[0-9a-f]{64}$/);
    expect(keysOf({ "x-real-ip": A }, "otro-secreto").ip).not.toBe(k.ip);
    expect(keysOf({ "x-real-ip": A })).toEqual(k); // determinista
    expect(k.ip).not.toBe(k.net);
    expect(JSON.stringify(k)).not.toContain("203");
  });

  it("la IP NUNCA llega en claro a la base: ni en p_ip, ni en p_net, ni en ningún argumento", async () => {
    const f = fakes();
    await post(
      f.deps,
      { email: "persona@example.test" },
      {
        "x-vercel-forwarded-for": A,
        "x-real-ip": A,
        "x-forwarded-for": A,
      },
    );
    const args = f.rpc.mock.calls[0][1] as Record<string, string>;
    expect(args.p_ip).toBe(hmac("ip", `v4:${A}`));
    expect(args.p_net).toBe(hmac("net", "v4:203.0.113"));
    expect(JSON.stringify(args)).not.toMatch(/203\.0\.113/);
  });

  it("sin cabeceras de IP el servidor pasa «unknown» (bucket propio), nunca una clave vacía ni un error", async () => {
    const f = fakes();
    const r = await post(f.deps, { email: "a@b.co" });
    expect(r.status).toBe(200);
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_ip: "unknown", p_net: "unknown" });
  });

  it("la respuesta nunca incluye la IP ni sus claves", async () => {
    const f = fakes(rpcStatus("rate_limited", { retryAfterSeconds: 30 }));
    const r = await post(f.deps, { email: "a@b.co" }, { "x-real-ip": A });
    expect(JSON.stringify(r)).not.toMatch(/203\.0\.113|[0-9a-f]{64}/);
  });
});

describe("configuración por defecto", () => {
  const d = (env: Record<string, string>) => defaultDeps(env as NodeJS.ProcessEnv);
  it("sin service_role o sin URL no hay cliente ni secreto; con ellos, ambos", () => {
    const none = d({});
    expect(none.lookupClient()).toBeNull();
    expect(none.ipSecret()).toBeNull();
    expect(d({ VITE_SUPABASE_URL: "https://x.supabase.co" }).lookupClient()).toBeNull();
    const full = d({
      VITE_SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "svc-sintetica",
    });
    expect(full.lookupClient()).not.toBeNull();
    expect(full.ipSecret()).toBe("svc-sintetica");
  });

  it("no depende de MFA_RECOVERY_APP_URL ni de la anon key: ya no se envía correo desde el servidor", () => {
    const src = readFileSync("src/lib/password-recovery-handlers.ts", "utf8");
    expect(src).not.toMatch(/MFA_RECOVERY_APP_URL|VITE_SUPABASE_ANON_KEY/);
  });
});

describe("enrutado dentro de /api/profile (sin función nueva)", () => {
  it("?action=password-recovery llega al handler nuevo; sin action el router anterior no cambia", async () => {
    const withAction = await call((rq, rs) => handleProfile(rq, rs), {
      method: "GET",
      query: { action: "password-recovery" },
    });
    expect(withAction.status).toBe(405);
    expect(withAction.headers.Allow).toBe("POST");
    const invalid = await call((rq, rs) => handleProfile(rq, rs), {
      method: "POST",
      query: { action: "password-recovery" },
      body: { nope: 1 },
    });
    expect(invalid).toMatchObject({ status: 400, body: { error: "Solicitud inválida" } });
    const without = await call((rq, rs) => handleProfile(rq, rs), { method: "GET" });
    expect(without.status).toBe(405);
    expect(without.headers.Allow).toBe("POST, PATCH");
  });
});
