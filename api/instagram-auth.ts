import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  INSTAGRAM_PAGE_HEADERS,
  buildInstagramAuthorizeUrl,
  createInstagramState,
  getInstagramOAuthCredentials,
  instagramOAuthErrorStatus,
  isProductionEnvironment,
  logInstagramOAuthError,
  renderInstagramPage,
  stateCookie,
} from "../src/lib/instagram-oauth-shared.js";

function productionOnlyPage(res: VercelResponse) {
  for (const [name, value] of Object.entries(INSTAGRAM_PAGE_HEADERS)) {
    res.setHeader(name, value);
  }
  return res
    .status(403)
    .send(
      renderInstagramPage(
        "No disponible",
        "La conexión de Instagram solo puede iniciarse desde Production.",
      ),
    );
}

// Inicio del OAuth de Instagram (Instagram API with Instagram Login / Business Login):
// genera un `state` firmado (más su cookie HttpOnly) y redirige a la pantalla oficial de
// autorización de Meta. Solo scopes instagram_business_basic e
// instagram_business_manage_comments.
//
// Bloqueado fuera de Production: Preview comparte el mismo Supabase que Production y no
// debe poder reemplazar su conexión de Instagram (ver instagram-oauth-shared.ts).
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  if (!isProductionEnvironment()) {
    return productionOnlyPage(res);
  }

  try {
    const credentials = getInstagramOAuthCredentials();
    const { state, nonce } = createInstagramState(credentials.appSecret);

    res.setHeader("Set-Cookie", stateCookie(nonce));
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, buildInstagramAuthorizeUrl(credentials.appId, state));
  } catch (err) {
    logInstagramOAuthError("instagram-auth", err);
    for (const [name, value] of Object.entries(INSTAGRAM_PAGE_HEADERS)) {
      res.setHeader(name, value);
    }
    return res
      .status(instagramOAuthErrorStatus(err))
      .send(
        renderInstagramPage(
          "No se pudo iniciar la autorización",
          "La conexión con Instagram no está disponible en este momento.",
        ),
      );
  }
}
