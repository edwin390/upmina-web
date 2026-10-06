import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isAssetUuid } from "./media-delivery-protocol.js";
import { deletePrivateObject, deletePublicVariants } from "./r2-client.js";

// R4-E2: motor físico de GC de medios. Dos piezas:
//
//   1. deleteMediaAssetObjects: LA primitiva de borrado físico. Recibe objetos ya derivados por
//      código de confianza (filas propias del asset, nunca una clave de una petición), vuelve a
//      comprobar que cada clave pertenece a ESE asset y dominio ANTES de borrar nada, y solo
//      devuelve ok si TODOS los borrados fueron éxito (o ya estaban ausentes).
//   2. runMediaGcBatch: reclama un lote en la BD (community_asset_gc_claim), obtiene los objetos
//      de cada asset de la propia BD con su token (community_asset_gc_objects), borra, y solo
//      DESPUÉS finaliza (community_asset_gc_finalize). Ante cualquier fallo registra
//      community_asset_gc_fail con una clase acotada. El backend NUNCA toca las columnas purge_*.
//
// Finalizar es siempre el último paso: si R2 borró pero la finalización falla, el siguiente run
// repite el borrado (idempotente: clave ausente = éxito) y vuelve a finalizar.

export const GC_BATCH_LIMIT = 20;
export const GC_LEASE_SECONDS = 300;

export const GC_ERROR_CLASSES = [
  "r2_public_delete_failed",
  "r2_private_delete_failed",
  "r2_partial_delete",
  "invalid_object_reference",
  "gc_objects_failed",
  "gc_finalize_failed",
] as const;
export type GcErrorClass = (typeof GC_ERROR_CLASSES)[number];

const GC_DOMAINS = new Set(["community", "cosplay"]);

// ── Propiedad de las claves (espejo EXACTO de community_asset_gc_objects en la migración 20261020)

const COMMUNITY_PUBLIC_FILE =
  /^(?:w(?:480|960|1600|2560)\.webp|original\.(?:mp4|mov|webm))$/;
const COSPLAY_PUBLIC_FILE = /^w(?:480|960|1600|2560)\.webp$/;
const PRIVATE_FILE = /^original\.(?:jpg|png|webp|heic|heif|avif|mp4|mov|webm)$/;

export function isOwnedPublicKey(domain: string, assetId: string, key: string): boolean {
  if (!GC_DOMAINS.has(domain) || !isAssetUuid(assetId) || typeof key !== "string")
    return false;
  const prefix = `${domain}/${assetId}/`;
  if (!key.startsWith(prefix)) return false;
  const file = key.slice(prefix.length);
  return (domain === "community" ? COMMUNITY_PUBLIC_FILE : COSPLAY_PUBLIC_FILE).test(
    file,
  );
}

export function isOwnedPrivateKey(domain: string, assetId: string, key: string): boolean {
  if (!GC_DOMAINS.has(domain) || !isAssetUuid(assetId) || typeof key !== "string")
    return false;
  for (const area of ["staging", "objects"]) {
    const prefix = `${area}/${domain}/${assetId}/`;
    if (key.startsWith(prefix) && PRIVATE_FILE.test(key.slice(prefix.length)))
      return true;
  }
  return false;
}

export interface AssetObjects {
  assetId: string;
  domain: string;
  publicKeys: string[];
  privateKeys: string[];
}

/** Deriva los objetos de un asset desde SUS propias filas (media_assets + variantes). Imagen:
 *  variantes (+ storage_key, que es la variante principal). Vídeo: storage_key es el ÚNICO objeto
 *  público y no tiene variantes. Las claves que no pertenecen al asset/dominio se cuentan en
 *  `rejected` y NO se devuelven. */
export function deriveAssetObjects(
  asset: {
    id: string;
    domain: string;
    storage_key: string | null;
    private_original_key: string | null;
  },
  variantKeys: string[],
): { objects: AssetObjects; rejected: number } {
  const publicCandidates = new Set<string>(variantKeys);
  if (asset.storage_key) publicCandidates.add(asset.storage_key);
  const publicKeys: string[] = [];
  const privateKeys: string[] = [];
  let rejected = 0;
  for (const key of [...publicCandidates].sort()) {
    if (isOwnedPublicKey(asset.domain, asset.id, key)) publicKeys.push(key);
    else rejected++;
  }
  if (asset.private_original_key) {
    if (isOwnedPrivateKey(asset.domain, asset.id, asset.private_original_key))
      privateKeys.push(asset.private_original_key);
    else rejected++;
  }
  return {
    objects: { assetId: asset.id, domain: asset.domain, publicKeys, privateKeys },
    rejected,
  };
}

