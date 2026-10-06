import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ACCESS_SIGNATURE_HEADER,
  ACCESS_TIMESTAMP_HEADER,
  GC_REQUEST_METHOD,
  GC_REQUEST_PATH,
  verifyGcRequest,
} from "./media-delivery-protocol.js";
import { GcUnavailableError, runMediaGcBatch } from "./media-gc.js";

// POST /api/media/gc (R4-E2): endpoint INTERNO del scheduler. No usa sesión de usuario ni cookies:
// se autentica con una firma HMAC de dominio propio (UPMINA-MEDIA-GC-V1, secreto
// MEDIA_GC_SHARED_SECRET, distinto del de /api/media/access). La petición NO elige nada: ni
// assets, ni claves, ni bucket, ni límite — el cuerpo debe estar vacío y la BD decide qué
// assets están en 'deleting' y qué objetos les pertenecen. Responde solo recuentos.
//
// Replay: una repetición dentro de la ventana de ±30 s solo ejecuta otro lote GC idempotente
// decidido por la BD (nunca un efecto elegido por el atacante).

const UNAUTHORIZED = { error: "No autorizado" };
const INVALID = { error: "Solicitud inválida" };
const GENERIC = { error: "No se pudo completar la solicitud" };

function header(req: VercelRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Cuerpo vacío: ausente, null, cadena vacía u objeto plano SIN claves (Vercel entrega `{}` cuando
 * llega Content-Type: application/json sin cuerpo, p. ej. desde pg_net). Cualquier otro valor
 * (objeto con claves, texto, arreglo) se rechaza: la petición no puede elegir nada.
 */
function hasEmptyBody(req: VercelRequest): boolean {
  const body: unknown = req.body;
  if (body === undefined || body === null || body === "") return true;
  return (
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.getPrototypeOf(body) === Object.prototype &&
    Object.keys(body).length === 0
  );
}

export async function handleMediaGc(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== GC_REQUEST_METHOD) {
    res.setHeader("Allow", GC_REQUEST_METHOD);
    return res.status(405).json({ error: "Método no permitido" });
  }
  const secret = process.env.MEDIA_GC_SHARED_SECRET?.trim();
  if (!secret) return res.status(500).json(GENERIC); // fail-closed: sin secreto no hay GC

  const verified = await verifyGcRequest(secret, {
    method: req.method,
    path: GC_REQUEST_PATH,
    timestamp: header(req, ACCESS_TIMESTAMP_HEADER),
    signature: header(req, ACCESS_SIGNATURE_HEADER),
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verified.ok) return res.status(401).json(UNAUTHORIZED);

  // Autenticada, pero sin parámetros: nada de assets, claves, buckets ni límites del llamador.
  const extraQuery = Object.keys(req.query ?? {}).some((k) => k !== "resource");
  if (!hasEmptyBody(req) || extraQuery) return res.status(400).json(INVALID);

  try {
    const summary = await runMediaGcBatch();
    return res.status(200).json(summary);
  } catch (error) {
    if (!(error instanceof GcUnavailableError)) console.error("[media-gc] run failed");
    return res.status(500).json(GENERIC);
  }
}
