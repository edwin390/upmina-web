import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleMediaAccess } from "../../src/lib/media-access-handler.js";
import { handleMediaGc } from "../../src/lib/media-gc-handler.js";
import {
  handleMediaAbort,
  handleMediaComplete,
  handleMediaReserve,
} from "../../src/lib/media-handlers.js";

// Despachador del pipeline de medios (Fase 9I-2B): última función Serverless disponible del plan
// Hobby de Vercel (12 de 12, tras api/content/[resource].ts en 11 de 12). Mismo patrón que el
// resto de despachadores del proyecto: un único entrypoint, switch cerrado, 404 en cualquier
// `resource` desconocido — nunca se interpreta como una llamada dinámica a otro handler.
//
// A diferencia de api/content/[resource].ts (solo lectura pública), TODAS las acciones de aquí
// son privilegiadas (ADMIN + cosplay_admin + MFA reciente, verificado en cada handler — ver
// media-handlers.ts). "domain" viaja en el body de cada request (hoy solo "cosplay" es válido),
// no en la URL: así la Fase 9J (Community) puede reutilizar este mismo dispatcher sin sumar otro.
//
// Acciones soportadas:
//   "reserve"  (POST) — autoriza una subida (URL de un solo PUT o de multipart) y crea la fila
//              media_assets en 'reserved'.
//   "complete" (POST) — confirma que la subida terminó: completa multipart si aplica, verifica el
//              objeto en R2, lo copia a almacenamiento privado permanente, ejecuta el procesado
//              canónico (sharp/libheif-js) y publica las variantes WebP.
//   "abort"    (POST) — cancela una reserva en curso (nunca un asset ya listo) y limpia R2.
//   "access"   (POST) — R4-D1: consulta firmada (HMAC) del Worker de entrega; la ÚNICA acción de
//              este despachador que no usa sesión de usuario. Solo responde { public: boolean }.
//   "gc"       (POST) — R4-E2: lote INTERNO de GC físico de medios; HMAC de dominio propio
//              (MEDIA_GC_SHARED_SECRET), cuerpo vacío, sin parámetros del llamador. Solo recuentos.
export default function handler(req: VercelRequest, res: VercelResponse) {
  switch (req.query.resource) {
    case "reserve":
      return handleMediaReserve(req, res);
    case "complete":
      return handleMediaComplete(req, res);
    case "abort":
      return handleMediaAbort(req, res);
    case "access":
      return handleMediaAccess(req, res);
    case "gc":
      return handleMediaGc(req, res);
    default:
      return res.status(404).json({ error: "No encontrado" });
  }
}
