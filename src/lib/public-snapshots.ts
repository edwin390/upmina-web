import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isProductionEnvironment } from "./instagram-oauth-shared.js";
import {
  MAX_SOURCE_ID_LENGTH,
  decodeSnapshotPayload,
  encodeSnapshotPayload,
  isSnapshotResource,
  isSourceIdOf,
  snapshotMaxAgeMs,
  snapshotProvider,
  socialSnapshotResources,
  type ProviderOf,
  type SnapshotResource,
  type SnapshotSourceId,
  type SnapshotValue,
  type SocialSnapshotProvider,
} from "./public-snapshot-resources.js";

// Persistencia de los snapshots públicos "last-known-good" (Fase 9H-4, checkpoint 2). SOLO
// servidor: usa service_role y no se importa desde el navegador. Todavía no lo usa ningún
// endpoint (la integración es de los siguientes checkpoints).
//
// Tabla: public.public_content_snapshots (ver supabase/migrations/20260929120000_*.sql). Una fila
// por recurso canónico (máximo 8), PK = resource; escribir es un upsert (la última escritura
// válida gana). RLS forzado y sin policies: solo service_role.
//
// FALLA ABIERTO. Esto es infraestructura de resiliencia, no de correctitud: NINGUNA función de
// este módulo lanza. Si Supabase no está configurado, no responde, tarda más de
// SNAPSHOT_OPERATION_TIMEOUT_MS, devuelve un error o la fila está corrupta, el resultado es "no
// hay snapshot" / "no se escribió" y el llamador sigue con el comportamiento de siempre. Un
// éxito del proveedor nunca puede convertirse en un fallo público por culpa de un snapshot.
//
// ESCRITURAS: el llamador debe hacer `await writeSnapshot(...)`. Una Serverless Function se
// congela al responder, así que una escritura sin esperar puede perderse; por eso la API es
// una promesa que el llamador espera, y su resultado (`SnapshotWriteOutcome`) nunca es una
// excepción.
//
// LECTURAS (`readSnapshot`): devuelven un snapshot solo si la fila existe, su source_id coincide
// EXACTAMENTE, captured_at es legible, la edad no supera la del recurso y el payload PASA de nuevo
// el validador (una fila de la base de datos no se da por buena).
//
// SEGURIDAD: solo acepta valores normalizados y públicos, reconstruidos por el validador con
// campos conocidos (una clave desconocida se rechaza). Los errores se reducen a un código
// saneado: nunca se registran payloads, source_id ni claves.

const TABLE = "public_content_snapshots";

/**
 * Tiempo máximo de cada operación con Supabase. Una consulta puntual por PK tarda decenas de ms;
 * 2 s deja margen para un pico y acota lo que un snapshot puede añadir a una petición (los
 * proveedores ya llegan a 8–10 s). Sin reintentos: un solo intento por operación.
 */
export const SNAPSHOT_OPERATION_TIMEOUT_MS = 2_000;

/**
 * Tamaño máximo (bytes de JSON compacto) que acepta el código antes de escribir. La base de datos
 * limita el TEXTO de jsonb a 262 144 bytes (que es algo mayor que el JSON compacto: jsonb añade
 * espacios); este tope, más bajo, garantiza que el CHECK nunca sea el que rechace.
 */
export const MAX_SNAPSHOT_PAYLOAD_BYTES = 200_000;

/** Tolerancia a que el reloj de una función vaya algo por detrás del de quien escribió. */
const MAX_FUTURE_SKEW_MS = 60_000;

export interface Snapshot<R extends SnapshotResource> {
  value: SnapshotValue<R>;
  /** ISO 8601. */
  capturedAt: string;
}

/** Resultado de una escritura. Ninguna variante es una excepción. */
export type SnapshotWriteOutcome =
  /** Guardado. */
  | "written"
  /** No es Production: no se escribe (Preview comparte la base de datos con Production). */
  | "skipped"
  /** Valor, recurso o source_id inválidos (o demasiado grande): no se llegó a escribir. */
  | "invalid"
  /** Supabase no está configurado, falló o tardó demasiado. */
  | "failed";

type SourceIdFor<R extends SnapshotResource> = SnapshotSourceId<ProviderOf<R>>;

class SnapshotTimeout extends Error {}

