import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import {
  socialLifecycle,
  type SocialConnectionRow,
  type SocialLifecycleStatus,
} from "./social-lifecycle.js";

// Handler HTTP de GET /api/admin/social-status (Bloque 8E): estado de las conexiones
// sociales globales para el panel /admin. SOLO ADMIN con AAL2 (requireCapability social_admin); solo después
// se usa service_role para leer social_connections, y solo las columnas de expiración: nunca
// se seleccionan ni se devuelven tokens, identificadores de cuenta, scopes ni filas crudas.
//
// Contrato:
//   200 : { connections: { instagram: { status, expiresAt? }, tiktok: { status, expiresAt? } } } con
//         status ∈ "connected" | "expiring_soon" | "reauth_required" | "not_connected"
//         (Cache-Control: no-store). La semántica exacta de cada estado (reglas, umbrales, fail
//         closed) vive en social-lifecycle.ts; `expiresAt` es la fecha que gobierna el estado.
//   401/403 : requireCapability social_admin.   405 : método distinto de GET (Allow: GET).
//   500 : cualquier fallo (auth infra, configuración, lectura) sin detalles. NUNCA se
//         interpreta un fallo de lectura como "not_connected".
//
// Es de SOLO LECTURA y no toca al proveedor: no rota tokens, no crea flujos OAuth ni desconecta.
// Solo se seleccionan columnas de expiración: nunca tokens, ids de cuenta, scopes ni filas crudas.
//
// Nota: el feed de Instagram solo usa INSTAGRAM_ACCESS_TOKEN si Supabase no está configurado
// (desarrollo local); con Supabase configurado, este estado y el feed leen la misma fila.

export type SocialConnectionStatus = SocialLifecycleStatus;

const GENERIC_ERROR_BODY = { error: "Error interno" };

export async function handleAdminSocialStatus(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    await requireCapability(req, "social_admin");
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return res.status(err.status).json(authErrorBody(err));
    }
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return res.status(500).json(GENERIC_ERROR_BODY);

  let rows: SocialConnectionRow[];
  try {
    const client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client
      .from("social_connections")
      .select("provider, access_token_expires_at, refresh_token_expires_at")
      .in("provider", ["instagram", "tiktok"]);
    if (error || !Array.isArray(data)) return res.status(500).json(GENERIC_ERROR_BODY);
    rows = data as SocialConnectionRow[];
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  const now = Date.now();
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    connections: {
      instagram: socialLifecycle("instagram", rows, now),
      tiktok: socialLifecycle("tiktok", rows, now),
    },
  });
}
