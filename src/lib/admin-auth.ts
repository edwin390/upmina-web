import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest } from "@vercel/node";
import { getLatestTotpTimestamp, isMfaRecent } from "./privileged-mfa.js";

// Base de Auth/AuthZ server-side reutilizable para operaciones privilegiadas de Upmina
// Web (Instagram/TikTok admin, futuros Cosplays/moderación). SOLO servidor: nunca se
// importa desde React/el navegador. Independiente de instagram-connection.ts y
// tiktok-connection.ts (no comparte código con ellos), aunque sigue el mismo patrón de
// seguridad ya probado en social_connections: RLS forzado sin policies sobre
// admin_roles (ver supabase/migrations/20260922120000_admin_roles.sql), cliente
// service_role creado sin persistir sesión, y ningún dato sensible en errores/logs.
//
// Separación explícita:
//   - AUTENTICACIÓN (requireAuthenticated): "¿quién eres?" — se resuelve VERIFICANDO
//     criptográficamente el JWT de Supabase Auth con supabase.auth.getClaims(). Nunca
//     se confía en un user_id/aal que el request afirme por su cuenta (header, query,
//     body): solo cuentan las claims ya verificadas por el SDK.
//   - AUTORIZACIÓN (requirePrivileged/requireCapability): "¿qué puedes
//     hacer?" — se resuelve consultando admin_roles con el user_id YA verificado, usando
//     el cliente service_role. Una sesión de Supabase Auth válida (incluso con MFA) NO
//     concede privilegios por sí sola: hace falta una fila en admin_roles.
//   - STEP-UP MFA (Fase 9G-1): además del rol/capacidad, las operaciones privilegiadas exigen
//     MFA RECIENTE (ver privileged-mfa.ts: aal2 + timestamp TOTP del claim `amr` dentro de la
//     ventana). Orden fijo: autenticación → rol ACTUAL → capacidad → MFA reciente → operación.
//     El MFA nunca concede permisos: un fallo de rol/capacidad es un 403 genérico y NUNCA lleva
//     `code: "step_up_required"`; ese código solo lo recibe quien YA está autorizado.
//
// Fail-closed: cualquier fallo de infraestructura (Supabase no configurado, error de
// red/consulta al comprobar admin_roles) se propaga como AdminAuthInfrastructureError,
// NUNCA se interpreta como "sin rol" (eso sería un 403 silencioso ante una caída real).
// Quien llame a estos helpers debe distinguir ese caso de un AdminAuthError (401/403)
// legítimo si quiere responder 500/503 en vez de 401/403.

export type PrivilegedRole = "admin" | "moderator" | "developer";

/** Capacidades explícitas. Ninguna jerarquía implícita ADMIN > DEVELOPER > MODERATOR: cada
 *  operación privilegiada declara la capacidad que necesita y solo esta matriz decide. */
export type Capability = "moderation" | "technical" | "social_admin" | "team_admin";

/** ÚNICA fuente de verdad rol → capacidades (server-side). Añadir un rol o una capacidad
 *  exige tocar solo esta tabla; el Record fuerza que ningún rol quede sin definir. */
const ROLE_CAPABILITIES: Readonly<Record<PrivilegedRole, readonly Capability[]>> = {
  moderator: ["moderation"],
  developer: ["moderation", "technical"],
  admin: ["moderation", "technical", "social_admin", "team_admin"],
};

