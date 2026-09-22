import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  INSTAGRAM_PAGE_HEADERS,
  InstagramOAuthError,
  clearStateCookie,
  exchangeForLongLivedToken,
  exchangeInstagramCode,
  getInstagramOAuthCredentials,
  instagramOAuthErrorStatus,
  isProductionEnvironment,
  logInstagramOAuthError,
  readStateCookie,
  renderInstagramPage,
  safeCode,
  verifyInstagramState,
} from "../src/lib/instagram-oauth-shared.js";
import {
  InstagramStorageError,
  assertInstagramStorageConfigured,
  claimInstagramOAuthNonce,
  logInstagramStorageError,
  saveInstagramConnection,
} from "../src/lib/instagram-connection.js";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function page(res: VercelResponse, status: number, title: string, message: string) {
  for (const [name, value] of Object.entries(INSTAGRAM_PAGE_HEADERS)) {
    res.setHeader(name, value);
  }
  // La cookie de state se borra en cualquier desenlace (éxito o error): no queda
  // reutilizable desde el navegador. La garantía real ante una repetición manual del
  // callback (mismo state reenviado con la cookie original) la da
  // claimInstagramOAuthNonce, no esta cookie por sí sola.
  res.setHeader("Set-Cookie", clearStateCookie());
  return res.status(status).send(renderInstagramPage(title, message));
}

// Redirect URI del OAuth de Instagram (Instagram API with Instagram Login). Valida
// `state`, intercambia el code por un token de corta duración, lo convierte a uno de
// larga duración (~60 días) y guarda la conexión en Supabase (server-side). Bloqueado
// fuera de Production por el mismo motivo que api/instagram-auth.ts. Los tokens NO se
// muestran, registran ni salen en ninguna respuesta.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  if (!isProductionEnvironment()) {
    return page(
      res,
      403,
      "No disponible",
      "La conexión de Instagram solo puede completarse en Production.",
    );
  }

  try {
    const credentials = getInstagramOAuthCredentials();

    const providerError = first(req.query.error);
    if (providerError) {
      // Cancelación del usuario u otro rechazo de Instagram: solo se registra el código.
      console.error(
        `[instagram-callback] Instagram devolvió error (code=${safeCode(providerError) ?? "desconocido"})`,
      );
      return page(
        res,
        400,
        "Autorización no completada",
        "La autorización de Instagram fue cancelada o rechazada.",
      );
    }

    const state = first(req.query.state);
    const cookieNonce = readStateCookie(req.headers.cookie);
    const verifiedState = verifyInstagramState(state, cookieNonce, credentials.appSecret);
    if (!verifiedState) {
      throw new InstagramOAuthError("state inválido, caducado o ausente", 400);
    }

    const code = first(req.query.code);
    if (!code) throw new InstagramOAuthError("Falta el parámetro code", 400);

    // El code es de un solo uso: si el almacenamiento no está configurado se aborta
    // ANTES de gastarlo en el intercambio.
    assertInstagramStorageConfigured();

    // Reclama el nonce de forma ATÓMICA antes de tocar Meta o Supabase: una repetición
    // de este mismo callback (mismo state) o dos peticiones concurrentes deben fallar
    // aquí, sin depender de que Instagram rechace un authorization code ya usado.
    const claim = await claimInstagramOAuthNonce(
      verifiedState.nonce,
      verifiedState.expiresAt,
    );
    if (claim === "already_used") {
      throw new InstagramOAuthError("Esta autorización ya se procesó", 409);
    }

    const shortLived = await exchangeInstagramCode(code, credentials);
    const longLived = await exchangeForLongLivedToken(
      shortLived.accessToken,
      credentials,
    );

    try {
      await saveInstagramConnection({
        accessToken: longLived.accessToken,
        providerUserId: shortLived.providerUserId,
        expiresIn: longLived.expiresIn,
        scope: shortLived.permissions,
      });
    } catch (err) {
      // Instagram ya entregó los tokens pero no se pudieron guardar: se descartan (no se
      // muestran ni se registran) y NO se declara éxito. La conexión anterior, si
      // existía, sigue intacta (saveInstagramConnection nunca borra antes de escribir).
      logInstagramStorageError("instagram-callback", err);
      return page(
        res,
        err instanceof InstagramStorageError ? err.status : 500,
        "Autorización recibida, pero no guardada",
        "Instagram autorizó la cuenta, pero no se pudo guardar la conexión. Inicia el proceso de nuevo más tarde.",
      );
    }

    return page(
      res,
      200,
      "Autorización completada",
      "Instagram conectado correctamente. Ya puedes cerrar esta ventana.",
    );
  } catch (err) {
    if (err instanceof InstagramStorageError) {
      logInstagramStorageError("instagram-callback", err);
      return page(
        res,
        err.status,
        "Almacenamiento no disponible",
        "La integración con Instagram no está lista para guardar la conexión. Inténtalo más tarde.",
      );
    }
    logInstagramOAuthError("instagram-callback", err);
    const status = instagramOAuthErrorStatus(err);
    const message =
      status === 400
        ? "La solicitud de autorización no es válida o caducó. Inicia el proceso de nuevo."
        : status === 409
          ? "Esta autorización ya se procesó. Si necesitas reconectar la cuenta, inicia el proceso de nuevo."
          : "No se pudo completar la autorización con Instagram. Inténtalo de nuevo más tarde.";
    return page(res, status, "No se pudo completar la autorización", message);
  }
}
