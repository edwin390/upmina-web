import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getInstagramProfile,
  instagramErrorStatus,
  logInstagramError,
} from "../src/lib/instagram-shared.js";

// Username y foto de perfil de la cuenta autorizada. Una sola llamada para todo el
// sitio (el frontend la comparte entre la sección y el modal) y caché larga en el edge.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const profile = await getInstagramProfile();

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
    return res.status(200).json(profile);
  } catch (err) {
    logInstagramError("instagram-profile", err);
    return res
      .status(instagramErrorStatus(err))
      .json({ error: "No se pudo obtener el perfil de Instagram" });
  }
}
