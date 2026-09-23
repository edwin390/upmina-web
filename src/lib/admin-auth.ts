import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest } from "@vercel/node";

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
//   - AUTORIZACIÓN (requirePrivileged/requireAdmin/requireModerator): "¿qué puedes
//     hacer?" — se resuelve consultando admin_roles con el user_id YA verificado, usando
//     el cliente service_role. Una sesión de Supabase Auth válida (incluso con MFA) NO
//     concede privilegios por sí sola: hace falta una fila en admin_roles.
//
// Fail-closed: cualquier fallo de infraestructura (Supabase no configurado, error de
// red/consulta al comprobar admin_roles) se propaga como AdminAuthInfrastructureError,
// NUNCA se interpreta como "sin rol" (eso sería un 403 silencioso ante una caída real).
// Quien llame a estos helpers debe distinguir ese caso de un AdminAuthError (401/403)
// legítimo si quiere responder 500/503 en vez de 401/403.

export type PrivilegedRole = "admin" | "moderator";

/** Identidad autenticada: solo lo que devuelven las claims YA verificadas del JWT. */
export interface AuthenticatedIdentity {
  userId: string;
  /** Authenticator Assurance Level tal como lo emitió Supabase Auth ("aal1"/"aal2"). */
  aal: string;
}

/** Identidad autenticada + rol privilegiado confirmado en admin_roles. */
export interface PrivilegedIdentity {
  userId: string;
  role: PrivilegedRole;
}

/** No hay identidad válida (401) o hay identidad pero sin autorización suficiente (403).
 *  El mensaje es siempre genérico: nunca lleva claims, roles ajenos ni detalles internos. */
export class AdminAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = "AdminAuthError";
  }
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

  return { userId: sub, aal };
}

/** Lee el rol privilegiado de `userId` (ya verificado). `null` = sin fila, o fila con un
 *  valor de `role` que no es exactamente "admin"/"moderator" (defensivo: nunca debería
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

  return data.role === "admin" || data.role === "moderator" ? data.role : null;
}

/**
 * Autorización: identidad autenticada + rol privilegiado confirmado en admin_roles, con
 * assurance suficiente. Orden exacto: (1) autentica, (2) consulta admin_roles por el
 * user_id verificado, (3) exige un rol reconocido, (4) exige aal === "aal2".
 *
 * 403 si: no hay fila en admin_roles, la fila tiene un rol no reconocido, o el rol es
 * válido pero `aal !== "aal2"` (incluye admin/moderator con aal1: MFA no verificado en
 * esta sesión no es suficiente assurance). Un fallo de Supabase al leer admin_roles
 * NUNCA se convierte en 403: se propaga como AdminAuthInfrastructureError (fail closed,
 * distinguible de un 403 legítimo).
 */
export async function requirePrivileged(req: VercelRequest): Promise<PrivilegedIdentity> {
  const { userId, aal } = await requireAuthenticated(req);

  const role = await getPrivilegedRoleForUser(userId);
  if (role === null) {
    throw new AdminAuthError("No autorizado", 403);
  }

  if (aal !== "aal2") {
    throw new AdminAuthError("No autorizado", 403);
  }

  return { userId, role };
}

/**
 * Solo ADMIN. MODERATOR con aal2 válido sigue recibiendo 403: MFA no convierte un
 * MODERATOR en ADMIN.
 */
export async function requireAdmin(req: VercelRequest): Promise<{ userId: string }> {
  const { userId, role } = await requirePrivileged(req);
  if (role !== "admin") {
    throw new AdminAuthError("No autorizado", 403);
  }
  return { userId };
}

/**
 * ¿Sigue `userId` teniendo el rol ADMIN? Para flujos que llegan SIN sesión del navegador
 * (p. ej. el callback de un OAuth iniciado antes por un ADMIN+AAL2): no hay Bearer, ni
 * claims ni AAL que comprobar —eso ya se exigió al iniciar—; solo se reconsulta admin_roles
 * con el user_id ya conocido por el servidor. Resuelve a `void` si es admin; MODERATOR o sin
 * fila → AdminAuthError 403. Un fallo de Supabase se propaga como
 * AdminAuthInfrastructureError (fail closed, nunca "sin rol").
 */
export async function requireAdminRoleForUser(userId: string): Promise<void> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new AdminAuthError("No autorizado", 403);
  }
  const role = await getPrivilegedRoleForUser(userId);
  if (role !== "admin") {
    throw new AdminAuthError("No autorizado", 403);
  }
}

/**
 * ADMIN o MODERATOR: "puede realizar operaciones de moderación". Un ADMIN hereda la
 * capacidad de moderar; requirePrivileged ya solo devuelve exactamente estos dos roles,
 * así que no hace falta ninguna comprobación adicional aquí.
 */
export async function requireModerator(req: VercelRequest): Promise<PrivilegedIdentity> {
  return requirePrivileged(req);
}
