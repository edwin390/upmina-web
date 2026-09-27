import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useMediaUpload } from "./useMediaUpload";

// Cola de subida (Fase 9I-2B): se mockean media-client.ts (nunca red/R2 real) y
// media-transport.ts (su lógica de decisión ya está probada en media-transport.test.ts). Aquí
// solo importa la orquestación: estados, multipart, fallo, reintento, quitar de la cola.

const reserveMediaUploadMock = vi.fn();
const completeMediaUploadMock = vi.fn();
const abortMediaUploadMock = vi.fn();
const uploadWithProgressMock = vi.fn();

vi.mock("@/lib/media-client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/media-client")>("@/lib/media-client");
  return {
    ...actual,
    reserveMediaUpload: (...args: unknown[]) => reserveMediaUploadMock(...args),
    completeMediaUpload: (...args: unknown[]) => completeMediaUploadMock(...args),
    abortMediaUpload: (...args: unknown[]) => abortMediaUploadMock(...args),
    uploadWithProgress: (...args: unknown[]) => uploadWithProgressMock(...args),
  };
});

vi.mock("@/lib/media-transport", () => ({
  prepareUploadBlob: vi.fn(async (file: File) => ({
    blob: file,
    mime: file.type,
    bytes: file.size,
    strategy: "original",
    width: null,
    height: null,
  })),
}));

function fakeFile(name: string, bytes: number, mime = "image/jpeg"): File {
  return new File([new Uint8Array(bytes)], name, { type: mime });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useMediaUpload — camino feliz (single PUT)", () => {
  it("pasa por queued → preparing → uploading → uploaded → ready", async () => {
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-1",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    uploadWithProgressMock.mockImplementation(
      async (
        _url: string,
        _blob: Blob,
        _type: string,
        onProgress?: (l: number, t: number) => void,
      ) => {
        onProgress?.(1000, 1000);
        return { etag: '"etag-abc"' };
      },
    );
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-1",
      status: "ready",
      variants: [
        {
          variant: 480,
          width: 480,
          height: 384,
          bytes: 20000,
          url: "https://pub.test/w480.webp",
        },
      ],
    });

    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));

    act(() => {
      result.current.addFiles([fakeFile("mi-foto.jpg", 1000)]);
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]!.fileName).toBe("mi-foto.jpg");

    await waitFor(() => expect(result.current.items[0]!.status).toBe("ready"));
    expect(result.current.items[0]!.assetId).toBe("asset-1");
    expect(result.current.items[0]!.variants).toEqual([
      {
        variant: 480,
        width: 480,
        height: 384,
        bytes: 20000,
        url: "https://pub.test/w480.webp",
      },
    ]);
    expect(reserveMediaUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "cosplay",
        sourceMime: "image/jpeg",
        sourceBytes: 1000,
      }),
    );
  });

  it("nunca envía el nombre de archivo local como parte de la reserva", async () => {
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-2",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-2",
      status: "ready",
      variants: [],
    });

    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));
    act(() => {
      result.current.addFiles([
        fakeFile("nombre-privado-de-mina.heic", 500, "image/heic"),
      ]);
    });

    await waitFor(() => expect(result.current.items[0]!.status).toBe("ready"));
    const reserveArgs = reserveMediaUploadMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(reserveArgs)).not.toContain("nombre-privado-de-mina");
  });
});

describe("useMediaUpload — multipart", () => {
  it("sube cada parte con uploadWithProgress y completa con los ETags recogidos", async () => {
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-3",
      mode: "multipart",
      uploadId: "upload-xyz",
      partSize: 8 * 1024 * 1024,
      parts: [
        { partNumber: 1, url: "https://r2.test/part-1" },
        { partNumber: 2, url: "https://r2.test/part-2" },
      ],
      expiresInSeconds: 1800,
    });
    uploadWithProgressMock
      .mockResolvedValueOnce({ etag: '"etag-1"' })
      .mockResolvedValueOnce({ etag: '"etag-2"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-3",
      status: "ready",
      variants: [],
    });

    const bytes = 8 * 1024 * 1024 + 100;
    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));
    act(() => {
      result.current.addFiles([fakeFile("grande.jpg", bytes)]);
    });

    await waitFor(() => expect(result.current.items[0]!.status).toBe("ready"));
    expect(uploadWithProgressMock).toHaveBeenCalledTimes(2);
    expect(uploadWithProgressMock.mock.calls[0]![0]).toBe("https://r2.test/part-1");
    expect(uploadWithProgressMock.mock.calls[1]![0]).toBe("https://r2.test/part-2");
    expect(completeMediaUploadMock).toHaveBeenCalledWith({
      assetId: "asset-3",
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    });
  });
});

