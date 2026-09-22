import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/instagram/[resource]";
import * as handlers from "./instagram-handlers";

// Fija el despachador que reemplazó a los 4 archivos api/instagram-feed.ts,
// api/instagram-profile.ts, api/instagram-media.ts y api/instagram-comments.ts (motivo:
// límite de 12 Serverless Functions del plan Hobby de Vercel). No repite la lógica de
// cada endpoint (ya cubierta por instagram.test.ts contra los mismos handlers
// reexportados desde instagram-handlers.ts): solo comprueba que el `resource` correcto
// llega al handler correcto, que un resource desconocido no llama a ninguno, y que las
// reescrituras públicas siguen apuntando aquí.

vi.mock("./instagram-handlers", () => ({
  handleInstagramFeed: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("feed"),
  ),
  handleInstagramProfile: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("profile"),
  ),
  handleInstagramMedia: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("media"),
  ),
  handleInstagramComments: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("comments"),
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

describe("api/instagram/[resource] (despachador)", () => {
  it("resource=feed → solo handleInstagramFeed, con el mismo req/res", async () => {
    const request = req("feed");
    const { res } = mockRes();

    await router(request, res);

    expect(handlers.handleInstagramFeed).toHaveBeenCalledWith(request, res);
    expect(handlers.handleInstagramProfile).not.toHaveBeenCalled();
    expect(handlers.handleInstagramMedia).not.toHaveBeenCalled();
    expect(handlers.handleInstagramComments).not.toHaveBeenCalled();
  });

  it("resource=profile → solo handleInstagramProfile", async () => {
    const request = req("profile");
    const { res } = mockRes();

    await router(request, res);

    expect(handlers.handleInstagramProfile).toHaveBeenCalledWith(request, res);
    expect(handlers.handleInstagramFeed).not.toHaveBeenCalled();
  });

  it("resource=media, con ?id= → solo handleInstagramMedia, el id llega intacto", async () => {
    const request = req("media", { id: "17900000000000001" });
    const { res } = mockRes();

    await router(request, res);

    expect(handlers.handleInstagramMedia).toHaveBeenCalledWith(request, res);
    expect(request.query.id).toBe("17900000000000001");
  });

  it("resource=comments, con ?id= → solo handleInstagramComments, el id llega intacto", async () => {
    const request = req("comments", { id: "17900000000000002" });
    const { res } = mockRes();

    await router(request, res);

    expect(handlers.handleInstagramComments).toHaveBeenCalledWith(request, res);
    expect(request.query.id).toBe("17900000000000002");
  });

  it("resource desconocido → 404, ningún handler se llama", async () => {
    const { res, state } = mockRes();

    await router(req("algo-inventado"), res);

    expect(state.status).toBe(404);
    expect(handlers.handleInstagramFeed).not.toHaveBeenCalled();
    expect(handlers.handleInstagramProfile).not.toHaveBeenCalled();
    expect(handlers.handleInstagramMedia).not.toHaveBeenCalled();
    expect(handlers.handleInstagramComments).not.toHaveBeenCalled();
  });

  it("sin resource en absoluto → 404 (no debería alcanzarse fuera de las reescrituras, pero falla cerrado)", async () => {
    const { res, state } = mockRes();

    await router(req(undefined), res);

    expect(state.status).toBe(404);
  });
});

describe("vercel.json: reescrituras públicas de Instagram", () => {
  it("las 4 URLs públicas siguen reescribiendo hacia /api/instagram/<resource>, sin query string propio en el destino", () => {
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
      // Sin "?" propio: así Vercel añade automáticamente el querystring original
      // (necesario para ?id=... en media/comments).
      expect(rule?.destination).not.toContain("?");
    }
  });

  it("el rewrite catch-all del SPA sigue excluyendo /api/ y /assets/", () => {
    const rewrites = readVercelRewrites();
    const spaCatchAll = rewrites.find((r) => r.destination === "/index.html");
    expect(spaCatchAll?.source).toBe("/((?!api/|assets/).*)");
  });
});
