import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMediaUpload, type PrivilegedUploadSession } from "./useMediaUpload";
import { MediaClientError } from "@/lib/media-client";

const f = vi.hoisted(() => ({
  reserve: vi.fn(),
  put: vi.fn(),
  complete: vi.fn(),
  abort: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("@/lib/media-client", async () => ({
  ...(await vi.importActual("@/lib/media-client")),
  reserveMediaUpload: (...args: unknown[]) => f.reserve(...args),
  uploadWithProgress: (...args: unknown[]) => f.put(...args),
  completeMediaUpload: (...args: unknown[]) => f.complete(...args),
  abortMediaUpload: (...args: unknown[]) => f.abort(...args),
}));
vi.mock("@/lib/media-transport", () => ({
  prepareUploadBlob: (...args: unknown[]) => f.prepare(...args),
}));
const mfaError = () =>
  new MediaClientError("MFA", 403, "step_up_required", "step_up_required");
const ready = { assetId: "asset", status: "ready", kind: "image", variants: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function session() {
  let blocked = false,
    active = true;
  const onStepUp = vi.fn(() => {
    blocked = true;
  });
  const identity: PrivilegedUploadSession = {
    userId: "owner",
    isActive: () => active,
    isCurrent: async () => active,
    isBlocked: () => blocked,
    onStepUp,
  };
  return {
    identity,
    onStepUp,
    verified: () => {
      blocked = false;
    },
    block: () => {
      blocked = true;
    },
    logout: () => {
      active = false;
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  f.reserve.mockResolvedValue({
    assetId: "asset",
    mode: "single",
    uploadUrl: "https://upload.test/fixture",
    expiresInSeconds: 1,
  });
  f.put.mockResolvedValue({ etag: "etag" });
  f.complete.mockResolvedValue(ready);
  f.prepare.mockImplementation(async (file: File) => ({
    blob: file,
    mime: file.type,
    bytes: file.size,
    strategy: "original",
    width: null,
    height: null,
  }));
});
afterEach(cleanup);
function open() {
  const auth = session();
  const hook = renderHook(() =>
    useMediaUpload({
      domain: "cosplay",
      privilegedSession: auth.identity,
      concurrency: { prepare: 1, upload: 1 },
    }),
  );
  const file = new File(["0123456789"], "local.jpg", { type: "image/jpeg" });
  return {
    ...hook,
    auth,
    file,
    add: () =>
      act(() => {
        hook.result.current.addFiles([file]);
      }),
  };
}
it.each(["single", "multipart"])(
  "%s complete checkpoint preserves identity, bytes and ETags; retry is explicit and deduplicated",
  async (mode) => {
    if (mode === "multipart")
      f.reserve.mockResolvedValue({
        assetId: "asset",
        mode: "multipart",
        uploadId: "upload",
        partSize: 5,
        parts: [
          { partNumber: 1, url: "https://upload.test/1" },
          { partNumber: 2, url: "https://upload.test/2" },
        ],
        expiresInSeconds: 1,
      });
    f.complete.mockRejectedValueOnce(mfaError());
    const h = open();
    h.add();
    await waitFor(() =>
      expect(h.result.current.items[0]?.privilegedFailure).toBe("step_up_required"),
    );
    const before = h.result.current.items[0]!;
    expect(before.assetId).toBe("asset");
    expect(before.uploadedBytes).toBe(mode === "multipart" ? 10 : 0);
    const puts = f.put.mock.calls.length;
    h.auth.verified();
    await act(async () => {});
    expect(f.complete).toHaveBeenCalledTimes(1);
    const pending = deferred<typeof ready>();
    f.complete.mockReturnValueOnce(pending.promise);
    act(() => {
      h.result.current.retry(before.localId);
      h.result.current.retry(before.localId);
    });
    await waitFor(() => expect(f.complete).toHaveBeenCalledTimes(2));
    expect(f.complete.mock.calls[1]![0]).toEqual(f.complete.mock.calls[0]![0]);
    expect(f.complete.mock.calls[1]![0]).toEqual(
      mode === "single"
        ? { assetId: "asset" }
        : {
            assetId: "asset",
            parts: [
              { partNumber: 1, etag: "etag" },
              { partNumber: 2, etag: "etag" },
            ],
          },
    );
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.put).toHaveBeenCalledTimes(puts);
    expect(f.prepare.mock.calls[0]![0]).toBe(h.file);
    await act(async () => pending.resolve(ready));
    await waitFor(() => expect(h.result.current.items[0]?.status).toBe("ready"));
    expect(f.abort).not.toHaveBeenCalled();
  },
);
it("reserve MFA failure preserves File and reserves only after explicit retry", async () => {
  f.reserve.mockRejectedValueOnce(mfaError());
  const h = open();
  h.add();
  await waitFor(() => expect(h.result.current.items[0]?.status).toBe("failed"));
  expect(h.result.current.items[0]?.assetId).toBeNull();
  expect(f.put).not.toHaveBeenCalled();
  h.auth.verified();
  expect(f.reserve).toHaveBeenCalledTimes(1);
  act(() => h.result.current.retry(h.result.current.items[0]!.localId));
  await waitFor(() => expect(h.result.current.items[0]?.status).toBe("ready"));
  expect(f.reserve).toHaveBeenCalledTimes(2);
  expect(f.prepare.mock.calls[1]![0]).toBe(h.file);
  expect(f.put).toHaveBeenCalledTimes(1);
});
it.each(["processing_failed", "network", "upload"])(
  "real %s retains full generic retry semantics",
  async (kind) => {
    if (kind === "processing_failed")
      f.complete.mockResolvedValueOnce({
        assetId: "asset",
        status: "failed",
        failureCode: kind,
      });
    if (kind === "network")
      f.complete.mockRejectedValueOnce(new MediaClientError("Network failure"));
    if (kind === "upload")
      f.put.mockRejectedValueOnce(new MediaClientError("Upload failure"));
    const h = open();
    h.add();
    await waitFor(() => expect(h.result.current.items[0]?.status).toBe("failed"));
    expect(h.auth.onStepUp).not.toHaveBeenCalled();
    act(() => h.result.current.retry(h.result.current.items[0]!.localId));
    await waitFor(() => expect(h.result.current.items[0]?.status).toBe("ready"));
    expect(f.reserve).toHaveBeenCalledTimes(2);
    expect(f.put).toHaveBeenCalledTimes(2);
    expect(f.prepare.mock.calls[1]![0]).toBe(h.file);
  },
);
it("in-flight PUT finishes while MFA blocks complete; explicit retry uses uploaded checkpoint", async () => {
  const pending = deferred<{ etag: string }>();
  f.put.mockReturnValueOnce(pending.promise);
  const h = open();
  h.add();
  await waitFor(() => expect(f.put).toHaveBeenCalledTimes(1));
  h.auth.block();
  await act(async () => pending.resolve({ etag: "etag" }));
  await waitFor(() =>
    expect(h.result.current.items[0]?.privilegedFailure).toBe("step_up_required"),
  );
  expect(f.complete).not.toHaveBeenCalled();
  h.auth.verified();
  act(() => h.result.current.retry(h.result.current.items[0]!.localId));
  await waitFor(() => expect(h.result.current.items[0]?.status).toBe("ready"));
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(f.put).toHaveBeenCalledTimes(1);
});
it("queued reservations stop during MFA and never resume automatically", async () => {
  const h = open();
  h.auth.block();
  h.add();
  await waitFor(() => expect(h.result.current.items[0]?.status).toBe("failed"));
  expect(f.reserve).not.toHaveBeenCalled();
  h.auth.verified();
  await act(async () => {});
  expect(f.reserve).not.toHaveBeenCalled();
});
it("identity change after a successful reservation prevents PUT and complete", async () => {
  const pending = deferred<{ assetId: string; mode: string; uploadUrl: string }>();
  f.reserve.mockReturnValueOnce(pending.promise);
  const h = open();
  h.add();
  await waitFor(() => expect(f.reserve).toHaveBeenCalled());
  h.auth.logout();
  await act(async () =>
    pending.resolve({
      assetId: "asset",
      mode: "single",
      uploadUrl: "https://upload.test/fixture",
    }),
  );
  expect(f.put).not.toHaveBeenCalled();
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.abort).not.toHaveBeenCalled();
});
it("identity change during PUT prevents complete and later retry under another identity", async () => {
  const pending = deferred<{ etag: string }>();
  f.put.mockReturnValueOnce(pending.promise);
  const h = open();
  h.add();
  await waitFor(() => expect(f.put).toHaveBeenCalled());
  h.auth.logout();
  await act(async () => pending.resolve({ etag: "etag" }));
  act(() => h.result.current.retry(h.result.current.items[0]!.localId));
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(f.abort).not.toHaveBeenCalled();
});
it("release is still local only after confirmed persistence", async () => {
  const h = open();
  h.add();
  await waitFor(() => expect(h.result.current.items[0]?.status).toBe("ready"));
  act(() => h.result.current.release(h.result.current.items[0]!.localId));
  expect(h.result.current.items).toEqual([]);
  expect(f.abort).not.toHaveBeenCalled();
});
