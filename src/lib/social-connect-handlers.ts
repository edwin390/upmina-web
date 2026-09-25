import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import {
  INSTAGRAM_AUTHORIZE_URL,
  INSTAGRAM_REDIRECT_URI,
  buildInstagramAuthorizeUrl,
  createInstagramState,
  getInstagramOAuthCredentials,
  isProductionEnvironment,
  stateCookie as instagramStateCookie,
} from "./instagram-oauth-shared.js";
import { createSocialOAuthFlow, type SocialOAuthProvider } from "./social-oauth-flow.js";
import {
  TIKTOK_AUTHORIZE_URL,
  TIKTOK_REDIRECT_URI,
  buildTikTokAuthorizeUrl,
  createTikTokState,
  getTikTokCredentials,
  stateCookie as tiktokStateCookie,
} from "./tiktok-shared.js";

// Handler HTTP de POST /api/admin/social-connect (Bloque 8C.2): el ÚNICO inicio protegido del
// OAuth de Instagram/TikTok. Solo un ADMIN con AAL2 (requireCapability social_admin) puede obtener una URL de
// autorización; el navegador navega a ella después (este endpoint NO redirige).
//
// Contrato:
//   Request : POST, `Authorization: Bearer <access token>`, body JSON exactamente
//             { "provider": "instagram" | "tiktok" }. Cualquier otra forma → 400.
//   200     : { "authorization_url": "https://…" } + `Set-Cookie` (cookie de correlación del
//             proveedor, la misma que ya entienden los callbacks) + `Cache-Control: no-store`.
//   400     : cuerpo/provider inválido.       401/403 : requireCapability social_admin (sin distinguir causa).
//   403     : fuera de Production (solo tras autenticar).
//   405     : método distinto de POST (con Allow: POST).
//   500     : cualquier fallo inesperado, sin detalles.  503 : credenciales del proveedor ausentes.
//
// El user_id del flujo sale EXCLUSIVAMENTE de requireCapability (JWT verificado); el `state` conserva
// el formato actual `<nonce>.<expiraMs>.<HMAC>` y NO contiene ninguna identidad. Redirect URI,
// scopes y URL base son constantes del servidor: nada de eso se acepta del cliente.
//
// Orden de efectos (el único con efecto persistente es el penúltimo): método, requireCapability,
// body, guard de entorno, credenciales, cálculo puro de nonce/state/cookie/URL, validación
// defensiva de la URL, createSocialOAuthFlow, respuesta. Un fallo anterior a la persistencia no
// deja ningún flujo; si falla la persistencia no se envía cookie ni URL.
//
// Este handler no registra nada: ni nonce, state, JWT ni secretos.

const GENERIC_ERROR_BODY = { error: "Error interno" };
const BAD_REQUEST_BODY = { error: "Solicitud inválida" };

interface ProviderAdapter {
  authorizeUrl: string;
  redirectUri: string;
  /** Identificador público y secreto de la app; lanza si falta configuración. */
  credentials: () => { id: string; secret: string };
  createState: (secret: string) => { state: string; nonce: string };
  cookie: (nonce: string) => string;
  buildUrl: (id: string, state: string) => string;
}

const PROVIDERS: Record<SocialOAuthProvider, ProviderAdapter> = {
  instagram: {
    authorizeUrl: INSTAGRAM_AUTHORIZE_URL,
    redirectUri: INSTAGRAM_REDIRECT_URI,
    credentials: () => {
      const { appId, appSecret } = getInstagramOAuthCredentials();
      return { id: appId, secret: appSecret };
    },
    createState: (secret) => createInstagramState(secret),
    cookie: instagramStateCookie,
    buildUrl: buildInstagramAuthorizeUrl,
  },
  tiktok: {
    authorizeUrl: TIKTOK_AUTHORIZE_URL,
    redirectUri: TIKTOK_REDIRECT_URI,
    credentials: () => {
      const { clientKey, clientSecret } = getTikTokCredentials();
      return { id: clientKey, secret: clientSecret };
    },
    createState: (secret) => createTikTokState(secret),
    cookie: tiktokStateCookie,
    buildUrl: buildTikTokAuthorizeUrl,
  },
};

const hasOwn = (obj: object, key: string) =>
  Object.prototype.hasOwnProperty.call(obj, key);

function parseJsonBody(req: VercelRequest): Record<string, unknown> | null {
  const raw = req.body;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** El body debe ser EXACTAMENTE { provider: "instagram" | "tiktok" }. */
function parseProvider(req: VercelRequest): SocialOAuthProvider | null {
  const body = parseJsonBody(req);
  if (!body) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || !hasOwn(body, "provider")) return null;
  const provider = body.provider;
  return provider === "instagram" || provider === "tiktok" ? provider : null;
}

/** La URL final debe ser https, del host/ruta oficiales del proveedor y con el redirect_uri
 *  exacto: una regresión en el constructor de URLs nunca entrega una URL arbitraria. */
function isExpectedAuthorizationUrl(url: string, adapter: ProviderAdapter): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const expected = new URL(adapter.authorizeUrl);
  return (
    parsed.protocol === "https:" &&
    parsed.host === expected.host &&
    parsed.pathname === expected.pathname &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.searchParams.get("redirect_uri") === adapter.redirectUri
  );
}

export async function handleAdminSocialConnect(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  // Primera frontera sensible: JWT verificado + rol admin + aal2. Un fallo de
  // infraestructura NUNCA se interpreta como "sin rol": 500 genérico.
  let userId: string;
  try {
    ({ userId } = await requireCapability(req, "social_admin"));
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return res.status(err.status).json(authErrorBody(err));
    }
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  const provider = parseProvider(req);
  if (!provider) return res.status(400).json(BAD_REQUEST_BODY);

  if (!isProductionEnvironment()) {
    return res.status(403).json({ error: "No disponible en este entorno" });
  }

  const adapter = PROVIDERS[provider];
  let credentials: { id: string; secret: string };
  try {
    credentials = adapter.credentials();
  } catch {
    return res.status(503).json({ error: "Integración no disponible" });
  }

  let nonce: string;
  let cookie: string;
  let authorizationUrl: string;
  try {
    const started = adapter.createState(credentials.secret);
    nonce = started.nonce;
    authorizationUrl = adapter.buildUrl(credentials.id, started.state);
    cookie = adapter.cookie(nonce);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
  if (!isExpectedAuthorizationUrl(authorizationUrl, adapter)) {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  try {
    await createSocialOAuthFlow(provider, nonce, userId);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", cookie);
  return res.status(200).json({ authorization_url: authorizationUrl });
}
