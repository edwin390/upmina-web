// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- dobles de VercelRequest/VercelResponse */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ capability: vi.fn() }));
vi.mock("./admin-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin-auth")>()),
  requireCapability: fake.capability,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({}), rpc: vi.fn() }),
}));

import { FEATURE_UNAVAILABLE_BODY } from "./mina-feature-guard";
import { handleMediaReserve } from "./media-handlers";
import { handleAdminSocialConnect } from "./social-connect-handlers";
import { createShadowRunHandler } from "./content-shadow-handlers";

function call(handler: (req: any, res: any) => unknown, req: Record<string, unknown>) {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    setHeader: () => res,
    status: (n: number) => ((out.status = n), res),
    json: (b: unknown) => ((out.body = b), res),
  } as unknown as VercelResponse;
  return Promise.resolve(
    handler({ headers: {}, query: {}, ...req } as VercelRequest, res),
  ).then(() => out);
}

beforeEach(() => {
  fake.capability.mockReset();
  fake.capability.mockResolvedValue({ userId: "11111111-1111-4111-8111-111111111111" });
  vi.stubEnv("VITE_SUPABASE_URL", "https://rkqeqbqwdswhpzwqptac.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture");
});
afterEach(() => vi.unstubAllEnvs());

describe("conexión de Instagram/TikTok (administración)", () => {
  const connect = (provider: string) =>
    call(handleAdminSocialConnect, {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
  it("desactivadas → 503 con la función no disponible, para ambos proveedores", async () => {
    vi.stubEnv("MINA_FEATURES_ENABLED", "");
    for (const provider of ["instagram", "tiktok"]) {
      const r = await connect(provider);
      expect(r.status).toBe(503);
      expect(r.body).toEqual(FEATURE_UNAVAILABLE_BODY);
    }
  });
  it("reactivada solo una: la otra sigue bloqueada y la activa vuelve a su lógica original", async () => {
    vi.stubEnv("MINA_FEATURES_ENABLED", "tiktok");
    expect((await connect("instagram")).body).toEqual(FEATURE_UNAVAILABLE_BODY);
    const r = await connect("tiktok");
    expect(r.body).not.toEqual(FEATURE_UNAVAILABLE_BODY); // sigue su camino normal (p. ej. «no disponible en este entorno»)
  });
});

describe("subida de medios de Cosplay", () => {
  const reserve = (domain: string) =>
    call(handleMediaReserve, {
      method: "POST",
      body: JSON.stringify({ domain, kind: "image", mime: "image/jpeg", bytes: 1000 }),
    });
  it("desactivada → 503 sin pedir la capacidad cosplay_admin ni crear nada", async () => {
    vi.stubEnv("MINA_FEATURES_ENABLED", "");
    const r = await reserve("cosplay");
    expect(r.status).toBe(503);
    expect(r.body).toEqual(FEATURE_UNAVAILABLE_BODY);
    expect(fake.capability).not.toHaveBeenCalled();
  });
  it("activada → vuelve a exigir la autorización original (cosplay_admin)", async () => {
    vi.stubEnv("MINA_FEATURES_ENABLED", "cosplay");
    await reserve("cosplay");
    expect(fake.capability).toHaveBeenCalledWith(expect.anything(), "cosplay_admin");
  });
});

describe("procesamiento shadow con IA", () => {
  it("con CONTENT_SHADOW_RUN_ENABLED distinto de true el endpoint no ejecuta nada (503)", async () => {
    const run = vi.fn();
    const handler = createShadowRunHandler(run as never);
    for (const value of ["false", "", "TRUE", "1"]) {
      vi.stubEnv("CONTENT_SHADOW_RUN_ENABLED", value);
      const r = await call(handler, { method: "POST", body: { limit: 1 } });
      expect(r.status).toBe(503);
    }
    vi.stubEnv("CONTENT_SHADOW_RUN_ENABLED", undefined as never);
    expect((await call(handler, { method: "POST", body: { limit: 1 } })).status).toBe(
      503,
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("sin sesión developer no se ejecuta aunque esté habilitado", async () => {
    const { AdminAuthError } = await import("./admin-auth");
    fake.capability.mockRejectedValue(new AdminAuthError("No autenticado", 401));
    vi.stubEnv("CONTENT_SHADOW_RUN_ENABLED", "true");
    const run = vi.fn();
    expect(
      (
        await call(createShadowRunHandler(run as never), {
          method: "POST",
          body: { limit: 1 },
        })
      ).status,
    ).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
});
