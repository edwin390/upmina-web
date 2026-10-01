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

const readVideoMetadataMock = vi.fn(
  async () =>
    null as { width: number; height: number; durationSeconds: number | null } | null,
);
vi.mock("@/lib/media-transport", () => ({
  prepareUploadBlob: vi.fn(async (file: File) => ({
    blob: file,
    mime: file.type,
    bytes: file.size,
    strategy: "original",
    width: null,
    height: null,
  })),
  readVideoMetadata: (...args: unknown[]) =>
    (readVideoMetadataMock as unknown as (...a: unknown[]) => unknown)(...args),
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

  it.each(["community", "cosplay"])(
    "%s: fallo genérico permite retry con nueva reserva/PUT; selecciones independientes tienen identidad propia",
    async (domain) => {
      const file = fakeFile("same.jpg", 1000);
      reserveMediaUploadMock.mockReset();
      completeMediaUploadMock.mockReset();
      uploadWithProgressMock.mockReset();
      for (const assetId of ["first", "retry", "selection"]) {
        reserveMediaUploadMock.mockResolvedValueOnce({
          assetId,
          mode: "single",
          uploadUrl: `https://r2.test/${assetId}`,
          expiresInSeconds: 900,
        });
      }
      uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
      completeMediaUploadMock
        .mockResolvedValueOnce({
          assetId: "first",
          status: "failed",
          failureCode: "processing_failed",
        })
        .mockResolvedValueOnce({
          assetId: "retry",
          status: "ready",
          kind: "image",
          variants: [],
        })
        .mockResolvedValueOnce({
          assetId: "selection",
          status: "ready",
          kind: "image",
          variants: [],
        });
      const { result } = renderHook(() => useMediaUpload({ domain }));
      act(() => {
        result.current.addFiles([file]);
      });
      await waitFor(() => expect(result.current.items[0]!.status).toBe("failed"));
      const localId = result.current.items[0]!.localId;
      act(() => {
        result.current.retry(localId);
      });
      await waitFor(() => {
        expect(result.current.items[0]!.assetId).toBe("retry");
        expect(result.current.items[0]!.status).toBe("ready");
      });
      expect(result.current.items[0]!.localId).toBe(localId);
      act(() => {
        result.current.addFiles([file]);
      });
      await waitFor(() => expect(result.current.items[1]!.status).toBe("ready"));
      expect(result.current.items[1]!.localId).not.toBe(localId);
      expect(reserveMediaUploadMock).toHaveBeenCalledTimes(3);
      expect(uploadWithProgressMock).toHaveBeenCalledTimes(3);
      for (const [index, assetId] of ["first", "retry", "selection"].entries()) {
        expect(uploadWithProgressMock.mock.calls[index]!.slice(0, 3)).toEqual([
          `https://r2.test/${assetId}`,
          file,
          "image/jpeg",
        ]);
        expect(completeMediaUploadMock).toHaveBeenNthCalledWith(index + 1, { assetId });
      }
    },
  );

  it("remove() conserva cancelación de un asset failed aún propiedad del uploader", async () => {
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-6",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-6",
      status: "failed",
      failureCode: "processing_failed",
    });
    abortMediaUploadMock.mockResolvedValue({ assetId: "asset-6", status: "deleted" });

    const { result } = renderHook(() => useMediaUpload({ domain: "cosplay" }));
    act(() => {
      result.current.addFiles([fakeFile("foto.jpg", 1000)]);
    });
    await waitFor(() => expect(result.current.items[0]!.status).toBe("failed"));

    const localId = result.current.items[0]!.localId;
    act(() => {
      result.current.remove(localId);
    });

    expect(result.current.items).toHaveLength(0);
    await waitFor(() => expect(abortMediaUploadMock).toHaveBeenCalledWith("asset-6"));
  });
});

describe("useMediaUpload — ownership persistido", () => {
  it("release retira un item ready sin abort; repetir release/remove/retry ya no lo alcanza", async () => {
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "persisted",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "persisted",
      status: "ready",
      variants: [],
    });
    const { result, unmount } = renderHook(() => useMediaUpload({ domain: "community" }));
    act(() => result.current.addFiles([fakeFile("a.jpg", 1000)]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe("ready"));
    const id = result.current.items[0]!.localId;
    act(() => result.current.release(id));
    expect(result.current.items).toHaveLength(0);
    act(() => {
      result.current.release(id);
      result.current.remove(id);
      result.current.retry(id);
    });
    unmount();
    expect(abortMediaUploadMock).not.toHaveBeenCalled();
    expect(reserveMediaUploadMock).toHaveBeenCalledTimes(1);
  });
});