export function capabilitiesForRole(role: PrivilegedRole): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function roleHasCapability(role: PrivilegedRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

function isPrivilegedRole(value: unknown): value is PrivilegedRole {
  return value === "admin" || value === "moderator" || value === "developer";
}

/** Identidad autenticada: solo lo que devuelven las claims YA verificadas del JWT. */
export interface AuthenticatedIdentity {
  userId: string;
  /** Authenticator Assurance Level tal como lo emitió Supabase Auth ("aal1"/"aal2"). */
  aal: string;
  /** Segundos UNIX del último TOTP verificado según el claim `amr` del JWT verificado, o null si
   *  no hay ninguno con forma válida. Nunca proviene del cliente. Se combina con `aal` en
   *  identityHasRecentMfa: por sí solo no autoriza nada. */
  mfaVerifiedAt: number | null;
}

/** Identidad autenticada + rol privilegiado confirmado en admin_roles. */
export interface PrivilegedIdentity {
  userId: string;
  role: PrivilegedRole;
}

/** Identidad privilegiada que además superó una comprobación de capacidad concreta. */
export interface CapabilityIdentity extends PrivilegedIdentity {
  capabilities: Capability[];
}

/** No hay identidad válida (401) o hay identidad pero sin autorización suficiente (403).
 *  El mensaje es siempre genérico: nunca lleva claims, roles ajenos ni detalles internos. */
export class AdminAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
    /** Solo "step_up_required": el usuario ESTÁ autorizado (rol y capacidad) pero le falta MFA
     *  reciente. Ausente en todo rechazo por identidad, rol o capacidad. */
    readonly code?: StepUpCode,
  ) {
    super(message);
    this.name = "AdminAuthError";
  }
}

/** Código distinguible de "autorizado, pero hace falta MFA reciente". */
export const STEP_UP_REQUIRED_CODE = "step_up_required";
export type StepUpCode = typeof STEP_UP_REQUIRED_CODE;

/** Cuerpo JSON de una respuesta de error de autenticación/autorización. Único punto donde se
 *  decide si viaja `code`: solo para step_up_required, nunca para 401 ni para un 403 de rol o
 *  capacidad. */
export function authErrorBody(err: AdminAuthError): { error: string; code?: StepUpCode } {
  return err.code ? { error: err.message, code: err.code } : { error: err.message };
}

function stepUpRequiredError(): AdminAuthError {
  return new AdminAuthError("No autorizado", 403, STEP_UP_REQUIRED_CODE);
}

/** ¿La identidad ya autenticada tiene MFA reciente (aal2 + TOTP dentro de la ventana)? */
export function identityHasRecentMfa(
  identity: Pick<AuthenticatedIdentity, "aal" | "mfaVerifiedAt">,
  nowSeconds?: number,
): boolean {
  return isMfaRecent(identity.aal, identity.mfaVerifiedAt, nowSeconds);
}

/** Fallo de infraestructura (Supabase mal configurado, error de red/consulta) durante la
 *  verificación de identidad o la comprobación de autorización. Deliberadamente
 *  DISTINTO de AdminAuthError: nunca debe traducirse a "sin rol"/403 silencioso — quien
 *  llame decide si responde 500/503. */
