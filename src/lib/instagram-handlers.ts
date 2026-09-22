import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  InstagramPermissionError,
  getInstagramChildren,
  getInstagramComments,
  getInstagramMedia,
  getInstagramProfile,
  instagramErrorStatus,
  isValidInstagramMediaId,
  logInstagramError,
} from "./instagram-shared.js";

// Handlers HTTP de los 4 endpoints de solo lectura de Instagram. Viven aquí (no en api/)
// porque una única Serverless Function los atiende ahora: api/instagram/[resource].ts.
// Motivo: el plan Hobby de Vercel permite como máximo 12 Serverless Functions por
// deployment; antes de esta consolidación el proyecto generaba 14 (ver vercel.json para
// las reescrituras que mantienen intactas las URLs públicas /api/instagram-feed,
// /api/instagram-profile, /api/instagram-media y /api/instagram-comments).
//
// Cada función de aquí es EXACTAMENTE la misma lógica que tenía su api/instagram-*.ts
// original (antes de esta consolidación): mismo método permitido, misma Cache-Control,
// mismos códigos de estado y el mismo saneado de errores. Solo cambió dónde vive el
// archivo y que ahora es una función nombrada en vez de un default export de api/.

export async function handleInstagramFeed(req: VercelRequest, res: VercelResponse) {
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

// Username y foto de perfil de la cuenta autorizada. Una sola llamada para todo el
// sitio (el frontend la comparte entre la sección y el modal) y caché larga en el edge.
export async function handleInstagramProfile(req: VercelRequest, res: VercelResponse) {
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

// `?id=<media-id>` → elementos (children) de un carrusel. Se llama bajo demanda al
// abrir una publicación, nunca para todo el feed.
export async function handleInstagramMedia(req: VercelRequest, res: VercelResponse) {
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

// `?id=<media-id>` → comentarios de una publicación, bajo demanda al abrirla.
// - 200 `{ comments }` (lista vacía si la publicación no tiene comentarios).
// - 403 `{ reason: "insufficient_permission" }` si el token no puede leerlos
//   (falta instagram_business_manage_comments): no se disfraza de 200.
// - 502 para cualquier otro fallo del proveedor.
export async function handleInstagramComments(req: VercelRequest, res: VercelResponse) {
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
