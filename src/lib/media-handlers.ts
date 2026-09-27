import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import { isProductionEnvironment } from "./instagram-oauth-shared.js";
import {
  canTransition,
  isSourceMimeType,
  MULTIPART_PART_SIZE_BYTES,
  multipartPartCount,
  privateObjectKey,
  publicVariantKey,
  stagingKey,
  usesMultipart,
  validateReservationInput,
  type MediaAssetStatus,
} from "./media-domain.js";
import {
  abortPrivateMultipartUpload,
  completePrivateMultipartUpload,
  copyPrivateObject,
  createPrivateMultipartUpload,
  deletePrivateObject,
  deletePublicVariants,
  getPrivateObjectBytes,
  headPrivateObject,
  presignPrivatePut,
  presignPrivateUploadPart,
  publicVariantUrl,
  putPublicVariant,
  PRESIGN_TTL_MULTIPART_PART_SECONDS,
  PRESIGN_TTL_SINGLE_PUT_SECONDS,
  type CompletedPart,
} from "./r2-client.js";
import { processImage, ProcessingFailure } from "./media-processing.js";

// Handlers HTTP del pipeline de medios (Fase 9I-2B): reserva, completar subida (verificar +
// procesar) y abortar. Privilegiado: cada handler exige ADMIN + capacidad cosplay_admin + MFA
// reciente en CADA request (nunca se confía en un estado previo). Despachados desde
// api/media/[resource].ts (función 12/12 del plan Hobby), igual que api/content/[resource].ts.
//
// Genérico a propósito (domain como parámetro, hoy solo "cosplay" es válido porque es lo único
// que admite el CHECK de media_assets) para que la Fase 9J (Community) reutilice este mismo
// dispatcher sin sumar otro.

const GENERIC_ERROR_BODY = { error: "Error interno" };
const BAD_REQUEST_BODY = { error: "Solicitud inválida" };
const NOT_FOUND_BODY = { error: "No encontrado" };
/** Lista cerrada de dominios soportados HOY. Ampliarla (p. ej. "community") exige antes una
 *  migración que amplíe media_assets_domain_check — nunca se asume aquí. */
const SUPPORTED_DOMAINS = new Set(["cosplay"]);

interface MediaAssetRow {
  id: string;
  domain: string;
  status: MediaAssetStatus;
  source_mime: string | null;
  source_bytes: number | null;
  private_original_key: string | null;
  multipart_upload_id: string | null;
  processing_attempts: number;
}

