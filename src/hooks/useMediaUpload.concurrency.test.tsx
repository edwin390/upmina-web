import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  DESKTOP_CONCURRENCY,
  MOBILE_CONCURRENCY,
  useMediaUpload,
} from "./useMediaUpload";

// Wiring real de concurrencia por dispositivo (fix tras el gate 9I-2B+9I-2C): MOBILE_CONCURRENCY
// existía como constante pero NINGÚN caller la aplicaba nunca — el arnés real usó
// DESKTOP_CONCURRENCY incluso desde un iPhone físico. Este archivo prueba el WIRING real: que
// useMediaUpload, sin `concurrency` explícito, consulta isMobileUploadDevice() (mockeada, nunca
// user-agent real) y que el límite resultante se respeta de verdad en el scheduler
// (createLimiter) — no solo que las constantes existan con los valores correctos.

const deviceFakes = vi.hoisted(() => ({ isMobile: false }));
vi.mock("@/lib/media-device", () => ({
  isMobileUploadDevice: () => deviceFakes.isMobile,
}));

const reserveMediaUploadMock = vi.fn();
const completeMediaUploadMock = vi.fn();
const uploadWithProgressMock = vi.fn();
vi.mock("@/lib/media-client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/media-client")>("@/lib/media-client");
  return {
    ...actual,
    reserveMediaUpload: (...args: unknown[]) => reserveMediaUploadMock(...args),
    completeMediaUpload: (...args: unknown[]) => completeMediaUploadMock(...args),
    uploadWithProgress: (...args: unknown[]) => uploadWithProgressMock(...args),
  };
});

// prepareUploadBlob controlado a mano: la promesa NO se resuelve hasta que el test llame al
// resolver correspondiente, así se puede observar exactamente cuántas llamadas están "en vuelo" a
// la vez, en lugar de solo confiar en que las constantes tengan el valor esperado.
let activeCalls = 0;
let resolvers: Array<() => void> = [];
const prepareUploadBlobMock = vi.fn(
  (file: File, _dimensions: unknown) =>
    new Promise((resolve) => {
      activeCalls += 1;
      resolvers.push(() => {
        activeCalls -= 1;
        resolve({
          blob: file,
          mime: file.type,
          bytes: file.size,
          strategy: "original",
          width: null,
          height: null,
        });
      });
    }),
);
vi.mock("@/lib/media-transport", () => ({
  prepareUploadBlob: (...args: [File, unknown]) =>
    prepareUploadBlobMock(args[0], args[1]),
}));

function fakeFile(name: string, bytes = 1000): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
}

function resolveNext() {
  const next = resolvers.shift();
  if (!next) throw new Error("no hay llamada pendiente que resolver");
  next();
}

beforeEach(() => {
  deviceFakes.isMobile = false;
  activeCalls = 0;
  resolvers = [];
  reserveMediaUploadMock.mockResolvedValue({
    assetId: "asset-x",
    mode: "single",
    uploadUrl: "https://r2.test/put",
    expiresInSeconds: 900,
  });
  uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
  completeMediaUploadMock.mockResolvedValue({
    assetId: "asset-x",
    status: "ready",
    variants: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useMediaUpload — selección real de concurrencia por dispositivo", () => {
  it("desktop (isMobileUploadDevice=false): el scheduler nunca deja más de DESKTOP_CONCURRENCY.prepare en vuelo", async () => {
    deviceFakes.isMobile = false;
    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));

    act(() => {
      result.current.addFiles([fakeFile("a.jpg"), fakeFile("b.jpg"), fakeFile("c.jpg")]);
    });

    await waitFor(() =>
      expect(prepareUploadBlobMock).toHaveBeenCalledTimes(DESKTOP_CONCURRENCY.prepare),
    );
    // La 3ª llamada real NUNCA arranca mientras solo haya 2 huecos disponibles.
    expect(activeCalls).toBe(DESKTOP_CONCURRENCY.prepare);

    await act(async () => resolveNext());
    await waitFor(() => expect(prepareUploadBlobMock).toHaveBeenCalledTimes(3));
    await act(async () => {
      resolveNext();
      resolveNext();
    });
  });

  it("móvil (isMobileUploadDevice=true): el MISMO hook limita el scheduler real a MOBILE_CONCURRENCY.prepare = 1", async () => {
    deviceFakes.isMobile = true;
    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));

    act(() => {
      result.current.addFiles([fakeFile("a.jpg"), fakeFile("b.jpg")]);
    });

    await waitFor(() =>
      expect(prepareUploadBlobMock).toHaveBeenCalledTimes(MOBILE_CONCURRENCY.prepare),
    );
    expect(activeCalls).toBe(1);
    expect(prepareUploadBlobMock).not.toHaveBeenCalledTimes(2);

    await act(async () => resolveNext());
    await waitFor(() => expect(prepareUploadBlobMock).toHaveBeenCalledTimes(2));
    await act(async () => resolveNext());
  });

  it("un `concurrency` explícito del caller gana sobre la detección automática de dispositivo", async () => {
    deviceFakes.isMobile = true; // la detección diría móvil (1), pero el caller fuerza 2
    const { result } = renderHook(() =>
      useMediaUpload({ domain: "cosplay", concurrency: { prepare: 2, upload: 3 } }),
    );

    act(() => {
      result.current.addFiles([fakeFile("a.jpg"), fakeFile("b.jpg")]);
    });

    await waitFor(() => expect(prepareUploadBlobMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveNext();
      resolveNext();
    });
  });

  it("con concurrencia móvil, el camino feliz sigue llegando a ready (la detección no rompe la subida)", async () => {
    deviceFakes.isMobile = true;
    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));

    act(() => {
      result.current.addFiles([fakeFile("a.jpg")]);
    });
    await waitFor(() => expect(prepareUploadBlobMock).toHaveBeenCalledTimes(1));
    await act(async () => resolveNext());

    await waitFor(() => expect(result.current.items[0]!.status).toBe("ready"));
  });
});
