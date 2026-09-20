import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  TIKTOK_PAGE_HEADERS,
  buildTikTokAuthorizeUrl,
  createTikTokState,
  getTikTokCredentials,
  logTikTokError,
  renderTikTokPage,
  stateCookie,
  tikTokErrorStatus,
} from "../src/lib/tiktok-shared.js";

// Inicio del OAuth de TikTok: genera un `state` firmado (más su cookie HttpOnly) y
// redirige a la pantalla oficial de autorización. Solo scopes user.info.basic y video.list.
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const credentials = getTikTokCredentials();
    const { state, nonce } = createTikTokState(credentials.clientSecret);

    res.setHeader("Set-Cookie", stateCookie(nonce));
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, buildTikTokAuthorizeUrl(credentials.clientKey, state));
  } catch (err) {
    logTikTokError("tiktok-auth", err);
    for (const [name, value] of Object.entries(TIKTOK_PAGE_HEADERS)) {
      res.setHeader(name, value);
    }
    return res
      .status(tikTokErrorStatus(err))
      .send(
        renderTikTokPage(
          "No se pudo iniciar la autorización",
          "La integración con TikTok no está disponible en este momento.",
        ),
      );
  }
}
