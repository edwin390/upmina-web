import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleCosplayList, handleCosplayPost } from "../../src/lib/cosplay-handlers.js";

// Despachador de lecturas PÚBLICAS de contenido propio de Upmina (distinto de los proveedores
// externos, que ya tienen su propio patrón). Fase 9I-1: solo Cosplay. El nombre "content" (no
// "cosplay") es deliberado — la Fase 9J (Community) reutilizará este mismo entrypoint para sus
// propias lecturas públicas en vez de sumar otra Serverless Function, igual que
// api/instagram/[resource].ts consolida varios endpoints en una sola función por el límite de 12
// del plan Hobby de Vercel (con esta, van 11).
//
// Acciones soportadas hasta ahora:
//   "cosplay-list" (GET, ?cursor=) — página de publicaciones publicadas, ver cosplay-handlers.ts.
//   "cosplay-post" (GET, ?slug=)   — detalle de una publicación publicada por slug.
// Un `resource` desconocido nunca se interpreta como una llamada dinámica a otro handler:
// siempre 404, igual que el resto de despachadores del proyecto.
export default function handler(req: VercelRequest, res: VercelResponse) {
  switch (req.query.resource) {
    case "cosplay-list":
      return handleCosplayList(req, res);
    case "cosplay-post":
      return handleCosplayPost(req, res);
    default:
      return res.status(404).json({ error: "No encontrado" });
  }
}
