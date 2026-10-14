// Origen explícito de los retornos OAuth de TikTok e Instagram. Production usa SIEMPRE su dominio oficial:
// la redirect_uri jamás se deriva del Host de la petición ni de parámetros, y no existe un fallback al
// dominio anterior (upmina-web.vercel.app sirve el mismo despliegue, pero la cookie de `state` es de host:
// iniciar en un dominio y volver por otro rompe la validación). SOCIAL_OAUTH_BASE_URL solo permite sustituir
// el origen (https, sin ruta) y debe coincidir con lo registrado en el portal del proveedor.
export const CANONICAL_APP_ORIGIN = "https://upminaa-web.com";
const ORIGIN_FORMAT = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

export function socialOAuthOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SOCIAL_OAUTH_BASE_URL?.trim().replace(/\/+$/, "");
  if (!raw) return CANONICAL_APP_ORIGIN;
  if (!ORIGIN_FORMAT.test(raw)) throw new Error("invalid_social_oauth_base_url");
  return raw;
}

export const socialRedirectUri = (path: `/api/${string}`, env?: NodeJS.ProcessEnv) =>
  `${socialOAuthOrigin(env)}${path}`;
