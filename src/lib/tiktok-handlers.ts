import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TikTokApiVideo } from "../types/api.js";
import type { TikTokVideo } from "../types/index.js";
import {
  TIKTOK_PAGE_HEADERS,
  TikTokOAuthError,
  buildTikTokAuthorizeUrl,
  clearStateCookie,
  createTikTokState,
  exchangeTikTokCode,
  getTikTokCredentials,
  logTikTokError,
  readStateCookie,
  renderTikTokPage,
  safeCode,
  stateCookie,
  tikTokErrorStatus,
  verifyTikTokState,
} from "./tiktok-shared.js";
import {
  TikTokConnectionError,
  TikTokStorageError,
  assertTikTokStorageConfigured,
  getUsableTikTokAccessToken,
  logTikTokStorageError,
  saveTikTokConnection,
} from "./tiktok-connection.js";

// Handlers HTTP de los 3 endpoints de TikTok (auth, callback, videos). Viven aquí (no en
// api/) porque una única Serverless Function los atiende ahora: api/tiktok/[resource].ts
// — mismo motivo y mismo patrón que ya usa Instagram (api/instagram/[resource].ts, ver
// src/lib/instagram-handlers.ts): el plan Hobby de Vercel permite como máximo 12
// Serverless Functions por deployment.
//
// Cada función de aquí es EXACTAMENTE la misma lógica que tenía su api/tiktok-*.ts
// original (antes de esta consolidación): mismo método permitido, mismos headers,
// mismas cookies, mismo manejo de errores, mismos status codes. Solo cambió dónde vive
// el archivo. Ver vercel.json para las reescrituras que mantienen intactas las URLs
// públicas /api/tiktok-auth, /api/tiktok-callback y /api/tiktok-videos.

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ---------- /api/tiktok-auth ----------

// Inicio del OAuth de TikTok: genera un `state` firmado (más su cookie HttpOnly) y
// redirige a la pantalla oficial de autorización. Solo scopes user.info.basic y video.list.
export function handleTikTokAuth(req: VercelRequest, res: VercelResponse) {
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

// ---------- /api/tiktok-callback ----------

function callbackPage(
  res: VercelResponse,
  status: number,
  title: string,
  message: string,
) {
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
export async function handleTikTokCallback(req: VercelRequest, res: VercelResponse) {
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
      return callbackPage(
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
      return callbackPage(
        res,
        err instanceof TikTokStorageError ? err.status : 500,
        "Autorización recibida, pero no guardada",
        "TikTok autorizó la cuenta, pero no se pudo guardar la conexión. Inicia el proceso de nuevo más tarde.",
      );
    }

    return callbackPage(
      res,
      200,
      "Autorización completada",
      "TikTok autorizó la cuenta y la conexión quedó guardada. Ya puedes cerrar esta ventana.",
    );
  } catch (err) {
    if (err instanceof TikTokStorageError) {
      logTikTokStorageError("tiktok-callback", err);
      return callbackPage(
        res,
        err.status,
        "Almacenamiento no disponible",
        "La integración con TikTok no está lista para guardar la conexión. Inténtalo más tarde.",
      );
    }
    logTikTokError("tiktok-callback", err);
    const status = tikTokErrorStatus(err);
    return callbackPage(
      res,
      status,
      "No se pudo completar la autorización",
      status === 400
        ? "La solicitud de autorización no es válida o caducó. Inicia el proceso de nuevo."
        : "No se pudo completar la autorización con TikTok. Inténtalo de nuevo más tarde.",
    );
  }
}

// ---------- /api/tiktok-videos ----------

const VIDEO_LIST_URL =
  "https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,share_url,create_time";
const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_MESSAGE = "No se pudieron obtener los videos de TikTok";

function isHttps(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("https://");
}

function normalizeVideo(video: Partial<TikTokApiVideo>): TikTokVideo | null {
  if (
    typeof video.id !== "string" ||
    !video.id ||
    !isHttps(video.share_url) ||
    !isHttps(video.cover_image_url) ||
    typeof video.create_time !== "number"
  ) {
    return null;
  }
  return {
    id: video.id,
    title: typeof video.title === "string" ? video.title : "",
    embedUrl: video.share_url,
    coverImageUrl: video.cover_image_url,
    createTime: new Date(video.create_time * 1000).toISOString(),
  };
}

/** Videos recientes de la cuenta autorizada, usando el access token guardado en Supabase. */
async function fetchTikTokVideos(accessToken: string): Promise<TikTokVideo[]> {
  let res: Response;
  try {
    res = await fetch(VIDEO_LIST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ max_count: 12 }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // El mensaje de un fallo de red podría incluir cabeceras: se descarta.
    throw new TikTokOAuthError("No se pudo contactar con TikTok", 502);
  }

  let body: { data?: { videos?: unknown }; error?: { code?: unknown } } = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as typeof body;
  } catch {
    // Cuerpo no JSON: se trata como error del proveedor.
  }

  // TikTok v2 responde `{ data, error: { code: "ok" | ... } }`.
  const errorCode = typeof body.error?.code === "string" ? body.error.code : undefined;
  if (!res.ok || (errorCode !== undefined && errorCode !== "ok")) {
    throw new TikTokOAuthError(
      "TikTok rechazó la lista de videos",
      502,
      res.status,
      safeCode(errorCode),
    );
  }

  const videos = Array.isArray(body.data?.videos) ? body.data.videos : [];
  return (videos as Partial<TikTokApiVideo>[])
    .map(normalizeVideo)
    .filter((video): video is TikTokVideo => video !== null);
}

// Feed de TikTok. El access token sale SOLO de la conexión guardada en Supabase (tabla
// social_connections, escrita por /api/tiktok-callback); no hay fallback a variables de
// entorno. Si caducó (o le quedan <60 s) se refresca antes, con lease atómico en Supabase.
// Nunca se devuelve ni registra un token.
export async function handleTikTokVideos(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const accessToken = await getUsableTikTokAccessToken();
    const videos = await fetchTikTokVideos(accessToken);

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).json(videos);
  } catch (err) {
    let status = 502;
    if (err instanceof TikTokConnectionError) {
      // Distinguible en logs (missing / refresh_token_expired / reauthorization_required /
      // refresh_in_progress); el cliente solo recibe el mensaje genérico.
      console.error(`[tiktok-videos] ${err.message} (reason=${err.reason})`);
      status = err.status;
    } else if (err instanceof TikTokStorageError) {
      logTikTokStorageError("tiktok-videos", err);
      status = err.status;
    } else {
      logTikTokError("tiktok-videos", err);
      status = tikTokErrorStatus(err);
    }
    return res.status(status).json({ error: ERROR_MESSAGE });
  }
}
