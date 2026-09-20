import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getInstagramMedia,
  instagramErrorStatus,
  logInstagramError,
} from "../src/lib/instagram-shared.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const items = await getInstagramMedia();

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json(items);
  } catch (err) {
    logInstagramError("instagram-feed", err);
    return res
      .status(instagramErrorStatus(err))
      .json({ error: "No se pudo obtener el feed de Instagram" });
  }
}
