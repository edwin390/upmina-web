import { supabase } from "@/lib/supabase";

// Cliente de GET /api/admin/access (Fase 9G-3). Describe, PARA PRESENTACIÓN, el acceso actual de
// la sesión: rol, capacidades y si el MFA es reciente. NO es autorización: el backend sigue siendo
// la única autoridad y cada endpoint privilegiado vuelve a exigir rol → capacidad → MFA reciente.
// Nada de esto se persiste ni se deriva de datos locales (JWT, metadata, storage): solo la
// respuesta del servidor, validada de forma defensiva (forma inesperada = sin acceso).

export type AdminRole = "admin" | "moderator" | "developer";

const KNOWN_CAPABILITIES = [
  "moderation",
  "technical",
  "social_admin",
  "team_admin",
] as const;
export type AdminCapability = (typeof KNOWN_CAPABILITIES)[number];

export interface AdminAccess {
  /** null = USER (sin rol privilegiado). */
  role: AdminRole | null;
  capabilities: AdminCapability[];
  /** MFA reciente según el SERVIDOR (aal2 + TOTP dentro de la ventana). No es aal2. */
  mfaRecent: boolean;
}

export const ADMIN_ACCESS_ENDPOINT = "/api/admin/access";

function isRole(value: unknown): value is AdminRole {
  return value === "admin" || value === "moderator" || value === "developer";
}

/**
 * Valida la respuesta de /access. Devuelve null (fail closed) ante cualquier forma inesperada:
 * no objeto, rol desconocido, capacidades que no sean una lista de strings, `mfa.recent` que no
 * sea un booleano, o un USER (rol null) con capacidades. Las capacidades desconocidas se ignoran.
 */
export function parseAdminAccess(body: unknown): AdminAccess | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { role, capabilities, mfa } = body as Record<string, unknown>;

  if (role !== null && !isRole(role)) return null;
  if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== "string")) {
    return null;
  }
  if (!mfa || typeof mfa !== "object" || Array.isArray(mfa)) return null;
  const recent = (mfa as Record<string, unknown>).recent;
  if (typeof recent !== "boolean") return null;

  const known = (capabilities as string[]).filter((c): c is AdminCapability =>
    (KNOWN_CAPABILITIES as readonly string[]).includes(c),
  );
  if (role === null && known.length > 0) return null;

  return { role, capabilities: known, mfaRecent: recent };
}

/** Por qué no hay acceso que mostrar: sesión rechazada por el servidor (401) o error genérico. */
export class AdminAccessError extends Error {
  constructor(readonly kind: "unauthenticated" | "error") {
    super(kind);
    this.name = "AdminAccessError";
  }
}

/**
 * Pide el acceso actual con el access token VIGENTE de Supabase (se lee en cada llamada: tras un
 * MFA o un refresh el token es otro). Lanza AdminAccessError si no hay token, el servidor
 * responde 401, falla la red o la respuesta no es válida. Nunca envía datos del cliente como
 * autoridad: solo el Bearer.
 */
export async function fetchAdminAccess(
  signal?: AbortSignal,
  expectedUserId?: string | null,
): Promise<AdminAccess> {
  if (!supabase) throw new AdminAccessError("error");

  let token: string | undefined;
  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token;
    // La respuesta se guarda bajo la clave de ESE usuario: si la sesión ya es de otra persona
    // (cambio en curso) no se pide con su token para no mezclar identidades.
    const sessionUserId = data.session?.user?.id;
    if (
      expectedUserId &&
      typeof sessionUserId === "string" &&
      sessionUserId !== expectedUserId
    ) {
      throw new AdminAccessError("error");
    }
  } catch (error) {
    if (error instanceof AdminAccessError) throw error;
    throw new AdminAccessError("error");
  }
  if (!token) throw new AdminAccessError("unauthenticated");

  let response: Response;
  try {
    response = await fetch(ADMIN_ACCESS_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal,
    });
  } catch {
    throw new AdminAccessError("error");
  }

  if (response.status === 401) throw new AdminAccessError("unauthenticated");
  if (!response.ok) throw new AdminAccessError("error");

  const body: unknown = await response.json().catch(() => null);
  const access = parseAdminAccess(body);
  if (!access) throw new AdminAccessError("error");
  return access;
}
