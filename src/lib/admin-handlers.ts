import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  AdminAuthError,
  AdminAuthInfrastructureError,
  authErrorBody,
  capabilitiesForRole,
  getAccessSummary,
  identityHasRecentMfa,
  requireAuthenticated,
  requirePrivileged,
  STEP_UP_REQUIRED_CODE,
  type AccessSummary,
  type PrivilegedIdentity,
} from "./admin-auth.js";
import { hashInvitationToken } from "./admin-invitation-token.js";

// Handler HTTP de POST /api/admin/activate (Bloque 2C). Vive aquí (no en api/) por el
// mismo motivo que instagram-handlers.ts/tiktok-handlers.ts: api/admin/[action].ts es un
// despachador delgado por segmento dinámico `action`, y "activate" es hoy la única
// acción soportada.
//
// Contrato: consume una invitación admin_invitations (bootstrap_admin en este bloque;
// ver supabase/migrations/20260923120000_admin_invitations.sql) y concede el rol
// correspondiente en admin_roles vía la RPC atómica consume_admin_invitation. El
// user_id que se le pasa a esa RPC viene EXCLUSIVAMENTE del JWT ya verificado por
// requireAuthenticated — nunca del body del request, aunque el cliente lo envíe.
//
// Deliberadamente NO usa requireCapability/requirePrivileged: en el momento de activar la
// invitación el usuario todavía no tiene ninguna fila en admin_roles (esa fila es precisamente
// lo que esta operación va a crear). La condición de assurance exigida aquí es MFA RECIENTE
// (aal2 + TOTP dentro de la ventana, ver privileged-mfa.ts) sobre una identidad ya autenticada:
// el MFA ocurre ANTES de conceder el rol. Sin MFA reciente → 403 con code "step_up_required".

// Formato exacto producido por generateBootstrapToken() en
// scripts/lib/admin-bootstrap-invitation.mjs: randomBytes(32).toString("base64url").
// base64url sin padding de 32 bytes son siempre 43 caracteres del alfabeto
// [A-Za-z0-9_-]. No se acepta ningún otro formato (ni un token con padding, ni de otra
// longitud): un valor con forma distinta no puede ser un token bootstrap real y se
// rechaza antes de tocar la base de datos.
const BOOTSTRAP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isValidBootstrapToken(value: unknown): value is string {
  return typeof value === "string" && BOOTSTRAP_TOKEN_PATTERN.test(value);
}

/**
 * Cliente service_role SOLO para consumir la invitación. Se crea deliberadamente tarde
 * (después de autenticar, exigir aal2 y validar el token) para no instanciar
 * credenciales privilegiadas ante un request que de todos modos va a ser rechazado.
 */
