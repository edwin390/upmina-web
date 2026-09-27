import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TikTokApiVideo } from "../types/api.js";
import type { TikTokVideo } from "../types/index.js";
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
} from "./tiktok-shared.js";
import { AdminAuthError, requireCapabilityForUser } from "./admin-auth.js";
import { isProductionEnvironment } from "./instagram-oauth-shared.js";
import { claimSocialOAuthFlow, isSocialOAuthFlowCurrent } from "./social-oauth-flow.js";
import {
  TikTokConnectionError,
  TikTokStorageError,
  assertTikTokStorageConfigured,
  getUsableTikTokAccessToken,
  logTikTokStorageError,
  markTikTokAccessTokenRejected,
  saveTikTokConnection,
  tiktokSnapshotOptions,
} from "./tiktok-connection.js";
import {
  openSnapshot,
  sendSnapshotHeaders,
  type ResourceSnapshot,
} from "./public-snapshot-fallback.js";
import type { SnapshotSourceId } from "./public-snapshot-resources.js";

// Handlers HTTP de los endpoints públicos de TikTok (callback, videos). El INICIO del OAuth ya
// no es público: solo existe POST /api/admin/social-connect (ADMIN + AAL2, ver
// src/lib/social-connect-handlers.ts). Viven aquí (no en api/) porque una única Serverless
// Function los atiende: api/tiktok/[resource].ts
// — mismo motivo y mismo patrón que ya usa Instagram (api/instagram/[resource].ts, ver
// src/lib/instagram-handlers.ts): el plan Hobby de Vercel permite como máximo 12
// Serverless Functions por deployment.
//
// Cada función de aquí es EXACTAMENTE la misma lógica que tenía su api/tiktok-*.ts
// original (antes de esta consolidación): mismo método permitido, mismos headers,
// mismas cookies, mismo manejo de errores, mismos status codes. Solo cambió dónde vive
// el archivo. Ver vercel.json para las reescrituras que mantienen intactas las URLs
// públicas /api/tiktok-callback y /api/tiktok-videos.

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ---------- /api/tiktok-callback ----------

/** Un fallo de infraestructura de la capability server-side (Supabase, admin_roles) es
 *  siempre fail-closed y sale como un 500 genérico: nunca como "no autorizado" ni con detalle. */
async function failClosed<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof TikTokOAuthError) throw err;
    throw new TikTokOAuthError("infraestructura del flujo OAuth no disponible", 500);
  }
}

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

  // Mismo guard que el callback de Instagram: Preview comparte Supabase con Production y no
  // debe poder completar (ni reclamar el flujo de) una autorización.
  if (!isProductionEnvironment()) {
    return callbackPage(
      res,
      403,
      "No disponible",
      "La conexión de TikTok solo puede completarse en Production.",
    );
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

    // Capability server-side (Bloque 8D): el callback solo puede completarse si nació de un
    // inicio autorizado por un ADMIN+AAL2 (POST /api/admin/social-connect). El flujo se
    // reclama de forma ATÓMICA (un solo uso, vigencia, proveedor y que siga siendo el mas
    // reciente) ANTES de gastar el code. verifyTikTokState ya comprobó que el nonce del
    // state es el de la cookie. Todos los rechazos comparten el mismo 400 genérico.
    const nonce = cookieNonce as string;
    const claim = await failClosed(() => claimSocialOAuthFlow("tiktok", nonce));
    if (claim.status !== "claimed") {
      throw new TikTokOAuthError("flujo OAuth no reclamable", 400);
    }
    // El AAL2 se exigió al iniciar; aquí solo se comprueba que ese usuario SIGUE siendo ADMIN.
    // El flujo ya queda consumido aunque falle.
    await failClosed(async () => {
      try {
        await requireCapabilityForUser(claim.adminUserId, "social_admin");
      } catch (err) {
        if (err instanceof AdminAuthError) {
          throw new TikTokOAuthError("administrador ya no autorizado", 400);
        }
        throw err;
      }
    });

    const tokens = await exchangeTikTokCode(code, credentials);

    // Justo antes de persistir: si un inicio más reciente sustituyó el flujo durante el
    // intercambio, esta autorización ya no es la vigente y NO puede sobrescribir la conexión.
    // (No se vuelve a exigir expires_at: la vigencia se comprobó al reclamar.) Riesgo residual
    // R1 aceptado: la ventana entre esta comprobación y el upsert no es atómica.
    const stillCurrent = await failClosed(() =>
      isSocialOAuthFlowCurrent("tiktok", nonce),
    );
    if (!stillCurrent) {
      throw new TikTokOAuthError("flujo OAuth reemplazado durante el intercambio", 400);
    }

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
    throw new TikTokOAuthError(
      "No se pudo contactar con TikTok",
      502,
      undefined,
      undefined,
      true,
    );
  }

  // `undefined` = el cuerpo no es un objeto JSON (ilegible, o un valor que no es un objeto).
  let body: { data?: unknown; error?: { code?: unknown } } | undefined;
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as typeof body;
    }
  } catch {
    // Cuerpo no JSON: se resuelve más abajo.
  }

  // TikTok v2 responde `{ data, error: { code: "ok" | ... } }`.
  const errorCode = typeof body?.error?.code === "string" ? body.error.code : undefined;
  if (!res.ok || (errorCode !== undefined && errorCode !== "ok")) {
    throw new TikTokOAuthError(
      "TikTok rechazó la lista de videos",
      502,
      res.status,
      safeCode(errorCode),
    );
  }

  // HTTP correcto: solo una lista `data.videos` es una respuesta válida. `[]` es "sin videos"
  // (vacío autoritativo); un cuerpo ilegible o sin esa lista (o con elementos que no se reconocen
  // como videos) NO puede convertirse en `[]`: ese vacío sustituiría al último snapshot bueno.
  const data = body?.data;
  const videos =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { videos?: unknown }).videos
      : undefined;
  if (!Array.isArray(videos)) throw invalidVideoList(res.status);
  const recognizable = videos.some(
    (video) =>
      video !== null &&
      typeof video === "object" &&
      typeof (video as Partial<TikTokApiVideo>).id === "string",
  );
  if (videos.length > 0 && !recognizable) throw invalidVideoList(res.status);

  return (videos as Partial<TikTokApiVideo>[])
    .map(normalizeVideo)
    .filter((video): video is TikTokVideo => video !== null);
}