function getClient(): SupabaseClient | undefined {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return undefined;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Ejecuta una operación con plazo. Aborta la petición y rechaza al vencer. */
async function withTimeout<T>(run: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SnapshotTimeout());
    }, SNAPSHOT_OPERATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve(run(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Código de error acotado y sin datos (SQLSTATE/PostgREST), o una etiqueta fija. */
function reasonOf(err: unknown): string {
  if (err instanceof SnapshotTimeout) return "timeout";
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(code) ? code : "error";
}

function logFailure(operation: string, target: string, err: unknown): void {
  console.error(`[public-snapshots] ${operation} ${target}: ${reasonOf(err)}`);
}

/** El source_id encaja con el proveedor del recurso (defensa ante un cast). */
function sourceMatchesResource(resource: SnapshotResource, sourceId: unknown): boolean {
  return isSourceIdOf(snapshotProvider(resource), sourceId);
}

interface StoredRow {
  source_id?: unknown;
  payload?: unknown;
  captured_at?: unknown;
}

/**
 * Lee el snapshot VÁLIDO de `resource` para `sourceId`, o `undefined` ("no hay snapshot") si la
 * fila no existe, es de otra fuente, está caducada, tiene un captured_at ilegible o futuro, su
 * payload ya no valida, o Supabase falla. Nunca lanza.
 */
export async function readSnapshot<R extends SnapshotResource>(
  resource: R,
  sourceId: SourceIdFor<R>,
  now: number = Date.now(),
): Promise<Snapshot<R> | undefined> {
  // Un recurso fuera de la lista (p. ej. un cast de "twitch-status") no existe.
  if (!isSnapshotResource(resource) || !sourceMatchesResource(resource, sourceId)) {
    return undefined;
  }
  const client = getClient();
  if (!client) return undefined;

  let row: StoredRow | null;
  try {
    const { data, error } = await withTimeout((signal) =>
      client
        .from(TABLE)
        .select("source_id,payload,captured_at")
        .eq("resource", resource)
        .abortSignal(signal)
        .maybeSingle(),
    );
    if (error) throw error;
    row = (data as StoredRow | null) ?? null;
  } catch (err) {
    logFailure("lectura", resource, err);
    return undefined;
  }
  if (!row) return undefined;

  if (row.source_id !== sourceId) return undefined;

  if (typeof row.captured_at !== "string") return undefined;
  const capturedMs = Date.parse(row.captured_at);
  if (!Number.isFinite(capturedMs)) return undefined;
  const age = now - capturedMs;
  if (age < -MAX_FUTURE_SKEW_MS || age > snapshotMaxAgeMs(resource)) return undefined;

  const decoded = decodeSnapshotPayload(resource, row.payload);
  if (!decoded) return undefined;
  return { value: decoded.value, capturedAt: new Date(capturedMs).toISOString() };
}

/**
 * Guarda `value` como último snapshot bueno de `resource`. Solo en Production y solo si el valor
 * valida (se reconstruye con campos conocidos) y cabe. Un fallo NUNCA debe llamar a esta función
 * (el llamador solo escribe tras un éxito validado del proveedor); si falla la base de datos,
 * devuelve "failed" en vez de lanzar. Hay que esperar el resultado (`await`).
 */
export async function writeSnapshot<R extends SnapshotResource>(
  resource: R,
  sourceId: SourceIdFor<R>,
  value: SnapshotValue<R>,
  now: number = Date.now(),
): Promise<SnapshotWriteOutcome> {
  // Preview y Development NO escriben: Preview comparte Supabase con Production.
  if (!isProductionEnvironment()) return "skipped";
  if (!isSnapshotResource(resource) || !sourceMatchesResource(resource, sourceId)) {
    return "invalid";
  }
  const payload = encodeSnapshotPayload(resource, value);
  if (payload === undefined) return "invalid";
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_SNAPSHOT_PAYLOAD_BYTES) {
    return "invalid";
  }
  if (sourceId.length < 1 || sourceId.length > MAX_SOURCE_ID_LENGTH) return "invalid";

  const client = getClient();
  if (!client) return "failed";
  try {
    const { error } = await withTimeout((signal) =>
      client
        .from(TABLE)
        .upsert(
          {
            resource,
            source_id: sourceId,
            payload,
            captured_at: new Date(now).toISOString(),
          },
          { onConflict: "resource" },
        )
        .abortSignal(signal),
    );
    if (error) throw error;
    return "written";
  } catch (err) {
    logFailure("escritura", resource, err);
    return "failed";
  }
}

/**
 * Borra los snapshots de UNA red social (Instagram: feed y perfil; TikTok: videos). Es la única
 * operación de borrado y su alcance es fijo: la lista de recursos sale de las definiciones, nunca
 * de un valor del llamador. Pensada para la desconexión explícita (checkpoint posterior). Devuelve
 * `false` si no se pudo confirmar el borrado. Nunca lanza.
 */
export async function deleteSocialSnapshots(
  provider: SocialSnapshotProvider,
): Promise<boolean> {
  if (provider !== "instagram" && provider !== "tiktok") return false;
  const resources = socialSnapshotResources(provider);
  const client = getClient();
  if (!client) return false;
  try {
    const { error } = await withTimeout((signal) =>
      client.from(TABLE).delete().in("resource", resources).abortSignal(signal),
    );
    if (error) throw error;
    return true;
  } catch (err) {
    logFailure("borrado", provider, err);
    return false;
  }
}
