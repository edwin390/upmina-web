import type { PrivilegedSessionIdentity } from "@/lib/privileged-session";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CosplayAdminClientError,
  deleteCosplayPost,
  detachCosplayMedia,
  getCosplayPostAdmin,
  saveCosplayPost,
  type CosplayAdminImage,
  type CosplayEditorImageInput,
} from "@/lib/cosplay-admin-client";
import { MAX_COSPLAY_PHOTOS } from "@/lib/cosplay-domain";
import {
  useMediaUpload,
  type MediaItemStatus,
  type MediaQueueItem,
} from "@/hooks/useMediaUpload";
import type { PrivilegedFailure } from "@/lib/privileged-response";
import type { PrivilegedIntent } from "@/lib/privileged-intent";

// Estado del editor ADMIN de Cosplay (Fase 9I-3, checkpoint 3; modelo editorial corregido a un
// único valor por campo — ver types/index.ts). Combina:
//   - los campos editoriales del formulario (título/descripción/metadata) — UN valor por campo,
//     en el idioma que Mina elija: nunca varía con el idioma de la interfaz;
//   - la cola de subida REAL (useMediaUpload, sin sobrescribir concurrencia — mantiene la
//     política 2/3 desktop y 1/2 móvil ya congelada);
//   - las fotos YA adjuntas cargadas del servidor al editar una publicación existente.
//
// Diseño deliberado: mover una foto arriba/abajo o cambiar su portada son SOLO cambios de estado
// LOCAL — nunca llaman a la red por sí solos. La posición final (el índice
// del array, siempre contiguo 0..n-1 por construcción) y el resto de metadata editorial se
// persisten juntos en la SIGUIENTE llamada explícita a Guardar borrador/Publicar. Esto evita una
// llamada de red por cada clic y mantiene la concurrencia optimista simple: una única versión
// esperada por guardado, no una por cada micro-cambio.

export interface EditorPhoto {
  /** Clave estable de React. */
  key: string;
  assetId: string | null;
  /** Id de cosplay_post_images para una foto ya persistida. */
  existingImageId: string | null;
  /** localId de useMediaUpload mientras la foto siga sin persistir. */
  localId: string | null;
  fileName: string | null;
  /** "existing" = cargada del servidor, ya lista; si no, el estado real de la cola de subida. */
  uploadStatus: MediaItemStatus | "existing";
  uploadErrorCode: string | null;
  uploadErrorMessage: string | null;
  privilegedFailure: PrivilegedFailure | null;
  uploadedBytes: number;
  totalUploadBytes: number;
  url: string | null;
  width: number | null;
  height: number | null;
  isCover: boolean;
}

export interface EditorFields {
  title: string;
  description: string;
  characterName: string;
  series: string;
}

const EMPTY_FIELDS: EditorFields = {
  title: "",
  description: "",
  characterName: "",
  series: "",
};

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function photoFromExisting(image: CosplayAdminImage): EditorPhoto {
  return {
    key: `existing:${image.id}`,
    assetId: image.assetId,
    existingImageId: image.id,
    localId: null,
    fileName: null,
    uploadStatus: "existing",
    uploadErrorCode: null,
    uploadErrorMessage: null,
    privilegedFailure: null,
    uploadedBytes: 0,
    totalUploadBytes: 0,
    url: image.url,
    width: image.width,
    height: image.height,
    isCover: image.isCover,
  };
}

function photoFromQueueItem(item: MediaQueueItem): EditorPhoto {
  const variant =
    item.variants && item.variants.length > 0
      ? item.variants[item.variants.length - 1]!
      : null;
  return {
    key: `new:${item.localId}`,
    assetId: item.assetId,
    existingImageId: null,
    localId: item.localId,
    fileName: item.fileName,
    uploadStatus: item.status,
    uploadErrorCode: item.errorCode,
    uploadErrorMessage: item.errorMessage,
    privilegedFailure: item.privilegedFailure,
    uploadedBytes: item.uploadedBytes,
    totalUploadBytes: item.totalUploadBytes,
    url: variant?.url ?? null,
    width: variant?.width ?? null,
    height: variant?.height ?? null,
    isCover: false,
  };
}

