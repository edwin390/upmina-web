import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleCosplayList, handleCosplayPost } from "../../src/lib/cosplay-handlers.js";
import { handleCommunityFeed } from "../../src/lib/community-feed-handlers.js";
import { handleCommunityProfile } from "../../src/lib/community-profile-handlers.js";
import { handleCommunityPostDetail } from "../../src/lib/community-post-detail-handlers.js";

// Despachador de lecturas PÚBLICAS de contenido propio de Upmina (distinto de los proveedores
// externos, que ya tienen su propio patrón). El nombre "content" (no "cosplay") fue deliberado
// desde el principio: Community (Fase 9J-2A/9J-2B) ya reutiliza este mismo entrypoint para sus
// propias lecturas públicas en vez de sumar otra Serverless Function, igual que
// api/instagram/[resource].ts consolida varios endpoints en una sola función por el límite de 12
// del plan Hobby de Vercel.
//
// Acciones soportadas hasta ahora:
//   "cosplay-list" (GET, ?cursor=)                 — publicaciones publicadas, cosplay-handlers.ts.
//   "cosplay-post" (GET, ?slug=)                    — detalle de una publicación por slug.
//   "community-feed" (GET, ?cursor=)                — feed público de Comunidad (Fase 9J-2A), más
//                                                      reciente primero, community-feed-handlers.ts.
//   "community-profile" (GET, ?username=&cursor=)   — perfil público /@username + su galería
//                                                      paginada (Fase 9J-2B), ver
//                                                      community-profile-handlers.ts.
//   "community-post-detail" (GET, ?postId=)          — detalle público de UNA publicación (Fase
//                                                      9J-2B.1), ver
//                                                      community-post-detail-handlers.ts.
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
    case "community-profile":
      return handleCommunityProfile(req, res);
    case "community-post-detail":
      return handleCommunityPostDetail(req, res);
    default:
      return res.status(404).json({ error: "No encontrado" });
  }
}
