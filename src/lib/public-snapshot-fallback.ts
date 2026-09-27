import type { VercelResponse } from "@vercel/node";
import { isSnapshotFallbackEligible } from "./provider-http.js";
import {
  readSnapshot,
  writeSnapshot,
  type Snapshot,
  type SnapshotWriteOutcome,
} from "./public-snapshots.js";
import type {
  ProviderOf,
  SnapshotResource,
  SnapshotSourceId,
  SnapshotValue,
} from "./public-snapshot-resources.js";

// Pegamento entre un endpoint público y los snapshots last-known-good (Fase 9H-4, checkpoint 3).
// Solo servidor. NO contiene política de persistencia (eso es public-snapshots.ts) ni de
// elegibilidad (isSnapshotFallbackEligible en provider-http.ts): solo ordena el flujo de un
// endpoint para que todos lo usen igual.
//
// Flujo:
//   1. `openSnapshot` empieza a LEER el snapshot en paralelo con la llamada al proveedor: si el
//      proveedor falla tras 8 s no se le suma además la latencia de Supabase.
//   2. Éxito del proveedor → `save(valor)` (con `await`: una función se congela al responder) y se
//      responde con el contenido FRESCO, igual que siempre. `save` nunca lanza.
//   3. Fallo → `fallback(err)` devuelve el snapshot SOLO si el fallo es transitorio; si no, o si
//      no hay snapshot válido, devuelve `undefined` y el endpoint responde el error de siempre.
// El cuerpo público no cambia de forma: el snapshot ES el valor normalizado que devolvió el
// endpoint. El source_id nunca sale de aquí.

/** Caché de una respuesta servida desde un snapshot: corta, para recuperar el contenido fresco en
 *  cuanto el proveedor vuelva. Misma sintaxis que ya usan las respuestas parciales de los clips. */
export const SNAPSHOT_FALLBACK_CACHE_CONTROL = "s-maxage=60, stale-while-revalidate=120";

/** Cabecera de diagnóstico (solo servidor→operador). El frontend NO depende de ella. */
export const CONTENT_SOURCE_HEADER = "X-Content-Source";

export interface ResourceSnapshot<R extends SnapshotResource> {
  /** Guarda el último valor bueno (vacío autoritativo incluido). Nunca lanza. */
  save(value: SnapshotValue<R>): Promise<SnapshotWriteOutcome>;
  /** El snapshot válido si `err` es un fallo transitorio del proveedor; si no, `undefined`. */
  fallback(err: unknown): Promise<Snapshot<R> | undefined>;
}

const INERT: ResourceSnapshot<SnapshotResource> = {
  save: async () => "skipped",
  fallback: async () => undefined,
};

export interface OpenSnapshotOptions {
  /**
   * ¿Este fallo permite servir el snapshot? Por defecto la regla de Twitch y YouTube
   * (isSnapshotFallbackEligible). Instagram y TikTok pasan la suya: lista blanca cerrada.
   */
  eligible?: (err: unknown) => boolean;
  /**
   * Comprobación FINAL, solo cuando ya hay un snapshot que servir: ¿sigue vigente la fuente? Las
   * redes sociales vuelven a leer la conexión para no servir contenido de una cuenta desconectada
   * o cambiada mientras esta petición esperaba al proveedor. Si devuelve false o lanza, no se sirve.
   */
  confirm?: () => Promise<boolean>;
}

/**
 * Sesión de snapshot de UN recurso para UNA petición. Sin recurso o sin fuente (petición no
 * canónica, canal sin configurar o con forma inválida) es inerte: no toca la base de datos.
 */
export function openSnapshot<R extends SnapshotResource>(
  resource: R | undefined,
  sourceId: SnapshotSourceId<ProviderOf<R>> | undefined,
  options: OpenSnapshotOptions = {},
): ResourceSnapshot<R> {
  if (resource === undefined || sourceId === undefined) {
    return INERT as unknown as ResourceSnapshot<R>;
  }
  const eligible = options.eligible ?? isSnapshotFallbackEligible;

  // readSnapshot no lanza; el catch es solo defensa: esta promesa nunca queda sin manejar.
  const read: Promise<Snapshot<R> | undefined> = readSnapshot(resource, sourceId).catch(
    () => undefined,
  );

  return {
    async save(value) {
      try {
        return await writeSnapshot(resource, sourceId, value);
      } catch {
        return "failed";
      }
    },
    async fallback(err) {
      if (!eligible(err)) return undefined;
      const snapshot = await read;
      if (!snapshot) return undefined;
      if (options.confirm) {
        try {
          if (!(await options.confirm())) return undefined;
        } catch {
          // No se puede confirmar la fuente: fail-closed, no se sirve.
          return undefined;
        }
      }
      return snapshot;
    },
  };
}

/** Cabeceras de una respuesta servida desde un snapshot. */
export function sendSnapshotHeaders(res: VercelResponse): void {
  res.setHeader("Cache-Control", SNAPSHOT_FALLBACK_CACHE_CONTROL);
  res.setHeader(CONTENT_SOURCE_HEADER, "snapshot");
}
