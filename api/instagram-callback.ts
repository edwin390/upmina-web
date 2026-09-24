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
  logInstagramStorageError,
  saveInstagramConnection,
} from "../src/lib/instagram-connection.js";
import { AdminAuthError, requireCapabilityForUser } from "../src/lib/admin-auth.js";
import {
  claimSocialOAuthFlow,
  isSocialOAuthFlowCurrent,
} from "../src/lib/social-oauth-flow.js";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Un fallo de infraestructura de la capability server-side (Supabase, admin_roles) es
 *  siempre fail-closed y sale como un 500 genérico: nunca como "no autorizado" ni con detalle. */
async function failClosed<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof InstagramOAuthError) throw err;
    throw new InstagramOAuthError("infraestructura del flujo OAuth no disponible", 500);
  }
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

    // Capability server-side (Bloque 8D): el callback solo puede completarse si nació de un
    // inicio autorizado por un ADMIN+AAL2 (POST /api/admin/social-connect). El flujo se
    // reclama de forma ATÓMICA (un solo uso, vigencia, proveedor y que siga siendo el mas
    // reciente) ANTES de tocar Meta o Supabase; sustituye a la antigua barrera
    // instagram_oauth_nonces. Todos los rechazos comparten el mismo 400 genérico: no se
    // distingue inexistente/expirado/consumido/sustituido ni admin revocado.
    const claim = await failClosed(() =>
      claimSocialOAuthFlow("instagram", verifiedState.nonce),
    );
    if (claim.status !== "claimed") {
      throw new InstagramOAuthError("flujo OAuth no reclamable", 400);
    }
    // El AAL2 se exigió al iniciar; aquí solo se comprueba que ese usuario SIGUE siendo ADMIN.
    // El flujo ya queda consumido aunque falle.
    await failClosed(async () => {
      try {
        await requireCapabilityForUser(claim.adminUserId, "social_admin");
      } catch (err) {
        if (err instanceof AdminAuthError) {
          throw new InstagramOAuthError("administrador ya no autorizado", 400);
        }
        throw err;
      }
    });

    const shortLived = await exchangeInstagramCode(code, credentials);
    const longLived = await exchangeForLongLivedToken(
      shortLived.accessToken,
      credentials,
    );

    // Justo antes de persistir: si un inicio más reciente sustituyó el flujo durante el
    // intercambio, esta autorización ya no es la vigente y NO puede sobrescribir la conexión.
    // (No se vuelve a exigir expires_at: la vigencia se comprobó al reclamar.) Riesgo residual
    // R1 aceptado: la ventana entre esta comprobación y el upsert no es atómica.
    const stillCurrent = await failClosed(() =>
      isSocialOAuthFlowCurrent("instagram", verifiedState.nonce),
    );
    if (!stillCurrent) {
      throw new InstagramOAuthError(
        "flujo OAuth reemplazado durante el intercambio",
        400,
      );
    }

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
