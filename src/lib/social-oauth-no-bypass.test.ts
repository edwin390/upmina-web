import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import tiktokRouter from "../../api/tiktok/[resource]";
import * as tiktokHandlers from "./tiktok-handlers";

// Guardas ESTRUCTURALES contra la reaparición del inicio público del OAuth social
// (Bloque 8C.3). POST /api/admin/social-connect (ADMIN + AAL2) debe ser la ÚNICA vía HTTP que
// genera `state`, fija la cookie de inicio, produce una authorization URL o crea un flujo en
// social_oauth_flows. Son comprobaciones de código fuente (no ejecutan el bypass): fallan si
// alguien vuelve a añadir un entrypoint o una reescritura de inicio, y NO sustituyen a los
// tests de comportamiento de social-connect-handlers.test.ts. Los callbacks pueden VERIFICAR
// state, pero no iniciar OAuth.

const ROOT = resolve(__dirname, "../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split(sep).join("/");
const isTest = (file: string) => /\.test\.(ts|tsx)$/.test(file);
const read = (file: string) => readFileSync(file, "utf8");

/** Fuentes NO de test: entrypoints de Vercel (api/) y módulos (src/). */
const sources = [...walk(join(ROOT, "api")), ...walk(join(ROOT, "src"))]
  .filter((f) => /\.(ts|tsx)$/.test(f) && !isTest(f))
  .map((f) => ({ path: rel(f), text: read(f) }));

/** Entrypoints HTTP reales: cada .ts bajo api/ es una Vercel Function. */
const entrypoints = sources.filter((s) => s.path.startsWith("api/"));

function filesMatching(pattern: RegExp): string[] {
  return sources.filter((s) => pattern.test(s.text)).map((s) => s.path);
}

const INITIATION_IDENTIFIERS =
  /\b(createInstagramState|createTikTokState|buildInstagramAuthorizeUrl|buildTikTokAuthorizeUrl|createSocialOAuthFlow)\b/;

describe("Instagram: el inicio público no existe", () => {
  it("api/instagram-auth.ts no existe (ya no es una Vercel Function)", () => {
    expect(existsSync(join(ROOT, "api/instagram-auth.ts"))).toBe(false);
  });

  it("ningún entrypoint de api/ se llama *-auth ni *auth*.ts de inicio", () => {
    const names = entrypoints.map((e) => e.path);
    expect(names.filter((n) => /instagram-auth|tiktok-auth|\/auth\.ts$/.test(n))).toEqual(
      [],
    );
  });

  it("ningún entrypoint restante importa o ejecuta lógica de inicio (state, URL, flujo)", () => {
    expect(entrypoints.filter((e) => INITIATION_IDENTIFIERS.test(e.text))).toEqual([]);
  });
});

describe("TikTok: el inicio público no existe", () => {
  it("handleTikTokAuth ya no existe ni se exporta", () => {
    expect("handleTikTokAuth" in tiktokHandlers).toBe(false);
    expect(filesMatching(/\bhandleTikTokAuth\b/)).toEqual([]);
  });

  it('el despachador de TikTok no tiene case "auth"', () => {
    const dispatcher = read(join(ROOT, "api/tiktok/[resource].ts"));
    expect(dispatcher).not.toMatch(/case\s+["']auth["']/);
  });

  it("/api/tiktok/auth cae en el 404 normal del router real, sin llamar a ningún handler", async () => {
    const state: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        state.status = code;
        return res;
      },
      json(body: unknown) {
        state.body = body;
        return res;
      },
      setHeader() {
        return res;
      },
      redirect() {
        throw new Error("no debe redirigir");
      },
    };
    await tiktokRouter(
      {
        method: "GET",
        query: { resource: "auth" },
        headers: {},
      } as unknown as VercelRequest,
      res as unknown as VercelResponse,
    );
    expect(state.status).toBe(404);
    expect(state.body).toEqual({ error: "No encontrado" });
  });

  it("vercel.json no reescribe /api/tiktok-auth, /api/tiktok/auth ni ninguna ruta de inicio", () => {
    const config = JSON.parse(read(join(ROOT, "vercel.json"))) as {
      rewrites?: { source: string; destination: string }[];
    };
    for (const rule of config.rewrites ?? []) {
      expect(rule.source).not.toMatch(/tiktok-auth|instagram-auth/);
      expect(rule.destination).not.toMatch(/\/tiktok\/auth$|instagram-auth|\/auth$/);
    }
    // Las reescrituras que siguen siendo necesarias no se rompieron.
    const sources = (config.rewrites ?? []).map((r) => r.source);
    expect(sources).toContain("/api/tiktok-callback");
    expect(sources).toContain("/api/tiktok-videos");
  });
});

describe("global: POST /api/admin/social-connect es la única vía de inicio", () => {
  it("solo social-connect-handlers.ts USA la lógica de inicio (los demás archivos solo la definen)", () => {
    const definers = new Set([
      "src/lib/instagram-oauth-shared.ts",
      "src/lib/tiktok-shared.ts",
      "src/lib/social-oauth-flow.ts",
    ]);
    const users = filesMatching(INITIATION_IDENTIFIERS).filter((p) => !definers.has(p));
    expect(users).toEqual(["src/lib/social-connect-handlers.ts"]);
  });

  it("ningún otro archivo llama a createSocialOAuthFlow para iniciar (los callbacks no inician)", () => {
    const callers = sources
      .filter((s) => /\bcreateSocialOAuthFlow\s*\(/.test(s.text))
      .map((s) => s.path)
      .filter((p) => p !== "src/lib/social-oauth-flow.ts");
    expect(callers).toEqual(["src/lib/social-connect-handlers.ts"]);
  });

  it("solo el despachador admin importa social-connect-handlers", () => {
    const importers = filesMatching(
      /from\s+["'][^"']*social-connect-handlers(\.js)?["']/,
    ).filter((p) => p !== "src/lib/social-connect-handlers.ts");
    expect(importers).toEqual(["api/admin/[action].ts"]);
  });

  it('el despachador admin enruta la acción "social-connect" al handler protegido', () => {
    const dispatcher = read(join(ROOT, "api/admin/[action].ts"));
    expect(dispatcher).toMatch(
      /case\s+"social-connect":\s*\n\s*return handleAdminSocialConnect\(req, res\);/,
    );
  });

  it("9C: toda autorización social exige EXACTAMENTE la capacidad social_admin (nunca moderation/technical/requirePrivileged)", () => {
    const files = [
      "src/lib/social-connect-handlers.ts",
      "src/lib/social-status-handlers.ts",
      "src/lib/tiktok-handlers.ts",
      "api/instagram-callback.ts",
    ];
    for (const f of files) {
      const src = read(join(ROOT, f));
      expect(src, f).toMatch(
        /requireCapability(ForUser)?\(\s*(req|claim\.adminUserId),\s*"social_admin",?\s*\)/,
      );
      expect(src, f).not.toMatch(
        /requirePrivileged|requireModerator|"moderation"|"technical"|"team_admin"/,
      );
      expect(src, f).not.toMatch(/requireAdmin\b|requireAdminRoleForUser/);
    }
  });

  it("el handler exige requireCapability(social_admin) ANTES de generar state o crear el flujo", () => {
    const handler = read(join(ROOT, "src/lib/social-connect-handlers.ts"));
    const auth = handler.indexOf('await requireCapability(req, "social_admin")');
    expect(auth).toBeGreaterThan(-1);
    for (const call of ["adapter.createState(", "await createSocialOAuthFlow("]) {
      const at = handler.indexOf(call);
      expect(at).toBeGreaterThan(-1);
      expect(auth).toBeLessThan(at);
    }
    expect(handler).not.toMatch(
      /requireAuthenticated|requirePrivileged|requireModerator/,
    );
  });

  it("no existe un segundo lugar que construya una authorization URL de Instagram o TikTok", () => {
    const authorizeLiterals = /oauth\/authorize|v2\/auth\/authorize/;
    const owners = filesMatching(authorizeLiterals).sort();
    expect(owners).toEqual([
      "src/lib/instagram-oauth-shared.ts",
      "src/lib/tiktok-shared.ts",
    ]);
  });

  it("los callbacks y los endpoints de lectura no fijan la cookie de inicio ni construyen URLs", () => {
    const callbackFiles = [
      "api/instagram-callback.ts",
      "src/lib/tiktok-handlers.ts",
      "src/lib/instagram-handlers.ts",
    ];
    for (const file of callbackFiles) {
      const text = sources.find((s) => s.path === file)?.text ?? "";
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/\bstateCookie\s*\(/);
      expect(text).not.toMatch(INITIATION_IDENTIFIERS);
      expect(text).not.toMatch(/\.redirect\s*\(/);
    }
  });

  it("no queda ninguna referencia a rutas públicas de inicio en código o configuración activos", () => {
    const stale = sources
      .filter((s) =>
        /\/api\/(instagram-auth|tiktok-auth)|\/api\/tiktok\/auth/.test(s.text),
      )
      .map((s) => s.path);
    expect(stale).toEqual([]);
    const env = read(join(ROOT, ".env.example"));
    expect(env).not.toMatch(/\/api\/(instagram-auth|tiktok-auth)/);
  });
});
