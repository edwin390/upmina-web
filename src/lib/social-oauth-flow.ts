import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Fundación (Bloque 8B) de la autorización OAuth vigente por proveedor social: el estado
// que ata un callback a un INICIO autorizado por un ADMIN (AAL2). SOLO servidor: usa
// service_role y no se importa desde el navegador. Todavía no lo usa ningún handler.
//
// Modelo (ver supabase/migrations/20260925120000_social_oauth_flows.sql): una fila por
// proveedor. Crear un flujo sobrescribe la fila (el flujo anterior queda invalidado: la
// autorización más reciente gana); reclamar es un único UPDATE condicional atómico.
//
// Tiempo: una única fuente por operación, `now` (ms epoch, por defecto Date.now() del
// servidor, igual que el resto de módulos de persistencia). created_at, expires_at y
// consumed_at salen de ese mismo instante, y las comparaciones de expiración se hacen contra
// él; los tests inyectan `now` sin esperas reales.
//
// Seguridad: el nonce en claro NO sale de este módulo hacia la base de datos (se guarda su
// SHA-256) ni hacia logs o errores. Los errores de Supabase se reducen a un código saneado.

export type SocialOAuthProvider = "instagram" | "tiktok";

export const SOCIAL_OAUTH_PROVIDERS: readonly SocialOAuthProvider[] = [
  "instagram",
  "tiktok",
];

/** Vigencia del flujo desde su creación. */
export const SOCIAL_OAUTH_FLOW_TTL_MS = 10 * 60_000;

const TABLE = "social_oauth_flows";
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SocialOAuthFlowErrorKind =
  "invalid_provider" | "invalid_input" | "infrastructure";

/** Error interno de la fundación. El mensaje es fijo por `kind`: nunca lleva nonce, state,
 *  code, tokens ni texto de Postgres. `code` es un SQLSTATE/PostgREST saneado, si lo hubo. */
export class SocialOAuthFlowError extends Error {
  constructor(
    readonly kind: SocialOAuthFlowErrorKind,
    readonly code?: string,
  ) {
    super(
      kind === "invalid_provider"
        ? "Proveedor social no soportado"
        : kind === "invalid_input"
          ? "Entrada inválida para el flujo OAuth"
          : "Error de infraestructura en el flujo OAuth",
    );
    this.name = "SocialOAuthFlowError";
  }
}

export function isSocialOAuthProvider(value: unknown): value is SocialOAuthProvider {
  return value === "instagram" || value === "tiktok";
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value)
    ? value
    : undefined;
}

function infrastructureError(err: unknown): SocialOAuthFlowError {
  return new SocialOAuthFlowError(
    "infrastructure",
    safeCode((err as { code?: unknown } | null)?.code),
  );
}

/** Cliente admin (service_role); un fallo de configuración es un fallo de infraestructura. */
function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) throw new SocialOAuthFlowError("infrastructure");
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function assertProvider(provider: unknown): asserts provider is SocialOAuthProvider {
  if (!isSocialOAuthProvider(provider))
    throw new SocialOAuthFlowError("invalid_provider");
}

/** SHA-256 hex en minúsculas. El módulo recibe el nonce en claro y lo hashea aquí, para que
 *  ningún llamador pueda olvidarse de hacerlo. */
