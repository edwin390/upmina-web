import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  handleInstagramComments,
  handleInstagramFeed,
  handleInstagramMedia,
  handleInstagramProfile,
} from "../../src/lib/instagram-handlers.js";

// Consolida los 4 endpoints de solo lectura de Instagram (feed, profile, media,
// comments) en una única Serverless Function: el plan Hobby de Vercel permite como
// máximo 12 por deployment y el proyecto llegó a generar 14. Las URLs públicas NO
// cambian: vercel.json reescribe /api/instagram-feed, /api/instagram-profile,
// /api/instagram-media y /api/instagram-comments hacia /api/instagram/<resource>,
// preservando el querystring original (incluido ?id=... para media/comments) porque el
// destino de la reescritura no lleva su propio query string.
//
// La lógica de cada endpoint no cambió: vive intacta en src/lib/instagram-handlers.ts
// (copia exacta de lo que era cada api/instagram-*.ts). Este archivo es solo el
// despachador según el segmento dinámico `resource`.
export default function handler(req: VercelRequest, res: VercelResponse) {
  switch (req.query.resource) {
    case "feed":
      return handleInstagramFeed(req, res);
    case "profile":
      return handleInstagramProfile(req, res);
    case "media":
      return handleInstagramMedia(req, res);
    case "comments":
      return handleInstagramComments(req, res);
    default:
      return res.status(404).json({ error: "No encontrado" });
  }
}