/** Actualiza SOLO los campos derivados de la subida (nunca los editoriales, que el ADMIN puede
 *  haber cambiado ya mientras la foto seguía procesándose). */
function mergeUploadFields(photo: EditorPhoto, item: MediaQueueItem): EditorPhoto {
  const variant =
    item.variants && item.variants.length > 0
      ? item.variants[item.variants.length - 1]!
      : null;
  return {
    ...photo,
    assetId: item.assetId,
    uploadStatus: item.status,
    uploadErrorCode: item.errorCode,
    uploadErrorMessage: item.errorMessage,
    privilegedFailure: item.privilegedFailure,
    uploadedBytes: item.uploadedBytes,
    totalUploadBytes: item.totalUploadBytes,
    url: variant?.url ?? photo.url,
    width: variant?.width ?? photo.width,
    height: variant?.height ?? photo.height,
  };
}

const NON_TERMINAL_UPLOAD_STATUSES: ReadonlySet<MediaItemStatus> = new Set([
  "queued",
  "preparing",
  "uploading",
  "uploaded",
  "processing",
]);

export type ConflictState = { kind: "version" } | null;

export interface UseCosplayEditorOptions {
  session?: {
    invalidate?: () => void;
    userId?: string | null;
    isActive: () => boolean;
    isCurrent: () => Promise<boolean>;
  };
  /** null = crear una publicación nueva; un id = editar una existente. */
  initialPostId: string | null;
  resumeDraft?: boolean;
  onClosed?: () => void;
  /** Notifica persistencia/borrado/detach; distingue drafts de contenido público. */
  onPostChanged?: (status?: "draft" | "published") => void;
}

