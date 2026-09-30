import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";

const authFakes = vi.hoisted(() => ({
  session: null as { access_token: string; user: { id: string } } | null,
  user: null as { id: string } | null,
  loading: false,
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.user,
    loading: authFakes.loading,
    signOut: vi.fn(),
  }),
}));

const supabaseFakes = vi.hoisted(() => ({
  row: null as {
    username: string;
    display_name: string | null;
    bio: string | null;
  } | null,
  error: null as unknown,
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`tabla inesperada: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: supabaseFakes.row,
              error: supabaseFakes.error,
            }),
          }),
        }),
      };
    },
  },
}));

const { useOwnProfile } = await import("./useOwnProfile");

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={testQueryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  testQueryClient.clear();
  authFakes.session = null;
  authFakes.user = null;
  authFakes.loading = false;
  supabaseFakes.row = null;
  supabaseFakes.error = null;
});

afterEach(() => {
  cleanup();
});

describe("useOwnProfile", () => {
  it("sin sesión: profile null, sin consultar Supabase", async () => {
    const { result } = renderHook(() => useOwnProfile(), { wrapper });
    expect(result.current.profile).toBeNull();
    expect(result.current.hasSession).toBe(false);
  });

  it("con sesión y perfil configurado: expone username/displayName/bio", async () => {
    authFakes.session = { access_token: "t", user: { id: "u1" } };
    authFakes.user = { id: "u1" };
    supabaseFakes.row = { username: "edwin1", display_name: "Edwin", bio: "hola" };

    const { result } = renderHook(() => useOwnProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.profile).toEqual({
      username: "edwin1",
      displayName: "Edwin",
      bio: "hola",
    });
  });

  it("con sesión pero SIN perfil configurado: profile null (no un error)", async () => {
    authFakes.session = { access_token: "t", user: { id: "u1" } };
    authFakes.user = { id: "u1" };
    supabaseFakes.row = null;

    const { result } = renderHook(() => useOwnProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.profile).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("error de Supabase: isError true, nunca se interpreta como 'sin perfil'", async () => {
    authFakes.session = { access_token: "t", user: { id: "u1" } };
    authFakes.user = { id: "u1" };
    supabaseFakes.error = { message: "fallo" };

    const { result } = renderHook(() => useOwnProfile(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
