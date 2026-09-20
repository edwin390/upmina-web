import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getInstagramChildren,
  instagramErrorStatus,
  isValidInstagramMediaId,
  logInstagramError,
} from "../src/lib/instagram-shared.js";

// `?id=<media-id>` → elementos (children) de un carrusel. Se llama bajo demanda al
// abrir una publicación, nunca para todo el feed.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const { id } = req.query;
  if (!isValidInstagramMediaId(id)) {
    return res.status(400).json({ error: "Parámetro id no válido" });
  }

  try {
    const children = await getInstagramChildren(id);

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json({ children });
  } catch (err) {
    logInstagramError("instagram-media", err);
    return res
      .status(instagramErrorStatus(err))
      .json({ error: "No se pudo obtener la publicación de Instagram" });
  }
}
