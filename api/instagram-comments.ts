import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getInstagramComments,
  InstagramPermissionError,
  instagramErrorStatus,
  isValidInstagramMediaId,
  logInstagramError,
} from "../src/lib/instagram-shared.js";

// `?id=<media-id>` → comentarios de una publicación, bajo demanda al abrirla.
// - 200 `{ comments }` (lista vacía si la publicación no tiene comentarios).
// - 403 `{ reason: "insufficient_permission" }` si el token no puede leerlos
//   (falta instagram_business_manage_comments): no se disfraza de 200.
// - 502 para cualquier otro fallo del proveedor.
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
    const result = await getInstagramComments(id);

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(result);
  } catch (err) {
    logInstagramError("instagram-comments", err);

    if (err instanceof InstagramPermissionError) {
      return res.status(403).json({
        error: "No se pueden leer los comentarios de esta publicación",
        reason: "insufficient_permission",
        // Diagnóstico saneado (sin URL ni token) solo fuera de producción.
        ...(process.env.VERCEL_ENV !== "production" && { debug: err.message }),
      });
    }

    return res
      .status(instagramErrorStatus(err))
      .json({ error: "No se pudieron obtener los comentarios de Instagram" });
  }
}