// ── Primitiva de borrado físico

export interface PhysicalDeleteIo {
  deletePublic(keys: string[]): Promise<void>;
  deletePrivate(key: string): Promise<void>;
}
const defaultIo: PhysicalDeleteIo = {
  deletePublic: deletePublicVariants,
  deletePrivate: deletePrivateObject,
};

export type PhysicalDeleteResult = { ok: true } | { ok: false; errorClass: GcErrorClass };

export async function deleteMediaAssetObjects(
  objects: AssetObjects,
  io: PhysicalDeleteIo = defaultIo,
): Promise<PhysicalDeleteResult> {
  const publicKeys = [...new Set(objects.publicKeys)];
  const privateKeys = [...new Set(objects.privateKeys)];
  // Fail-closed ANTES de cualquier borrado: una sola clave ajena invalida todo el asset.
  if (
    !publicKeys.every((k) => isOwnedPublicKey(objects.domain, objects.assetId, k)) ||
    !privateKeys.every((k) => isOwnedPrivateKey(objects.domain, objects.assetId, k))
  )
    return { ok: false, errorClass: "invalid_object_reference" };

  let failure: GcErrorClass | null = null;
  if (publicKeys.length > 0) {
    try {
      await io.deletePublic(publicKeys);
    } catch (error) {
      // Por nombre (no instanceof): tolera módulos r2-client sustituidos en tests.
      failure =
        (error as { name?: unknown } | null)?.name === "R2PartialDeleteError"
          ? "r2_partial_delete"
          : "r2_public_delete_failed";
    }
  }
  for (const key of privateKeys) {
    try {
      await io.deletePrivate(key);
    } catch {
      failure ??= "r2_private_delete_failed";
    }
  }
  return failure ? { ok: false, errorClass: failure } : { ok: true };
}

// ── Motor de lote

export interface GcDb {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface GcRunSummary {
  claimed: number;
  finalized: number;
  alreadyGone: number;
  failed: number;
  stale: number;
  blocked: number;
  failRecordFailed: number;
  malformed: number;
  errorClasses: Partial<Record<GcErrorClass, number>>;
}

export class GcUnavailableError extends Error {
  constructor() {
    super("GC unavailable");
    this.name = "GcUnavailableError";
  }
}

export function getGcServiceClient(): GcDb | null {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  const client: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

interface ClaimedAsset {
  assetId: string;
  domain: string;
  claimToken: string;
}

function parseClaimed(raw: unknown): { claimed: ClaimedAsset[]; malformed: number } {
  const list =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { claimed?: unknown }).claimed)
      ? ((raw as { claimed: unknown[] }).claimed as unknown[])
      : null;
  if (!list) throw new GcUnavailableError();
  const claimed: ClaimedAsset[] = [];
  let malformed = 0;
  for (const item of list.slice(0, GC_BATCH_LIMIT)) {
    const r = item as Record<string, unknown> | null;
    if (
      r &&
      typeof r.assetId === "string" &&
      isAssetUuid(r.assetId) &&
      typeof r.domain === "string" &&
      GC_DOMAINS.has(r.domain) &&
      typeof r.claimToken === "string" &&
      isAssetUuid(r.claimToken)
    )
      claimed.push({ assetId: r.assetId, domain: r.domain, claimToken: r.claimToken });
    else malformed++;
  }
  return { claimed, malformed };
}

type Outcome = "finalized" | "alreadyGone" | "failed" | "stale" | "blocked";

