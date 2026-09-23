import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, requireAdmin } from "./admin-auth.js";
import { isInstagramAccessTokenExpired } from "./instagram-connection.js";
import { isTikTokRefreshTokenExpired } from "./tiktok-connection.js";

// Handler HTTP de GET /api/admin/social-status (Bloque 8E): estado de las conexiones
// sociales globales para el panel /admin. SOLO ADMIN con AAL2 (requireAdmin); solo después
// se usa service_role para leer social_connections, y solo las columnas de expiración: nunca
// se seleccionan ni se devuelven tokens, identificadores de cuenta, scopes ni filas crudas.
//
// Contrato:
//   200 : { connections: { instagram: { status }, tiktok: { status } } } con
//         status ∈ "connected" | "not_connected" | "reauth_required" (Cache-Control: no-store).
//   401/403 : requireAdmin.   405 : método distinto de GET (Allow: GET).
//   500 : cualquier fallo (auth infra, configuración, lectura) sin detalles. NUNCA se
//         interpreta un fallo de lectura como "not_connected".
//
// Semántica exacta (no afirma más de lo que se sabe):
//   not_connected   — NO existe fila en social_connections para ese proveedor.
//   connected       — existe una conexión almacenada cuyas credenciales persistidas NO han
//                     caducado según la MISMA regla que usa el feed. No prueba que el
//                     proveedor no la haya revocado.
//   reauth_required — existe la fila pero sus credenciales persistidas ya no sirven:
//                       Instagram: access token caducado o a ≤ 60 s de caducar
//                                  (isInstagramAccessTokenExpired, misma regla que el feed);
//                       TikTok:    refresh token caducado (isTikTokRefreshTokenExpired);
//                       o la fila tiene una fecha de expiración ilegible (no es utilizable).
//                     Se deriva SOLO de fechas absolutas persistidas, nunca de un error
//                     transitorio del proveedor. NO detecta, todavía, una revocación anterior
//                     a la caducidad ni un invalid_grant de TikTok: eso no se persiste hoy.
//
// Nota: mientras exista el fallback temporal INSTAGRAM_ACCESS_TOKEN, el feed de Instagram puede
// funcionar sin fila; este panel refleja solo la conexión OAuth almacenada.

export type SocialConnectionStatus = "connected" | "not_connected" | "reauth_required";

const GENERIC_ERROR_BODY = { error: "Error interno" };

interface ConnectionRow {
  provider?: unknown;
  access_token_expires_at?: unknown;
  refresh_token_expires_at?: unknown;
}

function isExpiredOrUnreadable(
  value: unknown,
  isExpired: (iso: string, now: number) => boolean,
  now: number,
): boolean {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return true;
  return isExpired(value, now);
}

function statusOf(
  provider: "instagram" | "tiktok",
  rows: ConnectionRow[],
  now: number,
): SocialConnectionStatus {
  const row = rows.find((r) => r.provider === provider);
  if (!row) return "not_connected";
  const expired =
    provider === "instagram"
      ? isExpiredOrUnreadable(
          row.access_token_expires_at,
          isInstagramAccessTokenExpired,
          now,
        )
      : isExpiredOrUnreadable(
          row.refresh_token_expires_at,
          isTikTokRefreshTokenExpired,
          now,
        );
  return expired ? "reauth_required" : "connected";
}

export async function handleAdminSocialStatus(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return res.status(500).json(GENERIC_ERROR_BODY);

  let rows: ConnectionRow[];
  try {
    const client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client
      .from("social_connections")
      .select("provider, access_token_expires_at, refresh_token_expires_at")
      .in("provider", ["instagram", "tiktok"]);
    if (error || !Array.isArray(data)) return res.status(500).json(GENERIC_ERROR_BODY);
    rows = data as ConnectionRow[];
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  const now = Date.now();
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    connections: {
      instagram: { status: statusOf("instagram", rows, now) },
      tiktok: { status: statusOf("tiktok", rows, now) },
    },
  });
}
