import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { usePrivilegedEntry } from "./usePrivilegedEntry";

const fake = vi.hoisted(() => ({ refetch: vi.fn() }));
vi.mock("@/hooks/useAdminAccess", () => ({
  useAdminAccess: () => ({ refetch: fake.refetch }),
}));
function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}
beforeEach(() => vi.resetAllMocks());

it("a rejected access request releases the pending lock and permits an explicit retry", async () => {
  let reject!: (error: Error) => void;
  fake.refetch.mockImplementationOnce(
    () =>
      new Promise((_done, fail) => {
        reject = fail;
      }),
  );
  const ready = vi.fn();
  const { result } = renderHook(() => usePrivilegedEntry(), { wrapper });
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.enter("/cosplay?intent=create", ready);
  });
  expect(result.current.isEntering).toBe(true);
  await act(async () => {
    reject(new Error("network"));
    await pending;
  });
  expect(result.current.isEntering).toBe(false);
  expect(ready).not.toHaveBeenCalled();
  fake.refetch.mockResolvedValueOnce({ mfaRecent: true });
  await act(async () => {
    await result.current.enter("/cosplay?intent=create", ready);
  });
  expect(ready).toHaveBeenCalledTimes(1);
});

it.each([true, false, null])(
  "real unresolved access is pending, deduplicated, and clears on outcome=%s",
  async (recent) => {
    let resolve!: (value: unknown) => void;
    fake.refetch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const ready = vi.fn();
    const { result } = renderHook(() => usePrivilegedEntry(), { wrapper });
    expect(result.current.isEntering).toBe(false);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.enter("/cosplay?intent=create", ready);
      void result.current.enter("/cosplay?intent=create", ready);
    });
    expect(result.current.isEntering).toBe(true);
    expect(result.current.enteringTarget).toBe("/cosplay?intent=create");
    expect(fake.refetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(recent === null ? null : { mfaRecent: recent });
      await pending;
    });
    await waitFor(() => expect(result.current.isEntering).toBe(false));
    expect(result.current.enteringTarget).toBeNull();
    expect(ready).toHaveBeenCalledTimes(recent ? 1 : 0);
  },
);