function parseJsonBody(req: VercelRequest): Record<string, unknown> | null {
  const raw = req.body;
  const parsed = typeof raw === "string" ? tryParseJson(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getServiceRoleClient(): SupabaseClient | null {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Autorización (Fase 9I-2, sección 6): autenticado + cosplay_admin ACTUAL + MFA reciente, en ESE
 *  orden (requireCapability ya lo garantiza — ver admin-auth.ts). Se repite en cada handler, en
 *  cada request: ninguna operación de este archivo confía en un estado de autorización previo. */
async function authorize(
  req: VercelRequest,
): Promise<{ userId: string } | { status: number; body: unknown }> {
  try {
    const identity = await requireCapability(req, "cosplay_admin");
    return { userId: identity.userId };
  } catch (err) {
    if (err instanceof AdminAuthError)
      return { status: err.status, body: authErrorBody(err) };
    return { status: 500, body: GENERIC_ERROR_BODY };
  }
}

/** Guarda de entorno (Fase 9I-2, sección 7): la infraestructura R2 de HOY es exclusivamente DEV.
 *  Fail closed en Production, no una elección entre dos entornos — no existe ninguna credencial
 *  de Production todavía. */
function refuseIfProduction(res: VercelResponse): boolean {
  if (isProductionEnvironment()) {
    res.status(403).json({ error: "No disponible en este entorno" });
    return true;
  }
  return false;
}

async function setStatus(
  client: SupabaseClient,
  assetId: string,
  from: MediaAssetStatus,
  to: MediaAssetStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!canTransition(from, to)) {
    throw new Error(`transición de estado no permitida: ${from} → ${to}`);
  }
  // media_assets_failure_code_presence exige failure_code NULL fuera de status=failed: al
  // reintentar un asset failed→uploaded hay que limpiarlo aquí, o el UPDATE viola el CHECK antes
  // de que el reintento llegue a ejecutar nada (bug real, Fase 9I-2C: primer reintento real de
  // Edwin sobre un asset failed rompía en este punto, silenciado como "verification_failed").
  const payload =
    to === "failed"
      ? { status: to, ...extra }
      : { status: to, failure_code: null, ...extra };
  const { error } = await client.from("media_assets").update(payload).eq("id", assetId);
  if (error) throw error;
}

async function markFailed(
  client: SupabaseClient,
  assetId: string,
  from: MediaAssetStatus,
  failureCode: string,
): Promise<void> {
  // failed es alcanzable desde uploaded/verifying/processing (ver canTransition); si `from` no
  // admite failed (p. ej. ya estaba en reserved sin haber llegado a subir), no hay nada
  // aplicable que hacer más que dejar la fila como está — no debería ocurrir en el flujo real.
  if (!canTransition(from, "failed")) return;
  await client
    .from("media_assets")
    .update({ status: "failed", failure_code: failureCode })
    .eq("id", assetId);
}

interface ParsedPart {
  partNumber: number;
  etag: string;
}

function normalizeParts(value: unknown): ParsedPart[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parts: ParsedPart[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { partNumber, etag } = entry as Record<string, unknown>;
    if (
      typeof partNumber !== "number" ||
      !Number.isInteger(partNumber) ||
      partNumber < 1
    ) {
      return null;
    }
    if (typeof etag !== "string" || etag.length === 0) return null;
    parts.push({ partNumber, etag });
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  return parts;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/media/reserve

export async function handleMediaReserve(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const auth = await authorize(req);
  if ("status" in auth) return res.status(auth.status).json(auth.body);
  if (refuseIfProduction(res)) return res;

  const body = parseJsonBody(req);
  if (!body) return res.status(400).json(BAD_REQUEST_BODY);

  const domain = body.domain;
  if (typeof domain !== "string" || !SUPPORTED_DOMAINS.has(domain)) {
    return res.status(400).json(BAD_REQUEST_BODY);
  }

  const validated = validateReservationInput({
    sourceMime: body.sourceMime,
    sourceBytes: body.sourceBytes,
    sourceWidth: body.sourceWidth,
    sourceHeight: body.sourceHeight,
  });
  if (!validated.ok)
    return res.status(400).json({ error: "Solicitud inválida", code: validated.error });

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  const { sourceMime, sourceBytes, sourceWidth, sourceHeight } = validated.value;
  const assetId = randomUUID();
  const staging = stagingKey(domain, assetId, sourceMime);

  const { error: insertError } = await client.from("media_assets").insert({
    id: assetId,
    domain,
    kind: "image",
    status: "reserved",
    source_mime: sourceMime,
    source_bytes: sourceBytes,
    source_width: sourceWidth,
    source_height: sourceHeight,
    private_original_key: staging,
    pipeline_version: "img-v1",
    created_by: auth.userId,
  });
  if (insertError) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    if (usesMultipart(sourceBytes)) {
      const uploadId = await createPrivateMultipartUpload(staging, sourceMime);
      await client
        .from("media_assets")
        .update({ multipart_upload_id: uploadId })
        .eq("id", assetId);

      const partCount = multipartPartCount(sourceBytes);
      const parts = await Promise.all(
        Array.from({ length: partCount }, (_, i) => i + 1).map(async (partNumber) => ({
          partNumber,
          url: await presignPrivateUploadPart(staging, uploadId, partNumber),
        })),
      );

      return res.status(200).json({
        assetId,
        mode: "multipart",
        uploadId,
        partSize: MULTIPART_PART_SIZE_BYTES,
        parts,
        expiresInSeconds: PRESIGN_TTL_MULTIPART_PART_SECONDS,
      });
    }

    const uploadUrl = await presignPrivatePut(staging, sourceMime);
    return res.status(200).json({
      assetId,
      mode: "single",
      uploadUrl,
      expiresInSeconds: PRESIGN_TTL_SINGLE_PUT_SECONDS,
    });
  } catch {
    // R2 falló al crear/firmar la subida: el cliente NUNCA llegó a recibir este assetId (la
    // respuesta 500 se envía en vez del 200 que lo habría revelado), así que no hay nada que
    // reintentar contra él — igual que un aborto, se borra la fila en vez de dejarla "reserved"
    // (estado que canTransition ni siquiera permite llevar a failed: reserved solo avanza a
    // uploaded/deleting, nunca directo a failed, porque failed describe un intento de subida que
    // SÍ llegó a empezar).
    await client.from("media_assets").delete().eq("id", assetId);
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/media/complete

async function readyResponseBody(
  client: SupabaseClient,
  row: Pick<MediaAssetRow, "id">,
): Promise<{
  assetId: string;
  status: "ready";
  variants: {
    variant: number;
    width: number;
    height: number;
    bytes: number;
    url: string;
  }[];
}> {
  const { data } = await client
    .from("media_asset_variants")
    .select("variant, width, height, bytes, storage_key")
    .eq("asset_id", row.id);
  const rows = (data ?? []) as {
    variant: number;
    width: number;
    height: number;
    bytes: number;
    storage_key: string;
  }[];
  return {
    assetId: row.id,
    status: "ready",
    variants: rows.map((v) => ({
      variant: v.variant,
      width: v.width,
      height: v.height,
      bytes: v.bytes,
      url: publicVariantUrl(v.storage_key),
    })),
  };
}

export async function handleMediaComplete(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const auth = await authorize(req);
  if ("status" in auth) return res.status(auth.status).json(auth.body);
  if (refuseIfProduction(res)) return res;

  const body = parseJsonBody(req);
  const assetId = body?.assetId;
  if (typeof assetId !== "string" || assetId.length === 0) {
    return res.status(400).json(BAD_REQUEST_BODY);
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  const { data, error } = await client
    .from("media_assets")
    .select(
      "id, domain, status, source_mime, source_bytes, private_original_key, multipart_upload_id, processing_attempts",
    )
    .eq("id", assetId)
    .maybeSingle();
  if (error) return res.status(500).json(GENERIC_ERROR_BODY);
  if (!data) return res.status(404).json(NOT_FOUND_BODY);
  const row = data as unknown as MediaAssetRow;

  // Idempotencia (sección 20/28): un reintento del MISMO request nunca reprocesa ni duplica.
  if (row.status === "ready")
    return res.status(200).json(await readyResponseBody(client, row));
  if (row.status === "processing" || row.status === "verifying") {
    return res.status(200).json({ assetId, status: row.status });
  }
  if (row.status !== "reserved" && row.status !== "uploaded" && row.status !== "failed") {
    return res.status(409).json({ error: "Estado no válido para completar" });
  }
  if (
    !row.source_mime ||
    !row.source_bytes ||
    !row.private_original_key ||
    !isSourceMimeType(row.source_mime)
  ) {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  let currentStatus: MediaAssetStatus = row.status;

  // 1) Completar multipart si esta reserva usó multipart.
  if (row.multipart_upload_id) {
    const parts = normalizeParts(body?.parts);
    if (!parts) return res.status(400).json(BAD_REQUEST_BODY);
    try {
      const completedParts: CompletedPart[] = parts.map((p) => ({
        partNumber: p.partNumber,
        etag: p.etag,
      }));
      await completePrivateMultipartUpload(
        row.private_original_key,
        row.multipart_upload_id,
        completedParts,
      );
    } catch {
      return res.status(400).json({ error: "No se pudo completar la subida multipart" });
    }
    await client
      .from("media_assets")
      .update({ multipart_upload_id: null })
      .eq("id", assetId);
  }

  try {
    await setStatus(client, assetId, currentStatus, "uploaded");
    currentStatus = "uploaded";

    // 2) Verificar: el objeto existe en R2 y su tamaño coincide con lo declarado en la reserva.
    await setStatus(client, assetId, currentStatus, "verifying");
    currentStatus = "verifying";

    const head = await headPrivateObject(row.private_original_key);
    if (!head || head.bytes !== row.source_bytes) {
      await markFailed(client, assetId, currentStatus, "upload_incomplete");
      return res
        .status(200)
        .json({ assetId, status: "failed", failureCode: "upload_incomplete" });
    }

    // 3) Copiar a objects/ (privado permanente) ANTES de procesar: staging/ expira a los 3 días.
    //    Idempotente a propósito (bug real, Fase 9I-2C): en un REINTENTO tras un intento previo
    //    que ya completó esta copia, row.private_original_key YA es la clave permanente. Repetir
    //    copyPrivateObject+deletePrivateObject en ese caso copia el objeto sobre sí mismo y luego
    //    lo BORRA, destruyendo el original antes de poder procesarlo. Solo se copia/borra cuando
    //    la clave actual sigue siendo la de staging.
    const permanentKey = privateObjectKey(row.domain, assetId, row.source_mime as never);
    if (row.private_original_key !== permanentKey) {
      await copyPrivateObject(row.private_original_key, permanentKey);
      await client
        .from("media_assets")
        .update({ private_original_key: permanentKey })
        .eq("id", assetId);
      await deletePrivateObject(row.private_original_key).catch(() => undefined);
    }

    // 4) Procesar.
    await setStatus(client, assetId, currentStatus, "processing", {
      processing_attempts: row.processing_attempts + 1,
    });
    currentStatus = "processing";

    const bytes = await getPrivateObjectBytes(permanentKey);
    const sourceMime = row.source_mime as Parameters<typeof processImage>[1];
    const processed = await processImage(bytes, sourceMime);

    // 5) Subir variantes públicas. Si alguna falla a mitad, limpia las que sí llegaron a subirse
    //    (sección 28: nunca dejar bytes públicos huérfanos ni un ready parcial).
    const uploaded: {
      variant: number;
      width: number;
      height: number;
      bytes: number;
      storageKey: string;
    }[] = [];
    try {
      for (const variant of processed.variants) {
        const key = publicVariantKey(row.domain, assetId, variant.variant);
        await putPublicVariant(key, variant.buffer, "image/webp");
        uploaded.push({
          variant: variant.variant,
          width: variant.width,
          height: variant.height,
          bytes: variant.bytes,
          storageKey: key,
        });
      }
    } catch {
      await deletePublicVariants(uploaded.map((u) => u.storageKey)).catch(
        () => undefined,
      );
      await markFailed(client, assetId, currentStatus, "processing_failed");
      return res
        .status(200)
        .json({ assetId, status: "failed", failureCode: "processing_failed" });
    }

    const { error: variantsError } = await client.from("media_asset_variants").insert(
      uploaded.map((u) => ({
        asset_id: assetId,
        variant: u.variant,
        width: u.width,
        height: u.height,
        bytes: u.bytes,
        storage_key: u.storageKey,
      })),
    );
    if (variantsError) {
      await deletePublicVariants(uploaded.map((u) => u.storageKey)).catch(
        () => undefined,
      );
      await markFailed(client, assetId, currentStatus, "processing_failed");
      return res
        .status(200)
        .json({ assetId, status: "failed", failureCode: "processing_failed" });
    }

    const primary = uploaded.reduce((a, b) => (a.variant > b.variant ? a : b));
    const { error: readyError } = await client
      .from("media_assets")
      .update({
        status: "ready",
        failure_code: null,
        mime: "image/webp",
        width: primary.width,
        height: primary.height,
        bytes: primary.bytes,
        storage_key: primary.storageKey,
        private_original_key: null,
      })
      .eq("id", assetId);
    if (readyError) {
      await markFailed(client, assetId, currentStatus, "processing_failed");
      return res
        .status(200)
        .json({ assetId, status: "failed", failureCode: "processing_failed" });
    }

    // El original privado solo se borra DESPUÉS de confirmar ready (sección 26: nunca antes de
    // que todas las variantes requeridas estén verificadas).
    await deletePrivateObject(permanentKey).catch(() => undefined);

    return res.status(200).json({
      assetId,
      status: "ready",
      variants: uploaded.map((u) => ({
        variant: u.variant,
        width: u.width,
        height: u.height,
        bytes: u.bytes,
        url: publicVariantUrl(u.storageKey),
      })),
    });
  } catch (err) {
    if (err instanceof ProcessingFailure) {
      await markFailed(client, assetId, currentStatus, err.code);
      return res.status(200).json({ assetId, status: "failed", failureCode: err.code });
    }
    await markFailed(client, assetId, currentStatus, "verification_failed");
    return res
      .status(200)
      .json({ assetId, status: "failed", failureCode: "verification_failed" });
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/media/abort — cancela una reserva EN CURSO (nunca un asset ya ready: eso es borrado,
// no aborto, y no existe todavía ningún flujo que enlace un asset ready a una publicación en
// 9I-2B). Limpieza completa: no deja una fila "failed" de relleno por una cancelación rutinaria.

export async function handleMediaAbort(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const auth = await authorize(req);
  if ("status" in auth) return res.status(auth.status).json(auth.body);
  if (refuseIfProduction(res)) return res;

  const body = parseJsonBody(req);
  const assetId = body?.assetId;
  if (typeof assetId !== "string" || assetId.length === 0) {
    return res.status(400).json(BAD_REQUEST_BODY);
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  const { data, error } = await client
    .from("media_assets")
    .select("id, private_original_key, multipart_upload_id, status")
    .eq("id", assetId)
    .maybeSingle();
  if (error) return res.status(500).json(GENERIC_ERROR_BODY);
  if (!data) return res.status(404).json(NOT_FOUND_BODY);
  const row = data as unknown as Pick<
    MediaAssetRow,
    "id" | "private_original_key" | "multipart_upload_id" | "status"
  >;

  if (!["reserved", "uploaded", "failed"].includes(row.status)) {
    return res
      .status(409)
      .json({ error: "Este asset no se puede abortar en su estado actual" });
  }

  if (row.multipart_upload_id && row.private_original_key) {
    await abortPrivateMultipartUpload(
      row.private_original_key,
      row.multipart_upload_id,
    ).catch(() => undefined);
  }
  if (row.private_original_key) {
    await deletePrivateObject(row.private_original_key).catch(() => undefined);
  }

  const { error: deleteError } = await client
    .from("media_assets")
    .delete()
    .eq("id", assetId);
  if (deleteError) return res.status(500).json(GENERIC_ERROR_BODY);

  return res.status(200).json({ assetId, status: "deleted" });
}