export function useCosplayEditor({
  initialPostId,
  resumeDraft = false,
  onPostChanged,
  session,
}: UseCosplayEditorOptions) {
  const [postId, setPostId] = useState<string | null>(initialPostId);
  const [status, setStatus] = useState<"draft" | "published">("draft");
  const [version, setVersion] = useState<number | null>(null);
  const [fields, setFields] = useState<EditorFields>(EMPTY_FIELDS);
  const [photos, setPhotos] = useState<EditorPhoto[]>([]);
  const [loading, setLoading] = useState(initialPostId !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"draft" | "published" | null>(null);
  const [saveErrorCode, setSaveErrorCode] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState>(null);
  const [stepUpIntent, setStepUpIntent] = useState<PrivilegedIntent | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingDetachKey, setPendingDetachKey] = useState<string | null>(null);
  const [detaching, setDetaching] = useState(false);
  const [detachErrorKey, setDetachErrorKey] = useState<string | null>(null);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const blocked = useRef(false);
  const operationPending = useRef(false);
  const active = useCallback(
    () => mounted.current && (!sessionRef.current || sessionRef.current.isActive()),
    [],
  );
  const current = useCallback(
    async () =>
      active() &&
      (!sessionRef.current || (await sessionRef.current.isCurrent())) &&
      active(),
    [active],
  );
  const identityArgs = useCallback(
    (): [] | [PrivilegedSessionIdentity] =>
      sessionRef.current
        ? [{ userId: sessionRef.current.userId ?? null, isActive: active }]
        : [],
    [active],
  );
  const requestStepUp = useCallback(
    (intent: PrivilegedIntent) => {
      if (!active()) return;
      blocked.current = true;
      setPendingDetachKey(null);
      setStepUpIntent(intent);
    },
    [active],
  );
  const privilegedSession = session
    ? {
        userId: session.userId ?? null,
        isActive: active,
        isCurrent: current,
        isBlocked: () => blocked.current,
        onInvalidSession: () => sessionRef.current?.invalidate?.(),
        onStepUp: () => requestStepUp(initialPostId === null ? "create" : "edit"),
      }
    : undefined;
  const mediaUpload = useMediaUpload({ domain: "cosplay", privilegedSession });
  const [loadRetryRequired, setLoadRetryRequired] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const savedSnapshotRef = useRef<string>("");
  const handledUploadFailures = useRef(new Set<string>());

  const markClean = useCallback((f: EditorFields, p: EditorPhoto[]) => {
    savedSnapshotRef.current = JSON.stringify({
      f,
      p: p.map((x) => ({ assetId: x.assetId, isCover: x.isCover })),
    });
    setDirty(false);
  }, []);

  // Carga inicial (modo edición): cosplay-post-get-admin, nunca la ruta pública (que nunca
  // devolvería un borrador ni un asset no-ready).
  useEffect(() => {
    if (initialPostId === null) {
      markClean(EMPTY_FIELDS, []);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    current()
      .then((valid) => {
        if (!valid || cancelled) throw new Error("Session invalid");
        if (blocked.current) {
          requestStepUp("edit");
          throw new CosplayAdminClientError(
            "Verification required",
            403,
            "step_up_required",
            "step_up_required",
          );
        }
        return getCosplayPostAdmin(initialPostId, resumeDraft, ...identityArgs());
      })
      .then(async (detail) => {
        if (cancelled || !(await current())) return;
        const f: EditorFields = {
          title: detail.title,
          description: detail.description ?? "",
          characterName: detail.characterName ?? "",
          series: detail.series ?? "",
        };
        const p = [...detail.images]
          .sort((a, b) => a.position - b.position)
          .map(photoFromExisting);
        setLoadRetryRequired(false);
        setPostId(detail.id);
        setStatus(detail.status);
        setVersion(detail.version);
        setFields(f);
        setPhotos(p);
        markClean(f, p);
      })
      .catch((err: unknown) => {
        if (cancelled || !active()) return;
        if (
          err instanceof CosplayAdminClientError &&
          err.privilegedFailure === "unauthenticated"
        )
          sessionRef.current?.invalidate?.();
        if (
          err instanceof CosplayAdminClientError &&
          err.privilegedFailure === "step_up_required"
        ) {
          setLoadRetryRequired(true);
          requestStepUp("edit");
          return;
        }
        setLoadError(
          err instanceof CosplayAdminClientError ? err.message : "Error inesperado",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPostId, resumeDraft, loadAttempt]);

  // Sincroniza la cola de subida REAL con la lista de fotos del editor: nunca reemplaza metadata
  // editorial ya introducida, solo el estado/URL/errores derivados de la subida en curso.
  useEffect(() => {
    setPhotos((prev) => {
      const nextLocalIds = new Set(mediaUpload.items.map((i) => i.localId));
      const kept = prev
        .filter((p) => p.localId === null || nextLocalIds.has(p.localId))
        .map((p) => {
          if (p.localId === null) return p;
          const item = mediaUpload.items.find((i) => i.localId === p.localId);
          return item ? mergeUploadFields(p, item) : p;
        });
      const knownLocalIds = new Set(kept.map((p) => p.localId).filter(Boolean));
      const additions = mediaUpload.items
        .filter((item) => !knownLocalIds.has(item.localId))
        .map(photoFromQueueItem);
      return additions.length > 0 ? [...kept, ...additions] : kept;
    });
    setDirty(true);
  }, [mediaUpload.items]);

  // Handle each failed attempt once; clearing MFA does not replay a failed upload.
  useEffect(() => {
    const failures = new Set(
      mediaUpload.items
        .filter((item) => item.privilegedFailure === "step_up_required")
        .map((item) => item.localId),
    );
    const newFailure = [...failures].some((id) => !handledUploadFailures.current.has(id));
    handledUploadFailures.current = failures;
    if (newFailure) requestStepUp(postId === null ? "create" : "edit");
  }, [mediaUpload.items, postId, requestStepUp]);

  const remainingCapacity = MAX_COSPLAY_PHOTOS - photos.length;

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files).slice(0, Math.max(0, remainingCapacity));
      if (list.length === 0) return;
      mediaUpload.addFiles(list);
    },
    [mediaUpload, remainingCapacity],
  );

  const updateField = useCallback(
    <K extends keyof EditorFields>(key: K, value: EditorFields[K]) => {
      setFields((prev) => ({ ...prev, [key]: value }));
      setDirty(true);
    },
    [],
  );

  const setCover = useCallback((key: string) => {
    setPhotos((prev) => prev.map((p) => ({ ...p, isCover: p.key === key })));
    setDirty(true);
  }, []);

  const movePhoto = useCallback((key: string, delta: -1 | 1) => {
    setPhotos((prev) => {
      const index = prev.findIndex((p) => p.key === key);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
    setDirty(true);
  }, []);

  /** Foto NUNCA adjunta a la publicación (subida en esta sesión, sin confirmar aún): usa
   *  exactamente el mismo abort/orphan de useMediaUpload (que ya llama a abortMediaUpload en el
   *  servidor) — nunca borra nada directamente en R2 desde el navegador. Sin confirmación: no es
   *  una operación destructiva sobre una publicación real. */
  const removeNewPhoto = useCallback(
    (key: string) => {
      const photo = photos.find((p) => p.key === key);
      if (!photo || photo.localId === null) return;
      mediaUpload.remove(photo.localId);
      setDirty(true);
    },
    [photos, mediaUpload],
  );

  const requestRemoveExisting = useCallback((key: string) => {
    setPendingDetachKey(key);
  }, []);
  const cancelRemoveExisting = useCallback(() => setPendingDetachKey(null), []);

  /** Foto YA adjunta: acción destructiva real (sección 14/F del checkpoint 2) — exige
   *  confirmación explícita (ya reunida antes de llamar a esto) y usa el ciclo de vida de
   *  desadjuntar del backend, nunca un ocultamiento local. */
  const confirmRemoveExisting = useCallback(async () => {
    const key = pendingDetachKey;
    const photo = photos.find((p) => p.key === key);
    if (
      !key ||
      !photo ||
      photo.existingImageId === null ||
      postId === null ||
      version === null
    ) {
      setPendingDetachKey(null);
      return;
    }
    if (operationPending.current || !active()) return;
    operationPending.current = true;
    setDetaching(true);
    setDetachErrorKey(null);
    try {
      if (!(await current())) return;
      if (blocked.current) {
        requestStepUp("edit");
        return;
      }
      const result = await detachCosplayMedia(
        {
          postId,
          expectedVersion: version,
          imageId: photo.existingImageId,
        },
        ...identityArgs(),
      );
      if (!(await current())) return;
      setVersion(result.version);
      setPhotos((prev) => prev.filter((p) => p.key !== key));
      setPendingDetachKey(null);
      onPostChanged?.(status);
      return true;
    } catch (err) {
      if (!active()) return;
      if (err instanceof CosplayAdminClientError) {
        if (err.privilegedFailure === "unauthenticated")
          sessionRef.current?.invalidate?.();
        if (err.privilegedFailure === "step_up_required") {
          requestStepUp("edit");
          setPendingDetachKey(null);
          return;
        }
        if (err.code === "cosplay_version_conflict") {
          setConflict({ kind: "version" });
          setPendingDetachKey(null);
          return;
        }
      }
      // Fallo recuperable (p. ej. limpieza de R2 parcial ya reportada como cleaned:false por el
      // propio 200, o un error real de red): la confirmación se mantiene abierta para reintentar.
      setDetachErrorKey(key);
    } finally {
      operationPending.current = false;
      if (active()) setDetaching(false);
    }
  }, [
    pendingDetachKey,
    photos,
    postId,
    version,
    onPostChanged,
    status,
    current,
    active,
    requestStepUp,
    identityArgs,
  ]);

  const canSave = useMemo(() => {
    if (fields.title.trim().length === 0) return false;
    return !photos.some(
      (p) =>
        p.localId !== null &&
        NON_TERMINAL_UPLOAD_STATUSES.has(p.uploadStatus as MediaItemStatus),
    );
  }, [fields, photos]);

  // Alt/caption/decorativa ya no son campos editables del editor (ajuste UX posterior a 9I-3):
  // cada foto se envía SIEMPRE como no decorativa, sin leyenda, con un texto alternativo derivado
  // automáticamente del título canónico de la publicación (nunca vacío mientras haya título, que
  // es requisito para poder guardar — ver canSave). Esto conserva accesibilidad real sin pedirle
  // al ADMIN que escriba un alt a mano por cada foto.
  const buildImagesPayload = useCallback((): CosplayEditorImageInput[] => {
    const title = fields.title.trim();
    return photos
      .filter(
        (p) =>
          p.assetId !== null &&
          (p.uploadStatus === "ready" || p.uploadStatus === "existing"),
      )
      .map((p, index) => ({
        assetId: p.assetId!,
        position: index,
        isCover: p.isCover,
        decorative: false,
        alt: emptyToNull(`${title} — foto ${index + 1}`),
        caption: null,
      }));
  }, [photos, fields.title]);

  const save = useCallback(
    async (desiredStatus: "draft" | "published") => {
      if (!canSave || operationPending.current || !active()) return;
      operationPending.current = true;
      setSaving(desiredStatus);
      setSaveErrorCode(null);
      try {
        if (!(await current())) return;
        if (blocked.current) {
          requestStepUp(postId === null ? "create" : "edit");
          return;
        }
        const result = await saveCosplayPost(
          {
            postId,
            expectedVersion: version,
            status: desiredStatus,
            title: fields.title.trim(),
            description: emptyToNull(fields.description),
            characterName: emptyToNull(fields.characterName),
            series: emptyToNull(fields.series),
            // Evento, Fecha (shotOn) y créditos del fotógrafo: eliminados del editor (Evento/Fecha
            // en la Fase "COSPLAY DETAIL REDESIGN"; fotógrafo, ajuste UX posterior a 9I-3). Los tres
            // siguen existiendo en el esquema/contrato (compatibilidad, sin migración) pero ya no se
            // recogen del ADMIN, así que siempre se envían null.
            event: null,
            shotOn: null,
            photographerCredit: null,
            images: buildImagesPayload(),
          },
          ...identityArgs(),
        );
        if (!(await current())) return;
        setPostId(result.post.id);
        setStatus(result.post.status);
        setVersion(result.post.version);
        const persistedPhotos = photos.map((photo) => {
          const image = result.images.find((image) => image.assetId === photo.assetId);
          return image
            ? {
                ...photo,
                existingImageId: image.id,
                localId: null,
                uploadStatus: "existing" as const,
                isCover: image.isCover,
              }
            : photo;
        });
        setPhotos(persistedPhotos);
        for (const photo of photos) {
          if (
            photo.localId &&
            result.images.some((image) => image.assetId === photo.assetId)
          ) {
            mediaUpload.release(photo.localId);
          }
        }
        markClean(fields, persistedPhotos);
        onPostChanged?.(result.post.status);
        return result;
      } catch (err) {
        if (!active()) return;
        if (err instanceof CosplayAdminClientError) {
          if (err.privilegedFailure === "unauthenticated")
            sessionRef.current?.invalidate?.();
          if (err.privilegedFailure === "step_up_required") {
            requestStepUp(postId === null ? "create" : "edit");
            return;
          }
          if (err.code === "cosplay_version_conflict") {
            setConflict({ kind: "version" });
            return;
          }
          setSaveErrorCode(err.code ?? "generic");
          return;
        }
        setSaveErrorCode("generic");
      } finally {
        operationPending.current = false;
        if (active()) setSaving(null);
      }
    },
    [
      current,
      active,
      requestStepUp,
      identityArgs,
      canSave,
      postId,
      version,
      fields,
      photos,
      buildImagesPayload,
      markClean,
      mediaUpload,
      onPostChanged,
    ],
  );

  const [deleting, setDeleting] = useState(false);
  const [deleteErrorCode, setDeleteErrorCode] = useState<string | null>(null);

  const confirmDelete = useCallback(async () => {
    if (postId === null || version === null) return false;
    if (operationPending.current || !active()) return false;
    operationPending.current = true;
    setDeleting(true);
    setDeleteErrorCode(null);
    try {
      if (!(await current())) return false;
      if (blocked.current) {
        requestStepUp("delete");
        return false;
      }
      await deleteCosplayPost({ postId, expectedVersion: version }, ...identityArgs());
      if (!(await current())) return false;
      onPostChanged?.(status);
      return true;
    } catch (err) {
      if (!active()) return false;
      if (err instanceof CosplayAdminClientError) {
        if (err.privilegedFailure === "unauthenticated")
          sessionRef.current?.invalidate?.();
        if (err.privilegedFailure === "step_up_required") {
          requestStepUp("delete");
          return false;
        }
        if (err.code === "cosplay_version_conflict") {
          setConflict({ kind: "version" });
          return false;
        }
        setDeleteErrorCode(err.code ?? "generic");
        return false;
      }
      setDeleteErrorCode("generic");
      return false;
    } finally {
      operationPending.current = false;
      if (active()) setDeleting(false);
    }
  }, [
    postId,
    version,
    onPostChanged,
    status,
    current,
    active,
    requestStepUp,
    identityArgs,
  ]);

  const reloadFromServer = useCallback(async () => {
    if (postId === null || !(await current())) return;
    if (blocked.current) {
      requestStepUp("edit");
      return;
    }
    setConflict(null);
    setLoading(true);
    try {
      const detail = await getCosplayPostAdmin(postId, resumeDraft, ...identityArgs());
      if (!(await current())) return;
      const f: EditorFields = {
        title: detail.title,
        description: detail.description ?? "",
        characterName: detail.characterName ?? "",
        series: detail.series ?? "",
      };
      const p = [...detail.images]
        .sort((a, b) => a.position - b.position)
        .map(photoFromExisting);
      setStatus(detail.status);
      setVersion(detail.version);
      setFields(f);
      setPhotos(p);
      markClean(f, p);
    } catch (err) {
      if (!active()) return;
      if (
        err instanceof CosplayAdminClientError &&
        err.privilegedFailure === "step_up_required"
      ) {
        requestStepUp("edit");
        return;
      }
      setLoadError(
        err instanceof CosplayAdminClientError ? err.message : "Error inesperado",
      );
    } finally {
      setLoading(false);
    }
  }, [postId, resumeDraft, markClean, active, current, requestStepUp, identityArgs]);

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        f: fields,
        p: photos.map((x) => ({ assetId: x.assetId, isCover: x.isCover })),
      }),
    [fields, photos],
  );
  const isDirty = dirty && currentSnapshot !== savedSnapshotRef.current;

  return {
    postId,
    status,
    version,
    fields,
    photos,
    loading,
    loadError,
    loadRetryRequired,
    retryInitialLoad: () => setLoadAttempt((attempt) => attempt + 1),
    saving,
    saveErrorCode,
    conflict,
    stepUpIntent,
    clearStepUpIntent: () => {
      blocked.current = false;
      setStepUpIntent(null);
    },
    cancelStepUp: () => setStepUpIntent(null),
    isDirty,
    canSave,
    remainingCapacity,
    updateField,
    addFiles,
    setCover,
    movePhoto,
    removeNewPhoto,
    pendingDetachKey,
    requestRemoveExisting,
    cancelRemoveExisting,
    confirmRemoveExisting,
    detaching,
    detachErrorKey,
    retryUpload: mediaUpload.retry,
    save,
    deleting,
    deleteErrorCode,
    confirmDelete,
    reloadFromServer,
  };
}