export async function runMediaGcBatch(
  deps: {
    db?: GcDb | null;
    io?: PhysicalDeleteIo;
    log?: (message: string) => void;
  } = {},
): Promise<GcRunSummary> {
  const db = deps.db === undefined ? getGcServiceClient() : deps.db;
  if (!db) throw new GcUnavailableError();
  const io = deps.io ?? defaultIo;
  const log = deps.log ?? ((m: string) => console.error(m));

  const summary: GcRunSummary = {
    claimed: 0,
    finalized: 0,
    alreadyGone: 0,
    failed: 0,
    stale: 0,
    blocked: 0,
    failRecordFailed: 0,
    malformed: 0,
    errorClasses: {},
  };

  const claim = await db.rpc("community_asset_gc_claim", {
    p_limit: GC_BATCH_LIMIT,
    p_lease_seconds: GC_LEASE_SECONDS,
  });
  if (claim.error) throw new GcUnavailableError();
  const { claimed, malformed } = parseClaimed(claim.data);
  summary.claimed = claimed.length;
  summary.malformed = malformed;

  const recordFailure = async (asset: ClaimedAsset, errorClass: GcErrorClass) => {
    summary.errorClasses[errorClass] = (summary.errorClasses[errorClass] ?? 0) + 1;
    log(`[media-gc] asset=${asset.assetId} failed class=${errorClass}`);
    let recorded: { data: unknown; error: unknown };
    try {
      recorded = await db.rpc("community_asset_gc_fail", {
        p_asset_id: asset.assetId,
        p_claim_token: asset.claimToken,
        p_error_class: errorClass,
      });
    } catch {
      summary.failRecordFailed++;
      return "failed" as Outcome;
    }
    const result = (recorded.data as { result?: unknown } | null)?.result;
    if (
      recorded.error ||
      (result !== "retry_scheduled" &&
        result !== "invalid_claim" &&
        result !== "already_gone")
    ) {
      // No se manipula purge_* desde aquí: el lease vencerá y otro run lo reclamará.
      summary.failRecordFailed++;
      return "failed" as Outcome;
    }
    return result === "retry_scheduled" ? ("failed" as Outcome) : ("stale" as Outcome);
  };

  for (const asset of claimed) {
    let outcome: Outcome;
    try {
      outcome = await processAsset(asset);
    } catch {
      outcome = await recordFailure(asset, "gc_objects_failed");
    }
    summary[outcome]++;
  }
  return summary;

  async function processAsset(asset: ClaimedAsset): Promise<Outcome> {
    const lookup = await db!.rpc("community_asset_gc_objects", {
      p_asset_id: asset.assetId,
      p_claim_token: asset.claimToken,
    });
    if (lookup.error) return recordFailure(asset, "gc_objects_failed");
    const data = lookup.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || data.valid !== true) {
      // Lease/token ya no vigentes (otro run lo reclamó o el asset desapareció): no es un fallo.
      return "stale";
    }
    const publicKeys = data.publicKeys;
    const privateKeys = data.privateKeys;
    if (
      data.assetId !== asset.assetId ||
      data.domain !== asset.domain ||
      !Array.isArray(publicKeys) ||
      !Array.isArray(privateKeys) ||
      !publicKeys.every((k) => typeof k === "string") ||
      !privateKeys.every((k) => typeof k === "string") ||
      typeof data.rejectedKeys !== "number"
    )
      return recordFailure(asset, "invalid_object_reference");
    if (data.rejectedKeys > 0) return recordFailure(asset, "invalid_object_reference");

    const deleted = await deleteMediaAssetObjects(
      {
        assetId: asset.assetId,
        domain: asset.domain,
        publicKeys: publicKeys as string[],
        privateKeys: privateKeys as string[],
      },
      io,
    );
    // `in` narrows without strictNullChecks too (the remote @vercel/node compile is not strict).
    if ("errorClass" in deleted) return recordFailure(asset, deleted.errorClass);

    // ÚLTIMO paso: finalizar solo tras confirmar todos los borrados.
    let finalized: { data: unknown; error: unknown };
    try {
      finalized = await db!.rpc("community_asset_gc_finalize", {
        p_asset_id: asset.assetId,
        p_claim_token: asset.claimToken,
      });
    } catch {
      return recordFailure(asset, "gc_finalize_failed");
    }
    if (finalized.error) return recordFailure(asset, "gc_finalize_failed");
    const result = (finalized.data as { result?: unknown } | null)?.result;
    if (result === "deleted") return "finalized";
    if (result === "already_gone") return "alreadyGone";
    if (result === "invalid_claim") return "stale";
    if (result === "blocked") return "blocked"; // la propia RPC ya registró asset_referenced
    return recordFailure(asset, "gc_finalize_failed");
  }
}