function getInvitationServiceClient() {
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

/** Único cuerpo de error genérico para "la invitación no pudo consumirse": no
 *  distingue token inexistente, ya consumido, expirado o bootstrap ya usado (serían
 *  todas las razones por las que la RPC lanza excepción). Distinguirlas de cara al
 *  cliente no aporta nada legítimo y sí ayuda a enumerar el estado del sistema. */
const INVITATION_REJECTED_BODY = { error: "No se pudo activar la invitación" };

/**
 * Conjunto CERRADO de mensajes que consume_admin_invitation lanza como rechazo de
 * negocio esperado (ver los 4 `raise exception '<literal>'` en
 * supabase/migrations/20260923120000_admin_invitations.sql y su versión vigente en
 * 20260926120000_admin_team_roles_invariants.sql: invitation_not_found,
 * invitation_already_consumed, invitation_revoked, invitation_expired,
 * user_already_privileged, admin_already_exists, invitation_creator_not_admin). Ninguno usa
 * argumentos de formato ni un SQLSTATE explícito, así que PostgREST siempre los reporta
 * con code "P0001" (el código por defecto de PL/pgSQL para RAISE EXCEPTION sin código
 * propio) y `message` EXACTAMENTE igual al literal — nunca interpolado, nunca con
 * datos del request. Esa combinación (code + message exacto) es la única señal estable
 * disponible hoy para distinguir "la invitación fue rechazada por una razón de
 * negocio conocida" de "algo en la infraestructura/DB falló de forma inesperada".
 *
 * Deliberadamente una lista cerrada, no un prefijo/regex: un mensaje que no soporta
 * consultarse aquí (typo, mensaje nuevo de una migración futura, error real de
 * Postgres/PostgREST con otro code) NUNCA se trata como rechazo de negocio — cae al
 * 500 genérico por defecto (fail closed). Si una migración futura cambia estos
 * literales, esta lista debe actualizarse junto con ella.
 */
const KNOWN_INVITATION_RPC_ERRORS = new Set([
  "invitation_not_found",
  "invitation_already_consumed",
  "invitation_revoked",
  "invitation_expired",
  "user_already_privileged",
  "admin_already_exists",
  "invitation_creator_not_admin",
]);

/** SQLSTATE por defecto que Postgres asigna a `RAISE EXCEPTION` cuando la sentencia no
 *  especifica un código propio (que es el caso de las 4 excepciones de negocio de
 *  consume_admin_invitation). Verificar también el code (no solo el message) evita que
 *  un mensaje de error real de infraestructura que por coincidencia contuviera uno de
 *  esos literales (poco probable, pero no descartable) se clasifique como rechazo de
 *  negocio. */
const PLPGSQL_RAISE_EXCEPTION_CODE = "P0001";

/**
 * true solo si `error` es EXACTAMENTE uno de los 4 rechazos de negocio conocidos que
 * lanza consume_admin_invitation (mismo code Y mismo message, sin normalizar ni hacer
 * matching parcial). Cualquier otra cosa —error de red, timeout, RLS, columna
 * inexistente, o incluso un P0001 con un mensaje que no esté en la lista— devuelve
 * false y el llamador debe tratarlo como fallo de infraestructura (500 genérico).
 */
function isKnownInvitationRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === PLPGSQL_RAISE_EXCEPTION_CODE &&
    typeof message === "string" &&
    KNOWN_INVITATION_RPC_ERRORS.has(message)
  );
}

/** Único cuerpo de error genérico para fallos reales de infraestructura (Supabase no
 *  configurado, RPC inalcanzable, respuesta con forma inesperada): nunca el texto de
 *  un error de Postgres/PostgREST. */
const INFRASTRUCTURE_ERROR_BODY = { error: "Error interno" };

