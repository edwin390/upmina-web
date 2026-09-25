import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";

// Hook de acceso (Fase 9G-3): caché de TanStack Query LIGADA al usuario, no autoridad. Sin sesión
// no consulta ni expone datos; al cambiar de usuario o cerrar sesión no se reutiliza el estado
// del anterior; una revalidación (refetch/invalidate) vuelve a preguntar al servidor.

const authFakes = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string } },
  loading: false,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: async () => undefined,
  }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: authFakes.session } }),
    },
  },
}));

import { adminAccessQueryKey, useAdminAccess } from "./useAdminAccess";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={testQueryClient}>{children}</QueryClientProvider>
);

const accessBody = (role: string | null, recent = true) => ({
  ok: true,
  status: 200,
  json: async () => ({
    role,
    capabilities: role === "admin" ? ["team_admin"] : [],
    mfa: { recent },
  }),
});

function session(userId: string, token = `at-${userId}`) {
  return { access_token: token, user: { id: userId } };
}

beforeEach(() => {
  testQueryClient.clear();
  authFakes.session = null;
  authFakes.loading = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => accessBody("admin")),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useAdminAccess — estados", () => {
  it("mientras la sesión carga → loading, sin consultar", () => {
    authFakes.loading = true;
    authFakes.session = session("u1");
    const { result } = renderHook(() => useAdminAccess(), { wrapper });

    expect(result.current.status).toBe("loading");
    expect(result.current.access).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sin sesión → no-session, sin consultar y sin exponer nada", () => {
    const { result } = renderHook(() => useAdminAccess(), { wrapper });

    expect(result.current.status).toBe("no-session");
    expect(result.current.access).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("con sesión: loading → ready con el acceso validado", async () => {
    authFakes.session = session("u1");
    const { result } = renderHook(() => useAdminAccess(), { wrapper });

    expect(result.current.status).toBe("loading");
    expect(result.current.access).toBeNull(); // sin datos optimistas
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.access).toEqual({
      role: "admin",
      capabilities: ["team_admin"],
      mfaRecent: true,
    });
  });

  it("401 del servidor → unauthenticated (hay sesión local pero no es válida)", async () => {
    authFakes.session = session("u1");
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const { result } = renderHook(() => useAdminAccess(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
    expect(result.current.access).toBeNull();
  });

  it.each([
    ["500", { ok: false, status: 500, json: async () => ({}) }],
    ["cuerpo inválido", { ok: true, status: 200, json: async () => ({ role: "root" }) }],
  ])("%s → error (fail closed), sin acceso", async (_n, response) => {
    authFakes.session = session("u1");
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(response);
    const { result } = renderHook(() => useAdminAccess(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.access).toBeNull();
  });

  it("no reintenta solo ante un error de autenticación/red (una única petición)", async () => {
    authFakes.session = session("u1");
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError("red"));
    const { result } = renderHook(() => useAdminAccess(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("error"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("useAdminAccess — la caché está ligada al usuario", () => {
  it("la clave incluye el user.id", async () => {
    authFakes.session = session("u1");
    const { result } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(adminAccessQueryKey("u1")).toEqual(["admin-access", "u1"]);
    expect(testQueryClient.getQueryData(adminAccessQueryKey("u1"))).toBeTruthy();
    expect(testQueryClient.getQueryData(adminAccessQueryKey("u2"))).toBeUndefined();
  });

  it("cambio de usuario A → B: nunca se ve el acceso de A y se elimina su entrada", async () => {
    authFakes.session = session("uA");
    const { result, rerender } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.access?.role).toBe("admin");

    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      accessBody(null, false),
    );
    authFakes.session = session("uB");
    rerender();

    // En ningún render intermedio B ve el acceso de A.
    expect(result.current.access?.role).not.toBe("admin");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.access).toEqual({
      role: null,
      capabilities: [],
      mfaRecent: false,
    });
    expect(testQueryClient.getQueryData(adminAccessQueryKey("uA"))).toBeUndefined();
  });

  it("cerrar sesión: el hook deja de exponer datos y descarta la entrada del usuario anterior", async () => {
    authFakes.session = session("uA");
    const { result, rerender } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    authFakes.session = null;
    rerender();

    expect(result.current.status).toBe("no-session");
    expect(result.current.access).toBeNull();
    await waitFor(() =>
      expect(testQueryClient.getQueryData(adminAccessQueryKey("uA"))).toBeUndefined(),
    );
  });

  it("nada del estado se guarda en localStorage/sessionStorage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    authFakes.session = session("u1");
    const { result } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    setItem.mockRestore();
  });
});

describe("useAdminAccess — revalidación", () => {
  it("refetch() vuelve a preguntar al servidor y devuelve el acceso nuevo", async () => {
    authFakes.session = session("u1");
    const { result } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetch).toHaveBeenCalledTimes(1);

    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      accessBody(null, false),
    );
    let refreshed: unknown;
    await act(async () => {
      refreshed = await result.current.refetch();
    });

    expect(refreshed).toEqual({ role: null, capabilities: [], mfaRecent: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.access?.role).toBeNull());
  });

  it("invalidate() (tras un 403 privilegiado) recarga el acceso: una revocación se refleja", async () => {
    authFakes.session = session("u1");
    const { result } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(result.current.access?.role).toBe("admin"));

    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      accessBody(null, true),
    );
    await act(async () => {
      await result.current.invalidate();
    });

    await waitFor(() => expect(result.current.access?.role).toBeNull());
    expect(result.current.status).toBe("ready");
  });

  it("refetch/invalidate son estables entre renders (seguros como dependencia de efectos)", async () => {
    authFakes.session = session("u1");
    const { result, rerender } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const { refetch, invalidate } = result.current;

    rerender();
    rerender();

    expect(result.current.refetch).toBe(refetch);
    expect(result.current.invalidate).toBe(invalidate);
  });

  it("recuperar el foco vuelve a comprobar el acceso cuando está obsoleto (revocación o MFA hecho en otra pestaña)", async () => {
    authFakes.session = session("u1");
    // staleTime corto real (15 s): se fuerza obsolescencia invalidando sin refetch activo.
    const { result } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetch).toHaveBeenCalledTimes(1);

    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      accessBody(null, true),
    );
    await act(async () => {
      await testQueryClient.invalidateQueries({
        queryKey: adminAccessQueryKey("u1"),
        refetchType: "none",
      });
      window.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(result.current.access?.role).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("la petición usa siempre el token vigente de la sesión", async () => {
    authFakes.session = session("u1", "token-vigente");
    const { result } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer token-vigente");
  });
});

describe("useAdminAccess — revisión final: respuesta tardía de otro usuario", () => {
  it("la respuesta de A que llega DESPUÉS del cambio a B no aparece para B ni queda en su clave", async () => {
    authFakes.session = session("uA");
    let releaseA: (v: unknown) => void = () => undefined;
    (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => (releaseA = resolve)),
    );
    const { result, rerender } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      accessBody(null, false),
    );
    authFakes.session = session("uB");
    rerender();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.access?.role).toBeNull();

    await act(async () => {
      releaseA(accessBody("admin", true));
      await new Promise((r) => setTimeout(r, 20));
    });

    const expected = { role: null, capabilities: [], mfaRecent: false };
    expect(result.current.access).toEqual(expected);
    expect(testQueryClient.getQueryData(adminAccessQueryKey("uB"))).toEqual(expected);
  });

  it("si la sesión de Supabase ya es de otra persona, NO se pide el acceso con su token (sin fetch)", async () => {
    authFakes.session = session("uA");
    const { result } = renderHook(() => useAdminAccess(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    (fetch as ReturnType<typeof vi.fn>).mockClear();

    // El contexto sigue diciendo uA, pero la sesión real de Supabase ya es de uC.
    const contextSession = authFakes.session;
    authFakes.session = session("uC");
    await act(async () => {
      await result.current.refetch();
    });
    authFakes.session = contextSession;

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("useAdminAccess — opción enabled", () => {
  it("enabled:false con sesión → no consulta y no expone acceso", async () => {
    authFakes.session = session("u1");
    const { result } = renderHook(() => useAdminAccess({ enabled: false }), { wrapper });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.access).toBeNull();
    expect(result.current.status).not.toBe("ready");
  });

  it("enabled por defecto (true) consulta como siempre", async () => {
    authFakes.session = session("u1");
    const { result } = renderHook(() => useAdminAccess({ fresh: true }), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
