import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  TIKTOK_PAGE_HEADERS,
  TikTokOAuthError,
  clearStateCookie,
  exchangeTikTokCode,
  getTikTokCredentials,
  logTikTokError,
  readStateCookie,
  renderTikTokPage,
  safeCode,
  tikTokErrorStatus,
  verifyTikTokState,
} from "../src/lib/tiktok-shared.js";
import {
  TikTokStorageError,
  assertTikTokStorageConfigured,
  logTikTokStorageError,
  saveTikTokConnection,
} from "../src/lib/tiktok-connection.js";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function page(res: VercelResponse, status: number, title: string, message: string) {
  for (const [name, value] of Object.entries(TIKTOK_PAGE_HEADERS)) {
    res.setHeader(name, value);
  }
  // La cookie de state es de un solo uso: se borra en cualquier desenlace.
  res.setHeader("Set-Cookie", clearStateCookie());
  return res.status(status).send(renderTikTokPage(title, message));
}

// Redirect URI del OAuth de TikTok. Valida `state`, intercambia el code por tokens y los
// guarda en Supabase (server-side). Solo confirma el resultado: los tokens NO se
// muestran, registran ni salen en ninguna respuesta.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const credentials = getTikTokCredentials();

    const providerError = first(req.query.error);
    if (providerError) {
      // Cancelación del usuario u otro rechazo de TikTok: solo se registra el código.
      console.error(
        `[tiktok-callback] TikTok devolvió error (code=${safeCode(providerError) ?? "desconocido"})`,
      );
      return page(
        res,
        400,
        "Autorización no completada",
        "La autorización de TikTok fue cancelada o rechazada.",
      );
    }

    const state = first(req.query.state);
    const cookieNonce = readStateCookie(req.headers.cookie);
    if (!verifyTikTokState(state, cookieNonce, credentials.clientSecret)) {
      throw new TikTokOAuthError("state inválido, caducado o ausente", 400);
    }

    const code = first(req.query.code);
    if (!code) throw new TikTokOAuthError("Falta el parámetro code", 400);

    // El code es de un solo uso: si el almacenamiento no está configurado se aborta
    // ANTES de gastarlo en el intercambio.
    assertTikTokStorageConfigured();

    const tokens = await exchangeTikTokCode(code, credentials);

    try {
      await saveTikTokConnection(tokens);
    } catch (err) {
      // TikTok ya entregó los tokens pero no se pudieron guardar: se descartan (no se
      // muestran ni se registran) y NO se declara éxito. Hay que reiniciar el flujo.
      logTikTokStorageError("tiktok-callback", err);
      return page(
        res,
        err instanceof TikTokStorageError ? err.status : 500,
        "Autorización recibida, pero no guardada",
        "TikTok autorizó la cuenta, pero no se pudo guardar la conexión. Inicia el proceso de nuevo más tarde.",
      );
    }

    return page(
      res,
      200,
      "Autorización completada",
      "TikTok autorizó la cuenta y la conexión quedó guardada. Ya puedes cerrar esta ventana.",
    );
  } catch (err) {
    if (err instanceof TikTokStorageError) {
      logTikTokStorageError("tiktok-callback", err);
      return page(
        res,
        err.status,
        "Almacenamiento no disponible",
        "La integración con TikTok no está lista para guardar la conexión. Inténtalo más tarde.",
      );
    }
    logTikTokError("tiktok-callback", err);
    const status = tikTokErrorStatus(err);
    return page(
      res,
      status,
      "No se pudo completar la autorización",
      status === 400
        ? "La solicitud de autorización no es válida o caducó. Inicia el proceso de nuevo."
        : "No se pudo completar la autorización con TikTok. Inténtalo de nuevo más tarde.",
    );
  }
}