// Sin código de proveedor ni status de error: no es elegible para snapshot (esquema inesperado).
const invalidVideoList = (httpStatus: number) =>
  new TikTokOAuthError(
    "TikTok devolvió una respuesta de videos inválida",
    502,
    httpStatus,
  );

// Feed de TikTok. El access token sale SOLO de la conexión guardada en Supabase (tabla
// social_connections, escrita por /api/tiktok-callback); no hay fallback a variables de
// entorno. Si caducó (o le quedan <60 s) se refresca antes, con lease atómico en Supabase.
// Nunca se devuelve ni registra un token.
export async function handleTikTokVideos(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  // SNAPSHOT (Fase 9H-4, checkpoint 4). Un snapshot NO basta por sí solo: se abre (y empieza a
  // leerse, en paralelo con el resto) solo cuando getUsableTikTokAccessToken establece en ESTA
  // petición que la conexión existe y su autorización es recuperable. Sin conexión, con el refresh
  // token caducado o rechazado (invalid_grant), con la lectura de la conexión rota o sin fuente no
  // hay snapshot: es resiliencia ante la disponibilidad de TikTok, nunca ante la autorización.
  let snapshot: ResourceSnapshot<"tiktok-videos"> = openSnapshot<"tiktok-videos">(
    undefined,
    undefined,
  );
  let source: SnapshotSourceId<"tiktok"> | undefined;
  let accessToken: string | undefined;

  try {
    accessToken = await getUsableTikTokAccessToken(undefined, {
      onConnection: (current) => {
        // La conexión puede releerse varias veces (espera de un refresh ajeno): solo se reabre si
        // la fuente cambió (p. ej. una reconexión entretanto).
        if (current === source) return;
        source = current;
        snapshot = openSnapshot("tiktok-videos", current, tiktokSnapshotOptions(current));
      },
    });
    const videos = await fetchTikTokVideos(accessToken);

    // `[]` (TikTok respondió sin videos) es un vacío autoritativo y también se guarda.
    await snapshot.save(videos);

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).json(videos);
  } catch (err) {
    // TikTok rechazó el access token (401 access_token_invalid): se marca para que la siguiente
    // petición pase por el refresh, y este fallo NUNCA sirve snapshot (ver isTikTokFallbackEligible).
    if (
      accessToken &&
      err instanceof TikTokOAuthError &&
      err.providerCode === "access_token_invalid"
    ) {
      await markTikTokAccessTokenRejected(accessToken);
    }

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

    const stale = await snapshot.fallback(err);
    if (stale) {
      sendSnapshotHeaders(res);
      return res.status(200).json(stale.value);
    }
    return res.status(status).json({ error: ERROR_MESSAGE });
  }
}