describe("useMediaUpload — vídeo (Fase 9J-3)", () => {
  it("un archivo video/* se detecta como kind='video' de inmediato (antes de leer metadata)", async () => {
    readVideoMetadataMock.mockResolvedValueOnce({
      width: 1280,
      height: 720,
      durationSeconds: null,
    });
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-kind-1",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-kind-1",
      status: "ready",
      kind: "video",
      url: "https://pub.test/x.mp4",
      width: 1280,
      height: 720,
      bytes: 5_000_000,
      durationSeconds: null,
    });
    const { result } = renderHook(() => useMediaUpload({ domain: "community" }));
    act(() => {
      result.current.addFiles([fakeFile("clip.mp4", 5_000_000, "video/mp4")]);
    });
    expect(result.current.items[0]!.kind).toBe("video");
    await waitFor(() => expect(result.current.items[0]!.status).toBe("ready"));
  });

  it("un archivo image/* se detecta como kind='image' (regresión)", async () => {
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-kind-2",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-kind-2",
      status: "ready",
      variants: [],
    });
    const { result } = renderHook(() => useMediaUpload({ domain: "community" }));
    act(() => {
      result.current.addFiles([fakeFile("foto.jpg", 1000, "image/jpeg")]);
    });
    expect(result.current.items[0]!.kind).toBe("image");
    await waitFor(() => expect(result.current.items[0]!.status).toBe("ready"));
  });

  it("un mime que no es ni imagen ni vídeo se rechaza de inmediato (unsupported_type), sin reservar nada", async () => {
    const { result } = renderHook(() => useMediaUpload({ domain: "community" }));
    act(() => {
      result.current.addFiles([fakeFile("doc.pdf", 1000, "application/pdf")]);
    });
    await waitFor(() => expect(result.current.items[0]!.status).toBe("failed"));
    expect(result.current.items[0]!.errorCode).toBe("unsupported_type");
    expect(reserveMediaUploadMock).not.toHaveBeenCalled();
  });

  it("vídeo: usa readVideoMetadata (nunca prepareUploadBlob/createImageBitmap) y envía kind+dimensiones+duración a reserveMediaUpload", async () => {
    readVideoMetadataMock.mockResolvedValueOnce({
      width: 1280,
      height: 720,
      durationSeconds: 8.4,
    });
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-video-1",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-video-1",
      status: "ready",
      kind: "video",
      url: "https://pub.test/asset-video-1/original.mp4",
      width: 1280,
      height: 720,
      bytes: 5_000_000,
      durationSeconds: 8.4,
    });

    const { result } = renderHook(() => useMediaUpload({ domain: "community" }));
    act(() => {
      result.current.addFiles([fakeFile("clip.mp4", 5_000_000, "video/mp4")]);
    });

    await waitFor(() => expect(result.current.items[0]!.status).toBe("ready"));
    expect(reserveMediaUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "community",
        kind: "video",
        sourceMime: "video/mp4",
        sourceBytes: 5_000_000,
        sourceWidth: 1280,
        sourceHeight: 720,
        sourceDurationSeconds: 8.4,
      }),
    );
    expect(result.current.items[0]!.video).toEqual({
      kind: "video",
      url: "https://pub.test/asset-video-1/original.mp4",
      width: 1280,
      height: 720,
      bytes: 5_000_000,
      durationSeconds: 8.4,
    });
    expect(result.current.items[0]!.variants).toBeNull();
  });

  it("vídeo cuya metadata el navegador no pudo leer: se reserva igualmente (sin width/height), el SERVIDOR decide si lo rechaza", async () => {
    readVideoMetadataMock.mockResolvedValueOnce(null);
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-video-2",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    const { result } = renderHook(() => useMediaUpload({ domain: "community" }));
    act(() => {
      result.current.addFiles([fakeFile("clip.mov", 2_000_000, "video/quicktime")]);
    });
    await waitFor(() => expect(reserveMediaUploadMock).toHaveBeenCalled());
    const args = reserveMediaUploadMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.sourceWidth).toBeUndefined();
    expect(args.sourceHeight).toBeUndefined();
    expect(args.sourceDurationSeconds).toBeUndefined();
  });
});
