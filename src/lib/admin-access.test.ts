import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cliente de GET /api/admin/access (Fase 9G-3): validación defensiva de la respuesta (forma
// inesperada = sin acceso) y comportamiento de fetchAdminAccess. No autoriza nada.

const supabaseFakes = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: supabaseFakes.getSession } },
}));

import { AdminAccessError, fetchAdminAccess, parseAdminAccess } from "./admin-access";

const ALL = ["moderation", "technical", "social_admin", "team_admin"];

describe("parseAdminAccess", () => {
  it("ADMIN con todas las capacidades y MFA reciente", () => {
    expect(
      parseAdminAccess({ role: "admin", capabilities: ALL, mfa: { recent: true } }),
    ).toEqual({ role: "admin", capabilities: ALL, mfaRecent: true });
  });

  it.each(["admin", "moderator", "developer"])("rol %s válido", (role) => {
    expect(
      parseAdminAccess({ role, capabilities: [], mfa: { recent: false } })?.role,
    ).toBe(role);
  });

  it("USER: role null y sin capacidades", () => {
    expect(
      parseAdminAccess({ role: null, capabilities: [], mfa: { recent: false } }),
    ).toEqual({
      role: null,
      capabilities: [],
      mfaRecent: false,
    });
  });

  it("USER con MFA reciente sigue siendo role null (MFA no concede rol)", () => {
    expect(
      parseAdminAccess({ role: null, capabilities: [], mfa: { recent: true } }),
    ).toEqual({
      role: null,
      capabilities: [],
      mfaRecent: true,
    });
  });

  it("ignora capacidades desconocidas sin fallar", () => {
    expect(
      parseAdminAccess({
        role: "admin",
        capabilities: ["team_admin", "cosplay_admin", "root"],
        mfa: { recent: true },
      })?.capabilities,
    ).toEqual(["team_admin"]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "admin"],
    ["número", 1],
    ["array", []],
    ["objeto vacío", {}],
    ["sin role", { capabilities: [], mfa: { recent: true } }],
    ["role undefined", { role: undefined, capabilities: [], mfa: { recent: true } }],
    ["rol desconocido", { role: "superadmin", capabilities: [], mfa: { recent: true } }],
    ["rol en mayúsculas", { role: "ADMIN", capabilities: [], mfa: { recent: true } }],
    ["rol no string", { role: 1, capabilities: [], mfa: { recent: true } }],
    ["sin capabilities", { role: "admin", mfa: { recent: true } }],
    [
      "capabilities no array",
      { role: "admin", capabilities: "team_admin", mfa: { recent: true } },
    ],
    [
      "capabilities con no-strings",
      { role: "admin", capabilities: [{ team_admin: true }], mfa: { recent: true } },
    ],
    ["sin mfa", { role: "admin", capabilities: [] }],
    ["mfa null", { role: "admin", capabilities: [], mfa: null }],
    ["mfa array", { role: "admin", capabilities: [], mfa: [] }],
    ["mfa.recent ausente", { role: "admin", capabilities: [], mfa: {} }],
    ["mfa.recent string", { role: "admin", capabilities: [], mfa: { recent: "true" } }],
    ["mfa.recent número", { role: "admin", capabilities: [], mfa: { recent: 1 } }],
    [
      "USER con capacidades conocidas",
      { role: null, capabilities: ["team_admin"], mfa: { recent: true } },
    ],
  ])("forma inesperada (%s) → null (fail closed)", (_n, body) => {
    expect(parseAdminAccess(body)).toBeNull();
  });

  it("nunca deriva acceso de campos extra (p. ej. isAdmin/aal/amr)", () => {
    expect(
      parseAdminAccess({
        role: null,
        capabilities: [],
        mfa: { recent: false },
        isAdmin: true,
        aal: "aal2",
        amr: [{ method: "totp", timestamp: 1 }],
      }),
    ).toEqual({ role: null, capabilities: [], mfaRecent: false });
  });
});

describe("fetchAdminAccess", () => {
  beforeEach(() => {
    supabaseFakes.getSession.mockReset();
    supabaseFakes.getSession.mockResolvedValue({
      data: { session: { access_token: "at-1" } },
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const okBody = { role: "admin", capabilities: ALL, mfa: { recent: true } };
  const okResponse = (body: unknown = okBody) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });

  async function kindOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(AdminAccessError);
      return (err as AdminAccessError).kind;
    }
    return "resolved";
  }

  it("GET /api/admin/access con el Bearer vigente, sin caché y sin cuerpo", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okResponse());

    const access = await fetchAdminAccess();

    expect(access).toEqual({ role: "admin", capabilities: ALL, mfaRecent: true });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/admin/access");
    expect(init.headers).toEqual({ Authorization: "Bearer at-1" });
    expect(init.cache).toBe("no-store");
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("lee el token de la sesión en CADA llamada (tras un MFA o refresh el token es otro)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okResponse());
    await fetchAdminAccess();
    supabaseFakes.getSession.mockResolvedValue({
      data: { session: { access_token: "at-2" } },
    });
    await fetchAdminAccess();

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1].headers,
    );
    expect(headers).toEqual([
      { Authorization: "Bearer at-1" },
      { Authorization: "Bearer at-2" },
    ]);
  });

  it("sin token en la sesión → unauthenticated, sin llamar a la API", async () => {
    supabaseFakes.getSession.mockResolvedValue({ data: { session: null } });

    expect(await kindOf(fetchAdminAccess())).toBe("unauthenticated");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("getSession() lanza → error genérico, sin llamar a la API ni filtrar el motivo", async () => {
    supabaseFakes.getSession.mockRejectedValue(new Error("detalle interno"));

    const promise = fetchAdminAccess();
    expect(await kindOf(promise)).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("401 → unauthenticated", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    expect(await kindOf(fetchAdminAccess())).toBe("unauthenticated");
  });

  it.each([403, 404, 500, 503])("status %i → error", async (code) => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: code,
      json: async () => ({}),
    });
    expect(await kindOf(fetchAdminAccess())).toBe("error");
  });

  it("fallo de red → error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError("red"));
    expect(await kindOf(fetchAdminAccess())).toBe("error");
  });

  it.each([
    ["cuerpo ilegible", async () => Promise.reject(new Error("x"))],
    ["cuerpo no válido", async () => ({ role: "root" })],
    ["cuerpo vacío", async () => null],
  ])("200 con %s → error (fail closed)", async (_n, json) => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json,
    });
    expect(await kindOf(fetchAdminAccess())).toBe("error");
  });

  it("el error nunca contiene el token ni detalles del servidor", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "detalle at-1 interno" }),
    });
    try {
      await fetchAdminAccess();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("at-1");
      expect(String((err as Error).message)).not.toContain("interno");
    }
  });
});