export class AdminAuthInfrastructureError extends Error {
  constructor(
    message: string,
    /** Código de Postgres/PostgREST saneado, si lo hubo (ver safeCode). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "AdminAuthInfrastructureError";
  }
}

const TABLE = "admin_roles";

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value)
    ? value
    : undefined;
}

/**
 * Cliente SOLO para verificar JWT (supabase.auth.getClaims). Usa la anon key —igual
 * privilegio que el cliente del navegador—, nunca la service_role: verificar una firma
 * no requiere ningún privilegio elevado, y mezclar ambos usos en un mismo cliente
 * confundiría autenticación con autorización. Sin persistir sesión ni auto-refresh:
 * server-side, sin estado entre invocaciones.
 */
function getAuthVerificationClient(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    throw new AdminAuthInfrastructureError(
      "Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY",
    );
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Cliente SOLO para consultar admin_roles (service_role, omite RLS). Nunca se usa para
 * verificar identidad: la identidad ya llegó verificada por getClaims() antes de tocar
 * este cliente.
 */
function getRolesLookupClient(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new AdminAuthInfrastructureError(
      "Faltan VITE_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Extrae el token de `Authorization: Bearer <token>`. Cualquier otra forma (esquema
 * distinto, header ausente, valor vacío) devuelve null — nunca se acepta el token por
 * query param, body, cookie, localStorage ni un header propio.
 */
function extractBearerToken(req: VercelRequest): string | null {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/.exec(value);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Autenticación: identidad VERIFICADA a partir del Bearer token, sin consultar
 * admin_roles. Verifica la firma/expiración del JWT con supabase.auth.getClaims() (API
 * oficial del SDK) — nunca decodifica el payload sin verificar, nunca confía en
 * user_id/aal enviados por el cliente de ninguna otra forma.
 *
 * 401 si: no hay header, el esquema no es Bearer, el token está vacío, getClaims()
 * rechaza el JWT (inválido/expirado/firma incorrecta) o devuelve claims sin `sub`/`aal`
 * con la forma esperada (string no vacío). Nunca lanza AdminAuthInfrastructureError: un
 * fallo de red al resolver JWKS es, para quien llama, exactamente "no hay identidad
 * verificable" — no hace falta distinguirlo de un JWT inválido.
 */
export async function requireAuthenticated(
  req: VercelRequest,
): Promise<AuthenticatedIdentity> {
  const token = extractBearerToken(req);
  if (!token) throw new AdminAuthError("No autenticado", 401);

  let claims: Record<string, unknown> | null = null;
  try {
    const client = getAuthVerificationClient();
    const { data, error } = await client.auth.getClaims(token);
    if (error || !data) throw new AdminAuthError("No autenticado", 401);
    claims = data.claims as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AdminAuthError) throw err;
    if (err instanceof AdminAuthInfrastructureError) throw err;
    // JWT malformado, firma inválida, expirado, o fallo de red al resolver JWKS: en
    // todos los casos no hay identidad verificable. No se distingue el motivo hacia
    // quien llama (todos son 401), y el error original nunca se propaga (podría citar
    // el token).
    throw new AdminAuthError("No autenticado", 401);
  }

  const sub = claims?.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new AdminAuthError("No autenticado", 401);
  }
  const aal = claims?.aal;
  if (typeof aal !== "string" || aal.length === 0) {
    throw new AdminAuthError("No autenticado", 401);
  }

  return { userId: sub, aal, mfaVerifiedAt: getLatestTotpTimestamp(claims?.amr) };
}

/** Lee el rol privilegiado de `userId` (ya verificado). `null` = sin fila, o fila con un
 *  valor de `role` que no es exactamente "admin"/"moderator"/"developer" (defensivo: nunca debería
 *  ocurrir por el CHECK de la migración, pero si ocurriera se trata como "sin rol", no
 *  como error). Un fallo real de Supabase se propaga como AdminAuthInfrastructureError:
 *  nunca se interpreta un fallo de lectura como "sin rol". */
export async function getPrivilegedRoleForUser(
  userId: string,
): Promise<PrivilegedRole | null> {
  const client = getRolesLookupClient();

  let data: { role?: unknown } | null;
  let error: unknown;
  try {
    ({ data, error } = await client
      .from(TABLE)
      .select("role")
      .eq("user_id", userId)
      .maybeSingle());
  } catch (err) {
    const code = safeCode((err as { code?: unknown } | null)?.code);
    throw new AdminAuthInfrastructureError(
      "Error de infraestructura al leer admin_roles",
      code,
    );
  }
  if (error) {
    const code = safeCode((error as { code?: unknown }).code);
    throw new AdminAuthInfrastructureError(
      "Error de infraestructura al leer admin_roles",
      code,
    );
  }
  if (!data) return null;

  return isPrivilegedRole(data.role) ? data.role : null;
}

/**
 * Autorización: identidad autenticada + rol privilegiado confirmado en admin_roles + MFA
 * reciente. Orden exacto: (1) autentica, (2) consulta admin_roles por el user_id verificado,
 * (3) exige un rol reconocido, (4) exige MFA reciente (aal2 + TOTP dentro de la ventana).
 *
 * 403 genérico si no hay fila en admin_roles o la fila tiene un rol no reconocido: sin MFA
 * involucrado, aunque la sesión sea aal2 y el MFA sea reciente. 403 con `code:
 * "step_up_required"` SOLO si el rol es válido pero falta MFA reciente. Un fallo de Supabase al
 * leer admin_roles NUNCA se convierte en 403: se propaga como AdminAuthInfrastructureError
 * (fail closed, distinguible de un 403 legítimo).
 */
export async function requirePrivileged(req: VercelRequest): Promise<PrivilegedIdentity> {
  const identity = await requireAuthenticated(req);

  const role = await getPrivilegedRoleForUser(identity.userId);
  if (role === null) {
    throw new AdminAuthError("No autorizado", 403);
  }

  if (!identityHasRecentMfa(identity)) {
    throw stepUpRequiredError();
  }

  return { userId: identity.userId, role };
}

/**
 * Autorización por capacidad. Orden exacto: (1) autentica, (2) lee el rol autoritativo en
 * admin_roles, (3) exige que el rol tenga `capability` según ROLE_CAPABILITIES, (4) exige MFA
 * reciente. La capacidad se comprueba ANTES que el MFA: quien no tiene la capacidad recibe un 403
 * genérico y nunca es enviado a un step-up que no le serviría (MFA no añade capacidades). Fallos
 * de infraestructura se propagan como AdminAuthInfrastructureError, nunca como 403.
 */
export async function requireCapability(
  req: VercelRequest,
  capability: Capability,
): Promise<CapabilityIdentity> {
  const identity = await requireAuthenticated(req);

  const role = await getPrivilegedRoleForUser(identity.userId);
  if (role === null || !roleHasCapability(role, capability)) {
    throw new AdminAuthError("No autorizado", 403);
  }

  if (!identityHasRecentMfa(identity)) {
    throw stepUpRequiredError();
  }

  return { userId: identity.userId, role, capabilities: capabilitiesForRole(role) };
}

/** Resumen de acceso de una identidad ya autenticada, SOLO para presentación (UX). */
export interface AccessSummary {
  role: PrivilegedRole | null;
  capabilities: Capability[];
  mfaRecent: boolean;
}

/**
 * Acceso actual de quien hace el request: identidad verificada + rol ACTUAL de admin_roles +
 * estado de MFA reciente. NO autoriza nada y NO exige MFA (por eso no lanza step_up_required):
 * sirve para que el frontend decida qué presentar y a dónde enrutar. Cada endpoint privilegiado
 * vuelve a exigir su propio guard. Un usuario sin rol recibe `role: null` y capacidades vacías.
 * Un fallo de Supabase al leer admin_roles se propaga como AdminAuthInfrastructureError.
 */
export async function getAccessSummary(req: VercelRequest): Promise<AccessSummary> {
  const identity = await requireAuthenticated(req);
  const role = await getPrivilegedRoleForUser(identity.userId);
  return {
    role,
    capabilities: role === null ? [] : capabilitiesForRole(role),
    mfaRecent: identityHasRecentMfa(identity),
  };
}

/**
 * ¿Sigue `userId` teniendo la capacidad `capability`? Para flujos que llegan SIN sesión del
 * navegador (p. ej. el callback de un OAuth iniciado antes por un ADMIN+AAL2): no hay Bearer,
 * ni claims ni AAL que comprobar —eso ya se exigió al iniciar—; solo se reconsulta admin_roles
 * con el user_id ya conocido por el servidor. Sin fila o sin la capacidad → AdminAuthError 403.
 * Un fallo de Supabase se propaga como AdminAuthInfrastructureError (fail closed).
 */
export async function requireCapabilityForUser(
  userId: string,
  capability: Capability,
): Promise<void> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new AdminAuthError("No autorizado", 403);
  }
  const role = await getPrivilegedRoleForUser(userId);
  if (role === null || !roleHasCapability(role, capability)) {
    throw new AdminAuthError("No autorizado", 403);
  }
}

/** Moderación: MODERATOR, DEVELOPER y ADMIN, únicamente mediante la capacidad `moderation`. */
export async function requireModerator(req: VercelRequest): Promise<CapabilityIdentity> {
  return requireCapability(req, "moderation");
}
