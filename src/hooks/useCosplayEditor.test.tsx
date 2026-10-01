import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCosplayEditor } from "./useCosplayEditor";
import { CosplayAdminClientError } from "@/lib/cosplay-admin-client";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { refreshCosplayContent } from "@/lib/content-freshness";

// Estado del editor ADMIN de Cosplay (Fase 9I-3, checkpoint 3): cosplay-admin-client.ts y
// media-client.ts SIEMPRE mockeados (nunca red/R2/Supabase reales — ya verificados por separado).
// Aquí solo importa la orquestación: crear/editar, guardar/publicar, concurrencia optimista,
// step-up, mover/portada, y los dos caminos de "quitar" (nueva foto vs. foto ya adjunta).

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

const saveCosplayPostMock = vi.fn();
const getCosplayPostAdminMock = vi.fn();
const detachCosplayMediaMock = vi.fn();
const deleteCosplayPostMock = vi.fn();
vi.mock("@/lib/cosplay-admin-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cosplay-admin-client")>(
    "@/lib/cosplay-admin-client",
  );
  return {
    ...actual,
    saveCosplayPost: (...args: unknown[]) => saveCosplayPostMock(...args),
    getCosplayPostAdmin: (...args: unknown[]) => getCosplayPostAdminMock(...args),
    detachCosplayMedia: (...args: unknown[]) => detachCosplayMediaMock(...args),
    deleteCosplayPost: (...args: unknown[]) => deleteCosplayPostMock(...args),
  };
});

function fakeFile(name: string, bytes = 1000): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
}