describe("useMediaUpload — fallo, reintento, quitar de la cola", () => {
  it("un fallo en reserve marca 'failed' con código/mensaje accionable", async () => {
    const { MediaClientError } = await import("@/lib/media-client");
    reserveMediaUploadMock.mockRejectedValue(
      new MediaClientError("cupo agotado", 400, "too_large"),
    );

    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));
    act(() => {
      result.current.addFiles([fakeFile("enorme.jpg", 999)]);
    });

    await waitFor(() => expect(result.current.items[0]!.status).toBe("failed"));
    expect(result.current.items[0]!.errorCode).toBe("too_large");
    expect(result.current.items[0]!.errorMessage).toBe("cupo agotado");
  });

  // Regresión (Fase 9I-2C): un 403 step_up_required real (MFA vencido con el arnés ya abierto)
  // debe propagar la clasificación 9G-3 tal cual, para que la página decida navegar a MFA — nunca
  // debe quedar como un simple string de error a mostrar sin más.
  it("un 403 step_up_required en reserve propaga privilegedFailure sin inventar un mensaje distinto", async () => {
    const { MediaClientError } = await import("@/lib/media-client");
    reserveMediaUploadMock.mockRejectedValue(
      new MediaClientError("No autorizado", 403, "step_up_required", "step_up_required"),
    );

    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));
    act(() => {
      result.current.addFiles([fakeFile("foto.jpg", 1000)]);
    });

    await waitFor(() => expect(result.current.items[0]!.status).toBe("failed"));
    expect(result.current.items[0]!.errorCode).toBe("step_up_required");
    expect(result.current.items[0]!.privilegedFailure).toBe("step_up_required");
  });

  // Un 403 genérico (sin capacidad) NUNCA debe clasificarse como step_up_required — MFA no
  // concede capacidad, así que este caso no debe poder iniciar un flujo de MFA.
  it("un 403 genérico (sin capacidad) se clasifica 'forbidden', nunca 'step_up_required'", async () => {
    const { MediaClientError } = await import("@/lib/media-client");
    reserveMediaUploadMock.mockRejectedValue(
      new MediaClientError("No autorizado", 403, undefined, "forbidden"),
    );

    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));
    act(() => {
      result.current.addFiles([fakeFile("foto.jpg", 1000)]);
    });

    await waitFor(() => expect(result.current.items[0]!.status).toBe("failed"));
    expect(result.current.items[0]!.privilegedFailure).toBe("forbidden");
  });

  it("un failureCode del servidor en complete también marca 'failed' con ese código", async () => {
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-4",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-4",
      status: "failed",
      failureCode: "heic_unsupported_profile",
    });

    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));
    act(() => {
      result.current.addFiles([fakeFile("perfil-raro.heic", 500, "image/heic")]);
    });

    await waitFor(() => expect(result.current.items[0]!.status).toBe("failed"));
    expect(result.current.items[0]!.errorCode).toBe("heic_unsupported_profile");
  });

  it("retry() vuelve a intentar tras un fallo, y puede terminar en ready", async () => {
    const { MediaClientError } = await import("@/lib/media-client");
    reserveMediaUploadMock
      .mockRejectedValueOnce(new MediaClientError("fallo transitorio", 500))
      .mockResolvedValueOnce({
        assetId: "asset-5",
        mode: "single",
        uploadUrl: "https://r2.test/put",
        expiresInSeconds: 900,
      });
    uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-5",
      status: "ready",
      variants: [],
    });

    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));
    act(() => {
      result.current.addFiles([fakeFile("foto.jpg", 1000)]);
    });
    await waitFor(() => expect(result.current.items[0]!.status).toBe("failed"));

    const localId = result.current.items[0]!.localId;
    act(() => {
      result.current.retry(localId);
    });

    await waitFor(() => expect(result.current.items[0]!.status).toBe("ready"));
    expect(reserveMediaUploadMock).toHaveBeenCalledTimes(2);
  });

  it("remove() quita el elemento de la cola y aborta en el servidor si ya tenía assetId", async () => {
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-6",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-6",
      status: "ready",
      variants: [],
    });
    abortMediaUploadMock.mockResolvedValue({ assetId: "asset-6", status: "deleted" });

    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));
    act(() => {
      result.current.addFiles([fakeFile("foto.jpg", 1000)]);
    });
    await waitFor(() => expect(result.current.items[0]!.assetId).toBe("asset-6"));

    const localId = result.current.items[0]!.localId;
    act(() => {
      result.current.remove(localId);
    });

    expect(result.current.items).toHaveLength(0);
    await waitFor(() => expect(abortMediaUploadMock).toHaveBeenCalledWith("asset-6"));
  });
});
