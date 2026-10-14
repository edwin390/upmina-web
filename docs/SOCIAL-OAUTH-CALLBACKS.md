# OAuth de TikTok e Instagram — callbacks y configuración externa

## Causa raíz (confirmada en el código)
`TIKTOK_REDIRECT_URI` e `INSTAGRAM_REDIRECT_URI` eran constantes fijas a `https://upmina-web.vercel.app/...`. `upmina-web.vercel.app` sirve el **mismo** despliegue de Production (mismo bundle y misma base de datos), pero:
- el inicio (`POST /api/admin/social-connect`) guarda la cookie de `state` en el host desde el que se inicia (`upminaa-web.com`);
- el proveedor devolvía al usuario a otro host (`upmina-web.vercel.app`), donde la cookie **no se envía** (validación de `state` fallida) y la sesión del navegador (localStorage) tampoco existe (pantalla de inicio de sesión).
Iniciar y volver por el mismo host sí puede completarse; por eso los intentos posteriores pudieron parecer exitosos. Que `social_connections` siga vacía en Production **no queda explicado por el código**: hace falta una conexión real autorizada para comprobarlo (ver «Verificación»).

## Cambio
`src/lib/social-oauth-config.ts`: la `redirect_uri` se construye como `<origen>/api/{tiktok,instagram}-callback`. El origen es `https://upminaa-web.com` salvo que `SOCIAL_OAUTH_BASE_URL` indique otro (https, sin ruta; si es inválido, el inicio falla cerrado). Nunca se deriva del Host ni de parámetros y no hay fallback al dominio anterior. Los flujos solo funcionan con `VERCEL_ENV=production` (Preview/Testing responden 403), así que Testing no usa estas URLs.
La URL de autorización y el intercambio del código usan la misma función (misma `redirect_uri`).

| | Antes | Ahora (Production) |
|---|---|---|
| TikTok | `https://upmina-web.vercel.app/api/tiktok-callback` | `https://upminaa-web.com/api/tiktok-callback` |
| Instagram | `https://upmina-web.vercel.app/api/instagram-callback` | `https://upminaa-web.com/api/instagram-callback` |

## Pantallas de resultado
Los callbacks siguen siendo endpoints del backend que devuelven una página HTML estática (ahora en inglés, con los colores del sitio, botones «Return to settings»/«Try again» y estados success/cancelled/expired/unavailable). Un único script fijo, autorizado por hash en la CSP, quita `code`, `state` y demás parámetros de la URL visible.

## Pasos manuales (NO hacerlos hasta desplegar este código)
Orden: 1) desplegar → 2) registrar la nueva URL **conservando la antigua** → 3) conectar desde `https://upminaa-web.com` → 4) comprobar → 5) opcionalmente retirar la antigua.

**TikTok** (portal de TikTok for Developers, app con Login Kit): añadir `https://upminaa-web.com/api/tiktok-callback` a las Redirect URI de la app. Comprueba en la app si está en *Sandbox* o *Production* y registra la URL en el entorno correcto; no puedo ver el portal. Si la app no está aprobada/publicada para `video.list`, solo funcionarán las cuentas añadidas como testers. Confirma si exige un dominio verificado (URL properties).
**Instagram** (Meta for Developers, producto *Instagram API with Instagram Login*): añadir `https://upminaa-web.com/api/instagram-callback` a la lista de redirect URI de OAuth del *Business Login* de Instagram. Meta puede exigir coincidencia exacta. El código solicita solo `instagram_business_basic` e `instagram_business_manage_comments`; la URL con 5 scopes que generó el panel de Meta **no es la que usa la aplicación** (observación: los otros 3 scopes no se usan y quitarlos de la configuración no afecta). Si la app está en modo desarrollo, la cuenta debe ser tester.
Si algún nombre de menú difiere, busca «redirect URI» / «OAuth redirect» en la sección de Login de cada producto.

## Verificación (con conexión real autorizada)
1. Conectar desde `https://upminaa-web.com/admin` con ADMIN + MFA reciente. La pantalla debe decir «… account connected successfully» y la barra de direcciones quedar sin `?code=&state=`.
2. En Supabase Production (solo lectura): `select provider, scope, updated_at from social_connections;` debe mostrar la fila del proveedor (sin leer los tokens).
3. `GET /api/tiktok-videos` (o `/api/instagram-feed`) debe pasar de 503 a 200.
Si la fila no aparece tras ver el mensaje de éxito, revisar los logs de la función (`tiktok-callback` / `instagram-callback`).

## Desconexión y caché pública
Una respuesta ya almacenada en el CDN de Vercel no ejecuta la función: ni borrar la conexión ni un `no-store` posterior la retiran. Medidas (`src/lib/social-public-cache.ts`):
- Los endpoints públicos de TikTok/Instagram usan `public, s-maxage=60` **sin** `stale-while-revalidate` (snapshot de respaldo: `s-maxage=30`) y la cabecera `Vercel-Cache-Tag: social-<proveedor>`.
- Antes de marcar una respuesta como cacheable se confirma que la conexión sigue vigente; si no, 503 `no-store` (cierra la carrera con una petición en vuelo).
- Al desconectar se BORRA por etiqueta (`POST /v1/edge-cache/dangerously-delete-by-tags`; `invalidate-by-tags` serviría una vez más la copia vieja mientras refresca) si existen `VERCEL_CACHE_PURGE_TOKEN` y `VERCEL_CACHE_PURGE_PROJECT_ID` (+ `VERCEL_CACHE_PURGE_TEAM_ID`). La respuesta de `social-disconnect` incluye `public_cache: "purged" | "not_configured" | "failed"`; si no es `purged`, la exposición máxima es 60 s y el panel lo avisa.
- Navegador: el panel descarta el contenido de ese proveedor en la pestaña actual y en las demás del mismo navegador (BroadcastChannel).
- Copias antiguas (sin etiqueta, creadas antes de este cambio): solo se retiran por su TTL anterior o con un despliegue nuevo / invalidación manual del proyecto.
