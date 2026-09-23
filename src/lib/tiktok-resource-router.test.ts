import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/tiktok/[resource]";
import * as handlers from "./tiktok-handlers";

// Fija el despachador que reemplazó a los archivos api/tiktok-callback.ts y
// api/tiktok-videos.ts (el inicio público api/tiktok-auth.ts fue retirado). Motivo de la
// consolidación: límite de 12 Serverless Functions del plan Hobby de Vercel, mismo patrón que
// api/instagram/[resource].ts. No
// repite la lógica de cada endpoint (ya cubierta por tiktok-videos.test.ts contra el
// mismo handler reexportado desde tiktok-handlers.ts): solo comprueba que el `resource`
// correcto llega al handler correcto, que un resource desconocido no llama a ninguno, y
// que las reescrituras públicas siguen apuntando aquí.

vi.mock("./tiktok-handlers", () => ({
  handleTikTokCallback: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("callback"),
  ),
  handleTikTokVideos: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("videos"),
  ),
}));

// vercel.json queda fuera de los `include` de tsconfig y no tiene resolveJsonModule
// activado: se lee como archivo de texto (no como módulo TS) para no afectar el build.
// Vitest ejecuta con cwd = raíz del proyecto (igual que `npm test`).
function readVercelRewrites(): { source: string; destination: string }[] {
  const path = join(process.cwd(), "vercel.json");
  const config = JSON.parse(readFileSync(path, "utf-8")) as {
    rewrites: { source: string; destination: string }[];
  };
  return config.rewrites;
}

function mockRes() {
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
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(resource?: string, extra: Record<string, string> = {}) {
  return {
    method: "GET",
    query: { ...(resource !== undefined ? { resource } : {}), ...extra },
  } as unknown as VercelRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api/tiktok/[resource] (despachador)", () => {
  it("resource=auth → 404 normal: el inicio público de TikTok fue retirado y ningún handler se llama", async () => {
    const { res, state } = mockRes();

    await router(req("auth"), res);

    expect(state.status).toBe(404);
    expect(handlers.handleTikTokCallback).not.toHaveBeenCalled();
    expect(handlers.handleTikTokVideos).not.toHaveBeenCalled();
  });

  it("resource=callback, con ?code=&state= → solo handleTikTokCallback, el query llega intacto", async () => {
    const request = req("callback", { code: "AQC-code-ficticio", state: "el-state" });
    const { res } = mockRes();

    await router(request, res);

    expect(handlers.handleTikTokCallback).toHaveBeenCalledWith(request, res);
    expect(request.query.code).toBe("AQC-code-ficticio");
    expect(request.query.state).toBe("el-state");
  });

  it("resource=videos → solo handleTikTokVideos", async () => {
    const request = req("videos");
    const { res } = mockRes();

    await router(request, res);

    expect(handlers.handleTikTokVideos).toHaveBeenCalledWith(request, res);
    expect(handlers.handleTikTokCallback).not.toHaveBeenCalled();
  });

  it("resource desconocido → 404, ningún handler se llama", async () => {
    const { res, state } = mockRes();

    await router(req("algo-inventado"), res);

    expect(state.status).toBe(404);
    expect(handlers.handleTikTokCallback).not.toHaveBeenCalled();
    expect(handlers.handleTikTokVideos).not.toHaveBeenCalled();
  });

  it("sin resource en absoluto → 404 (no debería alcanzarse fuera de las reescrituras, pero falla cerrado)", async () => {
    const { res, state } = mockRes();

    await router(req(undefined), res);

    expect(state.status).toBe(404);
  });
});

describe("vercel.json: reescrituras públicas de TikTok", () => {
  it("las 2 URLs públicas restantes siguen reescribiendo hacia /api/tiktok/<resource>, sin query string propio en el destino", () => {
    const rewrites = readVercelRewrites();

    const expected: Record<string, string> = {
      "/api/tiktok-callback": "/api/tiktok/callback",
      "/api/tiktok-videos": "/api/tiktok/videos",
    };

    for (const [source, destination] of Object.entries(expected)) {
      const rule = rewrites.find((r) => r.source === source);
      expect(rule).toBeDefined();
      expect(rule?.destination).toBe(destination);
      // Sin "?" propio: así Vercel añade automáticamente el querystring original
      // (necesario para ?code=&state= en el callback).
      expect(rule?.destination).not.toContain("?");
    }
  });

  it("las reescrituras de Instagram siguen intactas", () => {
    const rewrites = readVercelRewrites();
    const expected: Record<string, string> = {
      "/api/instagram-feed": "/api/instagram/feed",
      "/api/instagram-profile": "/api/instagram/profile",
      "/api/instagram-media": "/api/instagram/media",
      "/api/instagram-comments": "/api/instagram/comments",
    };
    for (const [source, destination] of Object.entries(expected)) {
      const rule = rewrites.find((r) => r.source === source);
      expect(rule).toBeDefined();
      expect(rule?.destination).toBe(destination);
    }
  });

  it("el rewrite catch-all del SPA sigue excluyendo /api/ y /assets/", () => {
    const rewrites = readVercelRewrites();
    const spaCatchAll = rewrites.find((r) => r.destination === "/index.html");
    expect(spaCatchAll?.source).toBe("/((?!api/|assets/).*)");
  });
});
