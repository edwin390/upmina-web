import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useOwnCommunityPosts } from "./useOwnCommunityPosts";
const mocks = vi.hoisted(() => ({ read: vi.fn(), session: true, userId: "owner" }));
vi.mock("@/lib/community-client", () => ({ listOwnCommunityPosts: mocks.read }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: mocks.session ? { id: mocks.userId } : null,
    session: mocks.session ? {} : null,
    loading: false,
  }),
}));
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}
beforeEach(() => {
  mocks.read.mockReset();
  mocks.session = true;
  mocks.userId = "owner";
});
afterEach(cleanup);
it("signed-out private discovery does not read", () => {
  mocks.session = false;
  const { result } = renderHook(() => useOwnCommunityPosts(true), { wrapper });
  expect(result.current.data).toBeUndefined();
  expect(mocks.read).not.toHaveBeenCalled();
});
it("logout hides cached private rows immediately", async () => {
  mocks.read.mockResolvedValue({
    items: [{ id: "private", moderation: { deadline: null } }],
    serverNow: "2026-10-04T18:00:00Z",
  });
  const { result, rerender } = renderHook(() => useOwnCommunityPosts(true), { wrapper });
  await waitFor(() => expect(result.current.data).toHaveLength(1));
  mocks.session = false;
  rerender();
  expect(result.current.data).toBeUndefined();
});
it("invalid response stays an error, never a successful empty list", async () => {
  mocks.read.mockRejectedValue(new Error("invalid_response"));
  const { result } = renderHook(() => useOwnCommunityPosts(true), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
});
it("A to B isolates private cached rows before B read completes", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const persistentWrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  mocks.read
    .mockResolvedValueOnce({
      items: [{ id: "A-private", moderation: { deadline: null, message: "A-only" } }],
      serverNow: "2026-10-04T18:00:00Z",
    })
    .mockImplementation(() => new Promise(() => {}));
  const { result, rerender } = renderHook(() => useOwnCommunityPosts(true), {
    wrapper: persistentWrapper,
  });
  await waitFor(() => expect(result.current.data?.[0].id).toBe("A-private"));
  mocks.userId = "other-owner";
  rerender();
  expect(result.current.data).toBeUndefined();
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  expect(client.getQueryData(["community", "own-posts", "other-owner"])).toBeUndefined();
});
it("deadline evicts retained tiles and re-reads once without polling", async () => {
  mocks.read
    .mockResolvedValueOnce({
      items: [
        {
          id: "private",
          status: "removed_pending_purge",
          moderation: { deadline: "2026-10-04T18:00:00.250Z" },
        },
      ],
      serverNow: "2026-10-04T18:00:00Z",
    })
    .mockResolvedValue({ items: [], serverNow: "2026-10-04T18:00:01Z" });
  const { result } = renderHook(() => useOwnCommunityPosts(true), { wrapper });
  await waitFor(() => expect(result.current.data).toHaveLength(1));
  await waitFor(() => expect(result.current.data).toEqual([]));
  expect(mocks.read).toHaveBeenCalledTimes(2);
});