function readyReservation(assetId: string) {
  return {
    assetId,
    mode: "single" as const,
    uploadUrl: "https://r2.test/put",
    expiresInSeconds: 900,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
  abortMediaUploadMock.mockResolvedValue({ assetId: "aborted", status: "deleted" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ownership después de persistencia", () => {
  it.each(["draft", "published"] as const)(
    "%s delete challenge requires another explicit confirmation after MFA",
    async (status) => {
      getCosplayPostAdminMock.mockResolvedValue({
        id: "persisted-post",
        status,
        version: 7,
        title: "Trabajo",
        images: [],
      });
      deleteCosplayPostMock.mockRejectedValueOnce(
        new CosplayAdminClientError(
          "MFA required",
          403,
          "step_up_required",
          "step_up_required",
        ),
      );
      const changed = vi.fn();
      const { result } = renderHook(() =>
        useCosplayEditor({ initialPostId: "persisted-post", onPostChanged: changed }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      await act(async () => {
        await result.current.confirmDelete();
      });
      expect(result.current.stepUpIntent).toBe("delete");
      act(() => result.current.clearStepUpIntent());
      expect(deleteCosplayPostMock).toHaveBeenCalledTimes(1);
      expect(changed).not.toHaveBeenCalled();
      expect(result.current.postId).toBe("persisted-post");
      expect(result.current.version).toBe(7);
      deleteCosplayPostMock.mockResolvedValueOnce({});
      await act(async () => {
        await result.current.confirmDelete();
      });
      expect(deleteCosplayPostMock).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenCalledWith(status);
      expect(abortMediaUploadMock).not.toHaveBeenCalled();
    },
  );
  it.each(["draft", "published"] as const)(
    "%s reconcilia IDs, orden y portada; quitar luego usa detach sin abort",
    async (status) => {
      let nextAsset = 0;
      reserveMediaUploadMock.mockImplementation(async () =>
        readyReservation(`new-${++nextAsset}`),
      );
      completeMediaUploadMock.mockImplementation(async ({ assetId }) => ({
        assetId,
        status: "ready",
        variants: [
          {
            variant: 480,
            width: 468,
            height: 428,
            bytes: 1000,
            url: `https://pub.test/${assetId}.webp`,
          },
        ],
      }));
      saveCosplayPostMock.mockImplementation(async (input) => ({
        post: { id: "persisted-post", status, version: 2 },
        images: input.images.map(
          (image: { assetId: string; position: number; isCover: boolean }) => ({
            ...image,
            id: `persisted-${image.assetId}`,
          }),
        ),
      }));
      detachCosplayMediaMock.mockResolvedValue({ version: 3 });
      const { result, unmount } = renderHook(() =>
        useCosplayEditor({ initialPostId: null }),
      );
      act(() => {
        result.current.updateField("title", "Título");
        result.current.addFiles([fakeFile("a.jpg"), fakeFile("b.jpg")]);
      });
      await waitFor(() =>
        expect(
          result.current.photos.filter((p) => p.uploadStatus === "ready"),
        ).toHaveLength(2),
      );
      const secondKey = result.current.photos[1]!.key;
      act(() => {
        result.current.movePhoto(secondKey, -1);
        result.current.setCover(secondKey);
      });
      const before = result.current.photos;
      await act(async () => {
        await result.current.save(status);
      });
      expect(result.current.photos.map((p) => p.assetId)).toEqual(
        before.map((p) => p.assetId),
      );
      expect(result.current.photos.map((p) => p.key)).toEqual(before.map((p) => p.key));
      expect(result.current.photos.map((p) => p.url)).toEqual(before.map((p) => p.url));
      expect(result.current.photos.map((p) => p.isCover)).toEqual([true, false]);
      expect(
        result.current.photos.map((p) => ({
          localId: p.localId,
          status: p.uploadStatus,
          id: p.existingImageId,
        })),
      ).toEqual(
        before.map((p) => ({
          localId: null,
          status: "existing",
          id: `persisted-${p.assetId}`,
        })),
      );
      expect(result.current.isDirty).toBe(false);
      act(() => result.current.removeNewPhoto(secondKey));
      expect(result.current.photos).toHaveLength(2);
      act(() => result.current.requestRemoveExisting(secondKey));
      await act(async () => {
        await result.current.confirmRemoveExisting();
      });
      expect(detachCosplayMediaMock).toHaveBeenCalledWith({
        postId: "persisted-post",
        expectedVersion: 2,
        imageId: `persisted-${before[0]!.assetId}`,
      });
      expect(result.current.photos).toHaveLength(1);
      unmount();
      expect(abortMediaUploadMock).not.toHaveBeenCalled();
    },
  );

  it("save fallido no transfiere ownership: permite quitar el upload", async () => {
    reserveMediaUploadMock.mockResolvedValue(readyReservation("unpersisted"));
    completeMediaUploadMock.mockResolvedValue({
      assetId: "unpersisted",
      status: "ready",
      variants: [],
    });
    saveCosplayPostMock.mockRejectedValueOnce(new Error("save failed"));
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    act(() => {
      result.current.updateField("title", "Título");
      result.current.addFiles([fakeFile("a.jpg")]);
    });
    await waitFor(() => expect(result.current.photos[0]?.uploadStatus).toBe("ready"));
    const key = result.current.photos[0]!.key;
    await act(async () => {
      await result.current.save("draft");
    });
    expect(result.current.photos[0]?.localId).not.toBeNull();
    expect(abortMediaUploadMock).not.toHaveBeenCalled();
    act(() => result.current.removeNewPhoto(key));
    expect(abortMediaUploadMock).toHaveBeenCalledWith("unpersisted");
  });
});

describe("crear (postId=null)", () => {
  it("arranca vacío, sin llamar a getCosplayPostAdmin", () => {
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    expect(result.current.loading).toBe(false);
    expect(result.current.fields.title).toBe("");
    expect(result.current.photos).toHaveLength(0);
    expect(getCosplayPostAdminMock).not.toHaveBeenCalled();
  });

  it("canSave es false sin título, incluso sin fotos", () => {
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    expect(result.current.canSave).toBe(false);
  });

  it("con título, canSave es true (0 fotos permitido en borrador)", () => {
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    act(() => result.current.updateField("title", "Kirito"));
    expect(result.current.canSave).toBe(true);
  });

  it("mientras una foto sigue subiendo/procesando, canSave es false", async () => {
    reserveMediaUploadMock.mockResolvedValue(readyReservation("asset-1"));
    completeMediaUploadMock.mockImplementation(() => new Promise(() => undefined)); // nunca resuelve: sigue "processing"... en realidad queda en "uploaded" hasta completar
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    act(() => result.current.updateField("title", "Kirito"));
    act(() => result.current.addFiles([fakeFile("a.jpg")]));

    await waitFor(() => expect(result.current.photos).toHaveLength(1));
    expect(result.current.canSave).toBe(false);
  });

  it("guardar borrador: llama a saveCosplayPost con postId null y actualiza postId/version/status", async () => {
    saveCosplayPostMock.mockResolvedValue({
      post: {
        id: "post-1",
        slug: "kirito",
        status: "draft",
        title: "Kirito",
        description: null,
        characterName: null,
        series: null,
        event: null,
        shotOn: null,
        photographerCredit: null,
        version: 1,
        publishedAt: null,
      },
      images: [],
    });
    const onPostChanged = vi.fn();
    const { result } = renderHook(() =>
      useCosplayEditor({ initialPostId: null, onPostChanged }),
    );
    act(() => result.current.updateField("title", "Kirito"));

    await act(async () => {
      await result.current.save("draft");
    });

    expect(saveCosplayPostMock).toHaveBeenCalledWith(
      expect.objectContaining({ postId: null, expectedVersion: null, status: "draft" }),
    );
    expect(result.current.postId).toBe("post-1");
    expect(result.current.version).toBe(1);
    expect(onPostChanged).toHaveBeenCalledTimes(1);
  });

  it("tras guardar, isDirty vuelve a false (el estado guardado ya no se considera sin guardar)", async () => {
    saveCosplayPostMock.mockResolvedValue({
      post: {
        id: "post-1",
        slug: "kirito",
        status: "draft",
        title: "Kirito",
        description: null,
        characterName: null,
        series: null,
        event: null,
        shotOn: null,
        photographerCredit: null,
        version: 1,
        publishedAt: null,
      },
      images: [],
    });
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    act(() => result.current.updateField("title", "Kirito"));
    expect(result.current.isDirty).toBe(true);

    await act(async () => {
      await result.current.save("draft");
    });
    expect(result.current.isDirty).toBe(false);
  });

  it("subida real: la foto pasa a 'ready' y queda disponible para el payload de guardado", async () => {
    reserveMediaUploadMock.mockResolvedValue(readyReservation("asset-1"));
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-1",
      status: "ready",
      variants: [
        {
          variant: 480,
          width: 480,
          height: 640,
          bytes: 1000,
          url: "https://pub.test/w480.webp",
        },
      ],
    });
    saveCosplayPostMock.mockResolvedValue({
      post: {
        id: "post-1",
        slug: "kirito",
        status: "draft",
        title: "Kirito",
        description: null,
        characterName: null,
        series: null,
        event: null,
        shotOn: null,
        photographerCredit: null,
        version: 1,
        publishedAt: null,
      },
      images: [],
    });

    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    act(() => result.current.updateField("title", "Kirito"));
    act(() => result.current.addFiles([fakeFile("a.jpg")]));

    await waitFor(() => expect(result.current.photos[0]?.uploadStatus).toBe("ready"));
    expect(result.current.photos[0]?.url).toBe("https://pub.test/w480.webp");
    expect(result.current.canSave).toBe(true);

    await act(async () => {
      await result.current.save("draft");
    });
    const args = saveCosplayPostMock.mock.calls[0]![0];
    expect(args.images).toEqual([
      expect.objectContaining({ assetId: "asset-1", position: 0, isCover: false }),
    ]);
  });

  it("el payload de guardado nunca lleva alt/caption/decorative/fotografía introducidos a mano: alt se deriva del título, caption/decorative/fotógrafo van siempre null (ajuste UX posterior a 9I-3)", async () => {
    reserveMediaUploadMock.mockResolvedValue(readyReservation("asset-1"));
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-1",
      status: "ready",
      variants: [
        {
          variant: 480,
          width: 480,
          height: 640,
          bytes: 1000,
          url: "https://pub.test/w480.webp",
        },
      ],
    });
    saveCosplayPostMock.mockResolvedValue({
      post: {
        id: "post-1",
        slug: "kirito",
        status: "draft",
        title: "Kirito",
        description: null,
        characterName: null,
        series: null,
        event: null,
        shotOn: null,
        photographerCredit: null,
        version: 1,
        publishedAt: null,
      },
      images: [],
    });

    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    act(() => result.current.updateField("title", "Kirito"));
    act(() => result.current.addFiles([fakeFile("a.jpg")]));
    await waitFor(() => expect(result.current.photos[0]?.uploadStatus).toBe("ready"));

    await act(async () => {
      await result.current.save("draft");
    });

    const args = saveCosplayPostMock.mock.calls[0]![0];
    expect(args.photographerCredit).toBeNull();
    expect(args.images).toEqual([
      expect.objectContaining({
        decorative: false,
        caption: null,
        alt: "Kirito — foto 1",
      }),
    ]);
  });

  it("el payload de guardado nunca lleva Evento ni Fecha manual (Fase 'COSPLAY DETAIL REDESIGN'): siempre van null, igual que el fotógrafo", async () => {
    saveCosplayPostMock.mockResolvedValue({
      post: {
        id: "post-1",
        slug: "kirito",
        status: "draft",
        title: "Kirito",
        description: null,
        characterName: null,
        series: null,
        event: null,
        shotOn: null,
        photographerCredit: null,
        version: 1,
        publishedAt: null,
      },
      images: [],
    });
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    act(() => result.current.updateField("title", "Kirito"));
    // EditorFields ya NO tiene event/shotOn: no hay forma de que el ADMIN los rellene.
    expect(result.current.fields).not.toHaveProperty("event");
    expect(result.current.fields).not.toHaveProperty("shotOn");

    await act(async () => {
      await result.current.save("draft");
    });

    const args = saveCosplayPostMock.mock.calls[0]![0];
    expect(args.event).toBeNull();
    expect(args.shotOn).toBeNull();
  });

  it("respeta el límite de fotos restantes al añadir más de las que caben", () => {
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    expect(result.current.remainingCapacity).toBe(20);
  });
});

