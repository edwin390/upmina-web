import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleCosplayList, handleCosplayPost } from "../../src/lib/cosplay-handlers.js";
import { handleCommunityFeed } from "../../src/lib/community-feed-handlers.js";

// Despachador de lecturas PÚBLICAS de contenido propio de Upmina (distinto de los proveedores
// externos, que ya tienen su propio patrón). El nombre "content" (no "cosplay") fue deliberado
// desde el principio: la Fase 9J-2A (Community) ya reutiliza este mismo entrypoint para sus
// propias lecturas públicas en vez de sumar otra Serverless Function, igual que
// api/instagram/[resource].ts consolida varios endpoints en una sola función por el límite de 12
// del plan Hobby de Vercel.
//
// Acciones soportadas hasta ahora:
//   "cosplay-list" (GET, ?cursor=)      — página de publicaciones publicadas, cosplay-handlers.ts.
//   "cosplay-post" (GET, ?slug=)        — detalle de una publicación publicada por slug.
//   "community-feed" (GET, ?cursor=)    — feed público de Comunidad (Fase 9J-2A), más reciente
//                                          primero, ver community-feed-handlers.ts.
// Un `resource` desconocido nunca se interpreta como una llamada dinámica a otro handler:
// siempre 404, igual que el resto de despachadores del proyecto.
export default function handler(req: VercelRequest, res: VercelResponse) {
  switch (req.query.resource) {
    case "cosplay-list":
      return handleCosplayList(req, res);
    case "cosplay-post":
      return handleCosplayPost(req, res);
    case "community-feed":
      return handleCommunityFeed(req, res);
    default:
      return res.status(404).json({ error: "No encontrado" });
  }
}
