import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { deleteMediaAssetObjects, deriveAssetObjects } from "./media-gc.js";

// Ciclo de vida seguro de medios de Cosplay (Fase 9I-3, checkpoint 2): primitivas reutilizables
// para la limpieza real en R2 de un media_asset ya transicionado a status='deleting' (por
// cosplay_admin_detach_image o cosplay_admin_delete_post — ver la migración 20261002120000), y
// para IDENTIFICAR (nunca borrar automáticamente) assets 'ready' de Cosplay huérfanos (sin
// publicación que los referencie). R4-E2: la limpieza inline comparte la primitiva física y la
// validación de claves de media-gc.ts (el GC programado, vía /api/media/gc, procesa los assets que
// esta limpieza inmediata no logre completar). Nada aquí barre assets 'ready' ni programa nada.

function getServiceRoleClient(): SupabaseClient | null {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface MediaAssetCleanupResult {
  assetId: string;
  cleaned: boolean;
}

/**
 * Limpieza INLINE (mejor esfuerzo inmediato) de un media_asset que YA está en status='deleting'.
 * R4-E2: usa la MISMA primitiva física y la MISMA validación de propiedad de claves que el motor
 * GC (media-gc.ts); si algo falla, el asset sigue 'deleting' y el GC programado lo recoge.
 *   - si la fila no existe o no está en 'deleting', no hace nada (cleaned: false, sin error);
 *   - las claves se derivan de las filas del propio asset (variantes + storage_key + original
 *     privado residual): imagen = variantes; vídeo = storage_key (sin variantes);
 *   - una clave que no pertenece al asset/dominio aborta TODO el borrado de ese asset;
 *   - DeleteObjects con errores parciales (Errors[]) cuenta como fallo, no como éxito;
 *   - SOLO si todos los borrados tuvieron éxito (o ya estaban ausentes) se borra la fila de
 *     media_assets (que cascada sobre media_asset_variants);
 *   - nunca toca las columnas purge_* (eso es del motor GC).
 */
export async function attemptMediaAssetCleanup(
  assetId: string,
): Promise<MediaAssetCleanupResult> {
  const client = getServiceRoleClient();
  if (!client) return { assetId, cleaned: false };

  const { data: assetRow, error: assetError } = await client
    .from("media_assets")
    .select("id, status, domain, storage_key, private_original_key")
    .eq("id", assetId)
    .maybeSingle();
  if (assetError || !assetRow) return { assetId, cleaned: false };
  const row = assetRow as {
    id: string;
    status: string;
    domain: string;
    storage_key: string | null;
    private_original_key: string | null;
  };
  if (row.status !== "deleting") return { assetId, cleaned: false };

  const { data: variantRows, error: variantError } = await client
    .from("media_asset_variants")
    .select("storage_key")
    .eq("asset_id", assetId);
  if (variantError || !Array.isArray(variantRows)) return { assetId, cleaned: false };

  const { objects, rejected } = deriveAssetObjects(
    { ...row, id: row.id ?? assetId },
    (variantRows as { storage_key: string }[]).map((v) => v.storage_key),
  );
  if (rejected > 0) return { assetId, cleaned: false };

  const deleted = await deleteMediaAssetObjects(objects);
  if (!deleted.ok) return { assetId, cleaned: false };

  const { error: deleteError } = await client
    .from("media_assets")
    .delete()
    .eq("id", assetId)
    .eq("status", "deleting");
  if (deleteError) return { assetId, cleaned: false };

  return { assetId, cleaned: true };
}

export interface OrphanCandidateFilter {
  /** Solo assets creados por este usuario (cuando la propiedad del ADMIN actor importe). */
  createdBy?: string;
  /** Antigüedad mínima en milisegundos desde created_at. Sin cron en este checkpoint: quien
   *  llame decide cuándo invocar esto; no hay ningún disparador automático. */
  minAgeMs?: number;
}

export interface OrphanCandidate {
  assetId: string;
  createdAt: string;
}

/**
 * Identifica (SOLO LECTURA, nunca muta nada) media_assets 'ready' de domain='cosplay' que no
 * tienen ninguna fila en cosplay_post_images (nunca se adjuntaron, o se desadjuntaron sin volver
 * a adjuntarse a otra publicación distinta de la que gestiona ese flujo). Nunca incluye:
 *   - assets de otro domain (filtro explícito, aunque hoy 'cosplay' es el único válido);
 *   - assets que no estén 'ready' (reserved/uploaded/verifying/processing/failed/deleting quedan
 *     fuera: no son huérfanos "listos para limpiar", son otros estados del ciclo de vida);
 *   - assets adjuntos a cualquier publicación.
 * NO se invoca desde ningún cron ni endpoint en este checkpoint (sección 13 del checkpoint).
 */
export async function findOrphanedReadyCosplayAssets(
  filter: OrphanCandidateFilter = {},
): Promise<OrphanCandidate[]> {
  const client = getServiceRoleClient();
  if (!client) return [];

  let query = client
    .from("media_assets")
    .select("id, created_at")
    .eq("domain", "cosplay")
    .eq("status", "ready");
  if (filter.createdBy) query = query.eq("created_by", filter.createdBy);
  if (filter.minAgeMs !== undefined) {
    query = query.lte("created_at", new Date(Date.now() - filter.minAgeMs).toISOString());
  }

  const { data, error } = await query;
  if (error || !Array.isArray(data)) return [];
  const rows = data as { id: string; created_at: string }[];
  if (rows.length === 0) return [];

  const candidateIds = rows.map((row) => row.id);
  const { data: attachedRows, error: attachedError } = await client
    .from("cosplay_post_images")
    .select("asset_id")
    .in("asset_id", candidateIds);
  if (attachedError || !Array.isArray(attachedRows)) return [];

  const attachedIds = new Set(
    (attachedRows as { asset_id: string }[]).map((r) => r.asset_id),
  );
  return rows
    .filter((row) => !attachedIds.has(row.id))
    .map((row) => ({ assetId: row.id, createdAt: row.created_at }));
}

/**
 * Transiciona UN asset huérfano elegible de 'ready' a 'deleting' (nunca lo borra directamente:
 * el borrado real de R2/fila lo hace attemptMediaAssetCleanup, reutilizado, nunca duplicado).
 * Reconfirma la elegibilidad (domain='cosplay', status='ready' TODAVÍA, sin fila de galería)
 * justo antes de mutar — nunca confía en una lista de candidatos potencialmente obsoleta.
 * Devuelve false sin lanzar si el asset ya no es elegible (p. ej. se adjuntó entretanto).
 */
export async function transitionOrphanToDeleting(assetId: string): Promise<boolean> {
  const client = getServiceRoleClient();
  if (!client) return false;

  const { data: attached } = await client
    .from("cosplay_post_images")
    .select("id")
    .eq("asset_id", assetId)
    .maybeSingle();
  if (attached) return false;

  const { data, error } = await client
    .from("media_assets")
    .update({ status: "deleting" })
    .eq("id", assetId)
    .eq("domain", "cosplay")
    .eq("status", "ready")
    .select("id");
  if (error || !Array.isArray(data) || data.length === 0) return false;
  return true;
}
