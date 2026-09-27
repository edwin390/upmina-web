import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cliente del pipeline de medios (Fase 9I-2C): comprueba que postJson clasifica un rechazo
// 401/403 con la MISMA semántica 9G-3 (classifyPrivilegedFailure, ver privileged-response.ts) que
// ya usan las secciones de /admin — nunca inventa su propia lectura de `code`. Red y Supabase
// siempre mockeados: nunca golpea el backend real.

const supabaseFakes = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: supabaseFakes.getSession } },
}));

import { MediaClientError, reserveMediaUpload } from "./media-client";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() {
      return jsonResponse(status, body);
    },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  supabaseFakes.getSession.mockResolvedValue({
    data: { session: { access_token: "at-test" } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function reserveAndExpectRejection(): Promise<MediaClientError> {
  try {
    await reserveMediaUpload({
      domain: "cosplay",
      sourceMime: "image/jpeg",
      sourceBytes: 1,
    });
    throw new Error("debería haber lanzado");
  } catch (err) {
    if (!(err instanceof MediaClientError)) throw err;
    return err;
  }
}

describe("postJson — clasificación 9G-3 de rechazos privilegiados", () => {
  it("403 + code step_up_required → privilegedFailure = 'step_up_required'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(403, { error: "No autorizado", code: "step_up_required" }),
      ),
    );
    const err = await reserveAndExpectRejection();
    expect(err.status).toBe(403);
    expect(err.code).toBe("step_up_required");
    expect(err.privilegedFailure).toBe("step_up_required");
  });

  it("403 genérico (sin capacidad, sin code) → privilegedFailure = 'forbidden', NUNCA step_up_required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: "No autorizado" })),
    );
    const err = await reserveAndExpectRejection();
    expect(err.privilegedFailure).toBe("forbidden");
  });

  it("401 → privilegedFailure = 'unauthenticated'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "No autenticado" })),
    );
    const err = await reserveAndExpectRejection();
    expect(err.privilegedFailure).toBe("unauthenticated");
  });

  it("un fallo de negocio normal (400/500) no es un rechazo de autorización: privilegedFailure = null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { error: "Error interno" })),
    );
    const err = await reserveAndExpectRejection();
    expect(err.privilegedFailure).toBeNull();
  });

  it("una respuesta ok nunca pasa por la clasificación (no se llama a response.clone innecesariamente en éxito)", async () => {
    const cloneSpy = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        clone: cloneSpy,
        json: async () => ({
          assetId: "a",
          mode: "single",
          uploadUrl: "u",
          expiresInSeconds: 1,
        }),
      })),
    );
    await reserveMediaUpload({
      domain: "cosplay",
      sourceMime: "image/jpeg",
      sourceBytes: 1,
    });
    expect(cloneSpy).not.toHaveBeenCalled();
  });
});