function parseJsonBody(req: VercelRequest): Record<string, unknown> | null {
  const raw = req.body;
  // @vercel/node parsea automáticamente un body con Content-Type: application/json en
  // un objeto. Si por lo que sea llega como string (p. ej. un Content-Type distinto),
  // se intenta parsear a mano; cualquier fallo se trata como body inválido, nunca como
  // infraestructura.
  const parsed = typeof raw === "string" ? tryParseJson(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function handleAdminActivate(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  let identity: Awaited<ReturnType<typeof requireAuthenticated>>;
  try {
    identity = await requireAuthenticated(req);
  } catch (err) {
    // AdminAuthError (401): identidad ausente/inválida, se propaga tal cual. Cualquier
    // otro caso (AdminAuthInfrastructureError u otra excepción inesperada) es un fallo
    // real de infraestructura: genérico 500, nunca su mensaje interno.
    if (err instanceof AdminAuthError) {
      return res.status(err.status).json(authErrorBody(err));
    }
    return res.status(500).json(INFRASTRUCTURE_ERROR_BODY);
  }

  // La activación ocurre ANTES de que exista cualquier fila en admin_roles para este usuario:
  // requireCapability/requirePrivileged no aplican (siempre darían 403). La assurance exigible
  // sobre la identidad ya verificada es MFA reciente. El role/userId/aal/mfa que envíe el
  // cliente nunca se lee: solo cuentan las claims del JWT.
  if (!identityHasRecentMfa(identity)) {
    return res.status(403).json({ error: "No autorizado", code: STEP_UP_REQUIRED_CODE });
  }

  const body = parseJsonBody(req);
  if (!body) {
    return res.status(400).json({ error: "Solicitud inválida" });
  }

  // Deliberadamente solo se lee `token`. Un `role`, `userId` o `invitation_type` que el
  // cliente envíe en el body se ignora por completo: nunca se leen esas propiedades.
  const { token } = body;
  if (!isValidBootstrapToken(token)) {
    return res.status(400).json({ error: "Solicitud inválida" });
  }

  const tokenHash = hashInvitationToken(token);

  let client: ReturnType<typeof getInvitationServiceClient>;
  try {
    client = getInvitationServiceClient();
  } catch {
    return res.status(500).json(INFRASTRUCTURE_ERROR_BODY);
  }

  try {
    const { data, error } = await client.rpc("consume_admin_invitation", {
      p_token_hash: tokenHash,
      p_user_id: identity.userId,
    });

    if (error) {
      if (isKnownInvitationRejection(error)) {
        // invitation_not_found / invitation_already_consumed / invitation_expired /
        // admin_already_exists: la RPC las distingue internamente, pero de cara al
        // cliente son la misma respuesta genérica. Nunca se propaga error.message.
        return res.status(400).json(INVITATION_REJECTED_BODY);
      }
      // Cualquier otro error de la RPC (fallo real de red/DB, RLS, un code distinto
      // de P0001, o un P0001 con un mensaje que no está en la lista cerrada) NO es un
      // rechazo de negocio reconocido: fail closed a 500 genérico. Nunca se propaga
      // error.message/details/hint/code al cliente.
      return res.status(500).json(INFRASTRUCTURE_ERROR_BODY);
    }

    const grantedRole = Array.isArray(data) ? data[0]?.granted_role : undefined;
    if (grantedRole !== "admin" && grantedRole !== "moderator") {
      // La RPC respondió sin error pero con una forma inesperada: no es un rechazo
      // legítimo de invitación, es infraestructura comportándose de forma anómala.
      return res.status(500).json(INFRASTRUCTURE_ERROR_BODY);
    }

    return res.status(200).json({ role: grantedRole });
  } catch {
    return res.status(500).json(INFRASTRUCTURE_ERROR_BODY);
  }
}

// Handler HTTP de GET /api/admin/me (Bloque 5A). Guard ESTRICTO de la identidad administrativa
// actual: reutiliza requirePrivileged (admin-auth.ts) sin duplicar ninguna lógica de
// verificación de JWT/rol/MFA aquí. requirePrivileged exige, en orden, (1) un JWT válido,
// (2) una fila admin_roles con rol reconocido (admin/moderator/developer), (3) MFA reciente.
// Sin fila o rol desconocido → 403 genérico; rol válido pero sin MFA reciente → 403 con code
// "step_up_required" (Fase 9G-1). Para saber el acceso SIN exigir MFA existe /access.
//
// La respuesta describe el rol y las capacidades derivadas server-side para PRESENTACIÓN:
// el cliente no las usa como autoridad (cada endpoint vuelve a exigir su capacidad). Nunca
// expone userId, email, el JWT ni datos de invitaciones.
export async function handleAdminMe(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  let me: PrivilegedIdentity;
  try {
    me = await requirePrivileged(req);
  } catch (err) {
    // AdminAuthError (401/403) se propaga tal cual. Cualquier otro caso
    // (AdminAuthInfrastructureError u otra excepción inesperada) es un fallo real de
    // infraestructura: genérico 500, nunca su mensaje interno.
    if (err instanceof AdminAuthError) {
      return res.status(err.status).json(authErrorBody(err));
    }
    return res.status(500).json(INFRASTRUCTURE_ERROR_BODY);
  }

  return res.status(200).json({
    role: me.role,
    capabilities: capabilitiesForRole(me.role),
  });
}

// Handler HTTP de GET /api/admin/access (Fase 9G-1). Información de acceso para PRESENTACIÓN:
// exige autenticación (JWT verificado) pero NO MFA reciente, para que el frontend sepa qué
// mostrar y si enrutar a un step-up. NO autoriza nada: cada endpoint privilegiado vuelve a
// exigir su propio guard (rol → capacidad → MFA reciente). Un usuario sin rol recibe
// `role: null` y jamás `step_up_required`. Solo describe al propio solicitante: no expone
// userId, email, el JWT, timestamps ni datos de otros usuarios.
export async function handleAdminAccess(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  // Describe la sesión actual de quien pregunta: ninguna respuesta (200, 401 ni 500) debe
  // cachearse ni reutilizarse entre usuarios o sesiones.
  res.setHeader("Cache-Control", "no-store");

  let access: AccessSummary;
  try {
    access = await getAccessSummary(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return res.status(err.status).json(authErrorBody(err));
    }
    return res.status(500).json(INFRASTRUCTURE_ERROR_BODY);
  }

  return res.status(200).json({
    role: access.role,
    capabilities: access.capabilities,
    mfa: { recent: access.mfaRecent },
  });
}
