// Caché compartida (CDN de Vercel) de los endpoints públicos de TikTok e Instagram.
//
// Una respuesta ya almacenada en el borde NO ejecuta la función: ni una desconexión ni `no-store` posterior
// la retiran. Por eso: (1) TTL corto y SIN stale-while-revalidate (nunca se sirve una copia vencida de una
// cuenta que pudo desconectarse); (2) etiqueta de caché por proveedor para BORRAR al instante al desconectar
// (dangerously-delete-by-tags: la siguiente petición va a la función; «invalidate» serviría una copia vieja una vez más); (3) antes de marcar una respuesta como cacheable se
// confirma que la conexión sigue vigente, para que una petición en vuelo durante la desconexión no
// reintroduzca el contenido. Sin invalidación, la exposición máxima tras desconectar es SOCIAL_CACHE_TTL_SECONDS.
import type { VercelResponse } from "@vercel/node";

export type SocialCacheProvider = "tiktok" | "instagram";
export const SOCIAL_CACHE_TTL_SECONDS = 60;
export const SOCIAL_PUBLIC_CACHE_CONTROL = `public, s-maxage=${SOCIAL_CACHE_TTL_SECONDS}`;
/** Respuestas servidas desde el snapshot (el proveedor falló): aún más corta que la fresca. */
export const SOCIAL_SNAPSHOT_CACHE_CONTROL = "public, s-maxage=30";
export const socialCacheTag = (provider: SocialCacheProvider) => `social-${provider}`;

export function setSocialPublicCache(
  res: VercelResponse,
  provider: SocialCacheProvider,
  cacheControl: string = SOCIAL_PUBLIC_CACHE_CONTROL,
) {
  res.setHeader("Cache-Control", cacheControl);
  // Para el CDN de Vercel manda esta cabecera (misma vigencia); es la que la documentación empareja con Vercel-Cache-Tag.
  res.setHeader("Vercel-CDN-Cache-Control", cacheControl.replace("s-maxage", "max-age"));
  res.setHeader("Vercel-Cache-Tag", socialCacheTag(provider));
}

/** true solo si la conexión sigue vigente; cualquier duda (error) = false (fail-closed). */
export async function socialStillConnected(
  confirm: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (!confirm) return false;
  try {
    return await confirm();
  } catch {
    return false;
  }
}

export type SocialPurgeResult = "purged" | "not_configured" | "failed";

/** Borra en Vercel las copias etiquetadas del proveedor (POST /v1/edge-cache/dangerously-delete-by-tags: regeneración en primer plano). Requiere VERCEL_CACHE_PURGE_TOKEN y
 *  VERCEL_CACHE_PURGE_PROJECT_ID (y VERCEL_CACHE_PURGE_TEAM_ID si el proyecto es de un equipo). Nunca lanza
 *  ni registra el token. Las copias anteriores sin etiqueta solo desaparecen por TTL o por un despliegue nuevo. */
export async function purgeSocialPublicCache(
  provider: SocialCacheProvider,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<SocialPurgeResult> {
  const token = env.VERCEL_CACHE_PURGE_TOKEN?.trim();
  const project = env.VERCEL_CACHE_PURGE_PROJECT_ID?.trim();
  if (!token || !project) return "not_configured";
  const team = env.VERCEL_CACHE_PURGE_TEAM_ID?.trim();
  const url = new URL("https://api.vercel.com/v1/edge-cache/dangerously-delete-by-tags");
  url.searchParams.set("projectIdOrName", project);
  if (team) url.searchParams.set("teamId", team);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [socialCacheTag(provider)] }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok ? "purged" : "failed";
  } catch {
    return "failed";
  }
}
