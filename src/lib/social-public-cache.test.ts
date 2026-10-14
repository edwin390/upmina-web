import { describe, expect, it, vi } from "vitest";
import type { VercelResponse } from "@vercel/node";
import {
  SOCIAL_PUBLIC_CACHE_CONTROL,
  purgeSocialPublicCache,
  setSocialPublicCache,
  socialStillConnected,
} from "./social-public-cache";

const ENV = {
  VERCEL_CACHE_PURGE_TOKEN: "tok_sintetico_no_real",
  VERCEL_CACHE_PURGE_PROJECT_ID: "prj_sintetico",
  VERCEL_CACHE_PURGE_TEAM_ID: "team_sintetico",
} as unknown as NodeJS.ProcessEnv;

describe("caché pública de redes sociales", () => {
  it("TTL corto, sin stale-while-revalidate y con etiqueta por proveedor", () => {
    const headers: Record<string, string> = {};
    setSocialPublicCache(
      {
        setHeader: (n: string, v: string) => (headers[n] = v),
      } as unknown as VercelResponse,
      "tiktok",
    );
    expect(headers["Cache-Control"]).toBe(SOCIAL_PUBLIC_CACHE_CONTROL);
    expect(headers["Cache-Control"]).not.toMatch(/stale/);
    expect(headers["Vercel-Cache-Tag"]).toBe("social-tiktok");
  });

  it("confirmación fail-closed: sin función, false o error = no conectado", async () => {
    expect(await socialStillConnected(undefined)).toBe(false);
    expect(await socialStillConnected(async () => false)).toBe(false);
    expect(
      await socialStillConnected(async () => {
        throw new Error("db");
      }),
    ).toBe(false);
    expect(await socialStillConnected(async () => true)).toBe(true);
  });

  it("invalida por etiqueta del proveedor correcto y solo ese", async () => {
    const f = vi.fn(async () => ({ ok: true }) as Response);
    expect(
      await purgeSocialPublicCache("instagram", ENV, f as unknown as typeof fetch),
    ).toBe("purged");
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/edge-cache/invalidate-by-tags");
    expect(url.searchParams.get("projectIdOrName")).toBe("prj_sintetico");
    expect(JSON.parse(String(init.body))).toEqual({ tags: ["social-instagram"] });
  });

  it("sin credenciales: not_configured y sin red; fallo HTTP o de red: failed sin lanzar ni filtrar el token", async () => {
    const f = vi.fn();
    expect(
      await purgeSocialPublicCache(
        "tiktok",
        {} as NodeJS.ProcessEnv,
        f as unknown as typeof fetch,
      ),
    ).toBe("not_configured");
    expect(f).not.toHaveBeenCalled();
    expect(
      await purgeSocialPublicCache(
        "tiktok",
        ENV,
        (async () => ({ ok: false }) as Response) as unknown as typeof fetch,
      ),
    ).toBe("failed");
    const boom = vi.fn(async () => {
      throw new Error(ENV.VERCEL_CACHE_PURGE_TOKEN);
    });
    const r = await purgeSocialPublicCache(
      "tiktok",
      ENV,
      boom as unknown as typeof fetch,
    );
    expect(r).toBe("failed");
    expect(JSON.stringify(r)).not.toContain("tok_sintetico");
  });
});