function hashNonce(rawNonce: unknown): string {
  if (typeof rawNonce !== "string" || rawNonce.length === 0) {
    throw new SocialOAuthFlowError("invalid_input");
  }
  return createHash("sha256").update(rawNonce).digest("hex");
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface CreatedSocialOAuthFlow {
  /** Momento (ms epoch) en el que expira el flujo. */
  expiresAt: number;
}

/**
 * Crea el flujo vigente de `provider` reemplazando el anterior, si lo había. Un único
 * upsert por provider (sin SELECT previo): sobrescribe nonce_hash, admin_user_id,
 * created_at y expires_at, y pone consumed_at = NULL de forma explícita (un upsert solo
 * actualiza las columnas que se envían; sin esto, reiniciar tras consumir dejaría el flujo
 * nuevo ya consumido). Fail-closed: cualquier error de Supabase se propaga.
 */
export async function createSocialOAuthFlow(
  provider: SocialOAuthProvider,
  rawNonce: string,
  adminUserId: string,
  now: number = Date.now(),
): Promise<CreatedSocialOAuthFlow> {
  assertProvider(provider);
  const nonceHash = hashNonce(rawNonce);
  if (typeof adminUserId !== "string" || !UUID_FORMAT.test(adminUserId)) {
    throw new SocialOAuthFlowError("invalid_input");
  }

  const client = getSupabaseAdmin();
  const expiresAt = now + SOCIAL_OAUTH_FLOW_TTL_MS;

  let error: unknown;
  try {
    ({ error } = await client.from(TABLE).upsert(
      {
        provider,
        nonce_hash: nonceHash,
        admin_user_id: adminUserId,
        created_at: iso(now),
        expires_at: iso(expiresAt),
        consumed_at: null,
      },
      { onConflict: "provider" },
    ));
  } catch (err) {
    throw infrastructureError(err);
  }
  if (error) throw infrastructureError(error);

  return { expiresAt };
}

export type SocialOAuthFlowClaim =
  { status: "claimed"; adminUserId: string } | { status: "not_claimable" };

/**
 * Reclama el flujo con UN solo UPDATE condicional (sin SELECT previo):
 *   UPDATE social_oauth_flows SET consumed_at = <now>
 *   WHERE provider = :p AND nonce_hash = :h AND consumed_at IS NULL AND expires_at > <now>
 *   RETURNING admin_user_id
 * Una fila devuelta = reclamado; cero filas = "not_claimable" (nonce desconocido, de otro
 * proveedor, ya consumido, expirado o sustituido por un inicio más reciente; no se
 * distingue). Un error de Supabase se propaga como infraestructura: nunca se interpreta
 * como "reclamado" ni como "no reclamable".
 */
export async function claimSocialOAuthFlow(
  provider: SocialOAuthProvider,
  rawNonce: string,
  now: number = Date.now(),
): Promise<SocialOAuthFlowClaim> {
  assertProvider(provider);
  const nonceHash = hashNonce(rawNonce);
  const client = getSupabaseAdmin();

  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await client
      .from(TABLE)
      .update({ consumed_at: iso(now) })
      .eq("provider", provider)
      .eq("nonce_hash", nonceHash)
      .is("consumed_at", null)
      .gt("expires_at", iso(now))
      .select("admin_user_id"));
  } catch (err) {
    throw infrastructureError(err);
  }
  if (error) throw infrastructureError(error);

  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return { status: "not_claimable" };
  const adminUserId = (rows[0] as { admin_user_id?: unknown }).admin_user_id;
  // Forma inesperada tras un UPDATE que sí modificó una fila: no se puede continuar.
  if (rows.length !== 1 || typeof adminUserId !== "string" || adminUserId.length === 0) {
    throw new SocialOAuthFlowError("infrastructure");
  }
  return { status: "claimed", adminUserId };
}

/**
 * ¿Sigue siendo `rawNonce` el flujo vigente y ya reclamado de `provider`? Se usa DESPUÉS del
 * intercambio de tokens y ANTES de persistir: si un inicio más reciente sobrescribió la fila
 * mientras tanto, el nonce deja de coincidir y devuelve false. Solo lectura.
 *
 * NO exige expires_at > ahora, a propósito: la expiración ya se comprobó (de forma atómica)
 * al reclamar; una vez consumido, el flujo no puede reutilizarse, y volver a comprobarla
 * rechazaría un callback legítimo cuyo intercambio con el proveedor fue lento sin aportar
 * seguridad. Lo que esta comprobación detecta es únicamente la sustitución (un inicio
 * posterior). No es atómica con la escritura posterior: el residual R1 está aceptado.
 */
export async function isSocialOAuthFlowCurrent(
  provider: SocialOAuthProvider,
  rawNonce: string,
): Promise<boolean> {
  assertProvider(provider);
  const nonceHash = hashNonce(rawNonce);
  const client = getSupabaseAdmin();

  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await client
      .from(TABLE)
      .select("nonce_hash")
      .eq("provider", provider)
      .eq("nonce_hash", nonceHash)
      .not("consumed_at", "is", null)
      .maybeSingle());
  } catch (err) {
    throw infrastructureError(err);
  }
  if (error) throw infrastructureError(error);

  return data !== null && data !== undefined;
}
