import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  handleTikTokAuth,
  handleTikTokCallback,
  handleTikTokVideos,
} from "../../src/lib/tiktok-handlers.js";

// Consolida los 3 endpoints de TikTok (auth, callback, videos) en una única Serverless
// Function: el plan Hobby de Vercel permite como máximo 12 por deployment. Las URLs
// públicas NO cambian: vercel.json reescribe /api/tiktok-auth, /api/tiktok-callback y
// /api/tiktok-videos hacia /api/tiktok/<resource>, preservando el querystring original
// (incluido ?code=&state= en el callback) porque el destino de la reescritura no lleva
// su propio query string. Mismo patrón que api/instagram/[resource].ts.
//
// La lógica de cada endpoint no cambió: vive intacta en src/lib/tiktok-handlers.ts
// (copia exacta de lo que era cada api/tiktok-*.ts). Este archivo es solo el
// despachador según el segmento dinámico `resource`.
export default function handler(req: VercelRequest, res: VercelResponse) {
  switch (req.query.resource) {
    case "auth":
      return handleTikTokAuth(req, res);
    case "callback":
      return handleTikTokCallback(req, res);
    case "videos":
      return handleTikTokVideos(req, res);
    default:
      return res.status(404).json({ error: "No encontrado" });
  }
}