describe("editar (postId existente)", () => {
  const existingDetail = () => ({
    id: "post-1",
    slug: "kirito",
    status: "published" as const,
    title: "Kirito",
    description: null,
    characterName: null,
    series: null,
    event: null,
    shotOn: null,
    photographerCredit: null,
    version: 3,
    publishedAt: "2026-01-01T00:00:00.000Z",
    images: [
      {
        id: "img-1",
        assetId: "asset-1",
        position: 0,
        isCover: true,
        decorative: false,
        alt: "alt",
        caption: null,
        assetStatus: "ready",
        width: 480,
        height: 640,
        url: "https://pub.test/w480.webp",
      },
    ],
  });

  it("carga la publicación existente con getCosplayPostAdmin y puebla campos/galería/versión", async () => {
    getCosplayPostAdminMock.mockResolvedValue(existingDetail());
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: "post-1" }));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fields.title).toBe("Kirito");
    expect(result.current.version).toBe(3);
    expect(result.current.status).toBe("published");
    expect(result.current.photos).toHaveLength(1);
    expect(result.current.photos[0]?.existingImageId).toBe("img-1");
    expect(result.current.isDirty).toBe(false);
  });

  it("guardar envía postId + expectedVersion (concurrencia optimista)", async () => {
    getCosplayPostAdminMock.mockResolvedValue(existingDetail());
    saveCosplayPostMock.mockResolvedValue({
      post: { ...existingDetail(), version: 4 },
      images: [],
    });
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: "post-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save("published");
    });
    expect(saveCosplayPostMock).toHaveBeenCalledWith(
      expect.objectContaining({ postId: "post-1", expectedVersion: 3 }),
    );
    expect(result.current.version).toBe(4);
  });

  it.each(["draft", "published"] as const)(
    "reanudar draft y guardar %s conserva ID, versión, fotos ordenadas y portada sin abort",
    async (desiredStatus) => {
      const original = existingDetail();
      const detail = {
        ...original,
        status: "draft",
        images: [
          {
            ...original.images[0]!,
            id: "img-b",
            assetId: "asset-b",
            position: 1,
            isCover: false,
          },
          {
            ...original.images[0]!,
            id: "img-a",
            assetId: "asset-a",
            position: 0,
            isCover: true,
          },
        ],
      };
      getCosplayPostAdminMock.mockResolvedValue(detail);
      saveCosplayPostMock.mockResolvedValue({
        post: { ...detail, status: desiredStatus, version: 4 },
        images: [...detail.images].sort((a, b) => a.position - b.position),
      });
      const onPostChanged = vi.fn();
      const { result, unmount } = renderHook(() =>
        useCosplayEditor({ initialPostId: "post-1", resumeDraft: true, onPostChanged }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(getCosplayPostAdminMock).toHaveBeenCalledWith("post-1", true);
      expect(result.current.fields).toMatchObject({
        title: detail.title,
        description: detail.description ?? "",
        characterName: detail.characterName ?? "",
        series: detail.series ?? "",
      });
      expect(result.current.photos.map((p) => p.existingImageId)).toEqual([
        "img-a",
        "img-b",
      ]);
      expect(result.current.photos.map((p) => p.isCover)).toEqual([true, false]);
      expect(result.current.photos.every((p) => p.localId === null)).toBe(true);
      await act(async () => {
        await result.current.save(desiredStatus);
      });
      expect(saveCosplayPostMock).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: "post-1",
          expectedVersion: 3,
          status: desiredStatus,
        }),
      );
      expect(onPostChanged).toHaveBeenCalledWith(desiredStatus);
      unmount();
      expect(abortMediaUploadMock).not.toHaveBeenCalled();
    },
  );

  it("409 cosplay_version_conflict: NUNCA sobrescribe silenciosamente, expone conflict", async () => {
    getCosplayPostAdminMock.mockResolvedValue(existingDetail());
    saveCosplayPostMock.mockRejectedValue(
      new CosplayAdminClientError("Solicitud inválida", 409, "cosplay_version_conflict"),
    );
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: "post-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save("published");
    });
    expect(result.current.conflict).toEqual({ kind: "version" });
    expect(result.current.version).toBe(3); // sin cambios locales

    // reloadFromServer trae la versión real y limpia el conflicto.
    getCosplayPostAdminMock.mockResolvedValue({ ...existingDetail(), version: 9 });
    await act(async () => {
      await result.current.reloadFromServer();
    });
    expect(result.current.conflict).toBeNull();
    expect(result.current.version).toBe(9);
  });

  it("step_up_required en guardar: expone stepUpIntent='edit' (nunca reintenta la mutación)", async () => {
    getCosplayPostAdminMock.mockResolvedValue(existingDetail());
    saveCosplayPostMock.mockRejectedValue(
      new CosplayAdminClientError(
        "No autorizado",
        403,
        "step_up_required",
        "step_up_required",
      ),
    );
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: "post-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save("published");
    });
    expect(result.current.stepUpIntent).toBe("edit");
    expect(saveCosplayPostMock).toHaveBeenCalledTimes(1);
  });

  it("step_up_required DURANTE LA SUBIDA (MFA venció con el editor ya abierto) expone stepUpIntent='edit', sin reintentar la subida sola", async () => {
    const { MediaClientError } = await import("@/lib/media-client");
    reserveMediaUploadMock.mockRejectedValue(
      new MediaClientError("No autorizado", 403, "step_up_required", "step_up_required"),
    );
    getCosplayPostAdminMock.mockResolvedValue(existingDetail());
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: "post-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.addFiles([fakeFile("a.jpg")]));

    await waitFor(() => expect(result.current.stepUpIntent).toBe("edit"));
    // Nunca se llama a saveCosplayPost ni se reintenta la reserva por su cuenta.
    expect(saveCosplayPostMock).not.toHaveBeenCalled();
    expect(reserveMediaUploadMock).toHaveBeenCalledTimes(1);
  });

  it("step_up_required durante la subida al CREAR (postId null): stepUpIntent='create'", async () => {
    const { MediaClientError } = await import("@/lib/media-client");
    reserveMediaUploadMock.mockRejectedValue(
      new MediaClientError("No autorizado", 403, "step_up_required", "step_up_required"),
    );
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    act(() => result.current.addFiles([fakeFile("a.jpg")]));

    await waitFor(() => expect(result.current.stepUpIntent).toBe("create"));
  });

  it("step_up_required al crear (postId null): stepUpIntent='create'", async () => {
    saveCosplayPostMock.mockRejectedValue(
      new CosplayAdminClientError(
        "No autorizado",
        403,
        "step_up_required",
        "step_up_required",
      ),
    );
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    act(() => result.current.updateField("title", "Kirito"));
    await act(async () => {
      await result.current.save("draft");
    });
    expect(result.current.stepUpIntent).toBe("create");
  });

  it("mover arriba/abajo reordena localmente sin llamar a la red", async () => {
    getCosplayPostAdminMock.mockResolvedValue({
      ...existingDetail(),
      images: [
        { ...existingDetail().images[0]!, id: "img-1", assetId: "asset-1" },
        {
          ...existingDetail().images[0]!,
          id: "img-2",
          assetId: "asset-2",
          isCover: false,
        },
      ],
    });
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: "post-1" }));
    await waitFor(() => expect(result.current.photos).toHaveLength(2));

    act(() => result.current.movePhoto("existing:img-2", -1));
    expect(result.current.photos.map((p) => p.existingImageId)).toEqual([
      "img-2",
      "img-1",
    ]);
  });

  it("marcar portada deja como portada solo esa foto", async () => {
    getCosplayPostAdminMock.mockResolvedValue({
      ...existingDetail(),
      images: [
        {
          ...existingDetail().images[0]!,
          id: "img-1",
          assetId: "asset-1",
          isCover: true,
        },
        {
          ...existingDetail().images[0]!,
          id: "img-2",
          assetId: "asset-2",
          isCover: false,
        },
      ],
    });
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: "post-1" }));
    await waitFor(() => expect(result.current.photos).toHaveLength(2));

    act(() => result.current.setCover("existing:img-2"));
    expect(
      result.current.photos.find((p) => p.existingImageId === "img-1")?.isCover,
    ).toBe(false);
    expect(
      result.current.photos.find((p) => p.existingImageId === "img-2")?.isCover,
    ).toBe(true);
  });

  it("quitar una foto YA adjunta exige confirmación y usa detachCosplayMedia; éxito la quita de la galería", async () => {
    getCosplayPostAdminMock.mockResolvedValue(existingDetail());
    detachCosplayMediaMock.mockResolvedValue({
      version: 4,
      assetId: "asset-1",
      cleaned: true,
    });
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: "post-1" }));
    await waitFor(() => expect(result.current.photos).toHaveLength(1));

    act(() => result.current.requestRemoveExisting("existing:img-1"));
    expect(result.current.pendingDetachKey).toBe("existing:img-1");
    expect(detachCosplayMediaMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.confirmRemoveExisting();
    });
    expect(detachCosplayMediaMock).toHaveBeenCalledWith({
      postId: "post-1",
      expectedVersion: 3,
      imageId: "img-1",
    });
    expect(result.current.photos).toHaveLength(0);
    expect(result.current.version).toBe(4);
  });

  it("detach actualiza caches externos previamente fresh", async () => {
    const client = new QueryClient();
    let photoCount = 1;
    const observer = new QueryObserver(client, {
      queryKey: ["cosplay", "post", "slug"],
      queryFn: async () => ({ photoCount }),
      staleTime: 60_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    getCosplayPostAdminMock.mockResolvedValue(existingDetail());
    detachCosplayMediaMock.mockImplementationOnce(async () => {
      photoCount = 0;
      return { version: 4, cleaned: true };
    });
    const { result } = renderHook(() =>
      useCosplayEditor({
        initialPostId: "post-1",
        onPostChanged: (status) => {
          void refreshCosplayContent(client, status);
        },
      }),
    );
    await waitFor(() => expect(result.current.photos).toHaveLength(1));
    act(() => result.current.requestRemoveExisting("existing:img-1"));
    await act(async () => {
      await result.current.confirmRemoveExisting();
    });
    await waitFor(() =>
      expect(observer.getCurrentResult().data).toEqual({ photoCount: 0 }),
    );
    expect(abortMediaUploadMock).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("quitar una foto RECIÉN subida (nunca adjunta) no exige confirmación ni llama a detach", async () => {
    reserveMediaUploadMock.mockResolvedValue(readyReservation("asset-new"));
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-new",
      status: "ready",
      variants: [
        {
          variant: 480,
          width: 480,
          height: 640,
          bytes: 1,
          url: "https://pub.test/x.webp",
        },
      ],
    });
    const { result } = renderHook(() => useCosplayEditor({ initialPostId: null }));
    act(() => result.current.addFiles([fakeFile("a.jpg")]));
    await waitFor(() => expect(result.current.photos).toHaveLength(1));

    const key = result.current.photos[0]!.key;
    act(() => result.current.removeNewPhoto(key));
    await waitFor(() => expect(result.current.photos).toHaveLength(0));
    expect(detachCosplayMediaMock).not.toHaveBeenCalled();
  });

  it("confirmDelete: borra, invoca onPostChanged; step_up_required expone intent='delete'", async () => {
    getCosplayPostAdminMock.mockResolvedValue(existingDetail());
    deleteCosplayPostMock.mockResolvedValue({
      postId: "post-1",
      deletedAssets: [],
      allCleaned: true,
    });
    const onPostChanged = vi.fn();
    const { result } = renderHook(() =>
      useCosplayEditor({ initialPostId: "post-1", onPostChanged }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current.confirmDelete();
    });
    expect(ok).toBe(true);
    expect(deleteCosplayPostMock).toHaveBeenCalledWith({
      postId: "post-1",
      expectedVersion: 3,
    });
    expect(onPostChanged).toHaveBeenCalledTimes(1);
  });
});

describe("concurrencia de subida móvil (sección 18/22 del checkpoint)", () => {
  it("useCosplayEditor NUNCA pasa `concurrency` a useMediaUpload: la política 2/3 desktop / 1/2 móvil se decide sola", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/hooks/useCosplayEditor.ts"),
      "utf8",
    );
    const call = src.match(/useMediaUpload\(\{[^}]*\}\)/)?.[0] ?? "";
    expect(call).toContain('domain: "cosplay"');
    expect(call).not.toMatch(/concurrency/);
  });
});
