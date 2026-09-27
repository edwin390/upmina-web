import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import { isProductionEnvironment } from "./instagram-oauth-shared.js";
import { deleteSocialSnapshots } from "./public-snapshots.js";
import { getTikTokCredentials, revokeTikTokToken } from "./tiktok-shared.js";

// Handler HTTP de POST /api/admin/social-disconnect (Fase 9H-3): desconecta Instagram o TikTok.
// Operación DESTRUCTIVA y privilegiada. Solo se ejecuta cuando una persona la confirma en /admin;
// nada la dispara automáticamente y completar un MFA nunca la reproduce (el frontend no guarda
// intención ni credenciales: tras el MFA vuelve a /admin y hay que confirmar de nuevo).
//
// Orden (cada paso solo si el anterior pasó; el MFA nunca concede permisos):
//   método → requireCapability("social_admin") [401 | 403 genérico ANTES de MFA | 403
//   step_up_required | ok] → body → guard de entorno → desconexión.
//
// Contrato:
//   Request : POST, `Authorization: Bearer <access token>`, body JSON exactamente
//             { "provider": "instagram" | "tiktok" }. Cualquier otra forma → 400.
//   200     : { provider, status: "not_connected", was_connected } (Cache-Control: no-store).
//             IDEMPOTENTE: si ya estaba desconectado (o una petición concurrente ganó) también es
//             200 con was_connected=false. Nunca crea ni restaura credenciales.
//   400 body/provider inválido · 401/403 auth · 403 fuera de Production · 405 método (Allow: POST)
//   500 cualquier fallo de almacenamiento, genérico: NUNCA se afirma "desconectado" si el borrado
//       no se confirmó.
//
// Semántica local (autoritativa): se ELIMINA la fila de social_connections del proveedor. Sin fila
// = sin credenciales utilizables (los handlers públicos responden "no conectado", el panel
// "No conectado"; reconectar requiere el OAuth normal). El borrado es un único DELETE atómico que
// devuelve la fila borrada; un refresh en vuelo que empezó antes escribe con UPDATE condicionado
// al token viejo → 0 filas afectadas, así que NUNCA resucita la conexión (la desconexión gana).
//
// Snapshots (Fase 9H-4, checkpoint 4): tras confirmar el borrado de la conexión se eliminan los
// snapshots públicos de ESE proveedor (deleteSocialSnapshots: instagram-feed e instagram-profile, o
// tiktok-videos; nunca los de otro). Es limpieza SECUNDARIA: la desconexión ya es efectiva y los
// endpoints públicos solo sirven un snapshot si existe una conexión vigente con la misma fuente
// (id de la fila + cuenta), así que un fallo de la limpieza (o un snapshot huérfano que una petición
// en vuelo escriba después) jamás hace parecer conectada una cuenta desconectada. El resultado no
// cambia y la respuesta no revela nada de esto. También se ejecuta en una desconexión repetida.
//
// Revocación remota:
//   Instagram — LOCAL-ONLY: Meta no documenta un endpoint de revocación compatible con Instagram
//               Login (solo el refresco del token largo).
//   TikTok    — local + revocación remota BEST EFFORT (POST /v2/oauth/revoke/ documentado) DESPUÉS
//               del borrado local y solo si este request fue quien borró la fila. Una caída de
//               TikTok no deja estado ambiguo (ya está desconectado localmente) ni cambia el 200.
//
// Este handler nunca registra ni devuelve tokens, cuerpos del proveedor ni detalles de Supabase.

const GENERIC_ERROR_BODY = { error: "Error interno" };
const BAD_REQUEST_BODY = { error: "Solicitud inválida" };

type SocialProvider = "instagram" | "tiktok";

function parseProvider(req: VercelRequest): SocialProvider | null {
  const raw = req.body;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "provider") return null;
  return body.provider === "instagram" || body.provider === "tiktok"
    ? body.provider
    : null;
}

interface DeletedRow {
  access_token?: unknown;
}

/** Elimina la fila del proveedor. Devuelve el token borrado (o null si no había fila). Lanza si
 *  la operación no se pudo confirmar. */
async function deleteConnection(
  provider: SocialProvider,
): Promise<{ existed: boolean; accessToken: string | null }> {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) throw new Error("configuración ausente");
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client
    .from("social_connections")
    .delete()
    .eq("provider", provider)
    .select("access_token");
  if (error || !Array.isArray(data)) throw new Error("borrado no confirmado");
  const rows = data as DeletedRow[];
  const token = rows[0]?.access_token;
  return {
    existed: rows.length > 0,
    accessToken: typeof token === "string" && token ? token : null,
  };
}

export async function handleAdminSocialDisconnect(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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

  const provider = parseProvider(req);
  if (!provider) return res.status(400).json(BAD_REQUEST_BODY);

  // Preview y Production comparten Supabase: un Preview nunca debe borrar la conexión real.
  if (!isProductionEnvironment()) {
    return res.status(403).json({ error: "No disponible en este entorno" });
  }

  let deleted: { existed: boolean; accessToken: string | null };
  try {
    deleted = await deleteConnection(provider);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  // Limpieza de snapshots: DESPUÉS de confirmar el borrado (autoritativo) y ANTES de la revocación
  // remota (que puede tardar). Nunca lanza; si no se confirma, solo se registra.
  if (!(await deleteSocialSnapshots(provider))) {
    console.error("[social-disconnect] limpieza de snapshots no confirmada");
  }

  // TikTok: revocación remota best effort tras el borrado local; nunca cambia el resultado.
  if (provider === "tiktok" && deleted.existed && deleted.accessToken) {
    let revoked = false;
    try {
      revoked = await revokeTikTokToken(deleted.accessToken, getTikTokCredentials());
    } catch {
      revoked = false;
    }
    if (!revoked) {
      console.error("[social-disconnect] revocación remota de TikTok no confirmada");
    }
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    provider,
    status: "not_connected",
    was_connected: deleted.existed,
  });
}
