import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";

// Fase 9J-2C: estado privado de "¿dio like el usuario ACTUAL?" para un lote de publicaciones —
// deliberadamente separado de los datos públicos (feed/perfil/detalle). Visitante: siempre vacío,
// sin consultar el backend.

const authFakes = vi.hoisted(() => ({
  session: null as { access_token: string; user: { id: string } } | null,
  loading: false,
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: vi.fn(),
  }),
}));

const clientFakes = vi.hoisted(() => ({
  calls: [] as string[][],
  result: { likedPostIds: [] as string[] },
}));
vi.mock("@/lib/community-client", () => ({
  fetchCommunityLikedByMe: async (postIds: string[]) => {
    clientFakes.calls.push(postIds);
    return clientFakes.result;
  },
}));

const { useCommunityLikedByMe } = await import("./useCommunityLikedByMe");

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={testQueryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  testQueryClient.clear();
  authFakes.session = null;
  authFakes.loading = false;
  clientFakes.calls = [];
  clientFakes.result = { likedPostIds: [] };
});

afterEach(() => {
  cleanup();
});

describe("useCommunityLikedByMe", () => {
  it("visitante (sin sesión): Set vacío, sin consultar el backend", async () => {
    const { result } = renderHook(() => useCommunityLikedByMe(["p1", "p2"]), { wrapper });
    expect(result.current.likedByMe).toEqual(new Set());
    expect(clientFakes.calls).toHaveLength(0);
  });

  it("postIds vacío: no consulta el backend aunque haya sesión", async () => {
    authFakes.session = { access_token: "t", user: { id: "u1" } };
    renderHook(() => useCommunityLikedByMe([]), { wrapper });
    await new Promise((r) => setTimeout(r, 0));
    expect(clientFakes.calls).toHaveLength(0);
  });

  it("con sesión: consulta el backend y expone un Set con los postId con like propio", async () => {
    authFakes.session = { access_token: "t", user: { id: "u1" } };
    clientFakes.result = { likedPostIds: ["p1"] };
    const { result } = renderHook(() => useCommunityLikedByMe(["p1", "p2"]), { wrapper });
    await waitFor(() => expect(result.current.likedByMe).toEqual(new Set(["p1"])));
  });

  it("deduplica postIds antes de consultar", async () => {
    authFakes.session = { access_token: "t", user: { id: "u1" } };
    renderHook(() => useCommunityLikedByMe(["p1", "p1", "p2"]), { wrapper });
    await waitFor(() => expect(clientFakes.calls).toHaveLength(1));
    expect(clientFakes.calls[0]).toEqual(["p1", "p2"]);
  });
});
