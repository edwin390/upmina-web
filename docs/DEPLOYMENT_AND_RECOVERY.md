# Despliegue y recuperación (solo documentación; nada de esto se ejecutó en el cierre)

## 1. Preparar el entorno local

- Node `24.x` (campo `engines`), npm. `git clone https://github.com/edwin390/upmina-web.git`, `npm ci`.
- Copiar `.env.example` a `.env.local` y rellenar los valores desde los paneles de cada servicio. **Nunca** se versionan ni se piden
  por chat. Nombres de variables (sin valores): `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL`, `YOUTUBE_API_KEY`,
  `YOUTUBE_CHANNEL_ID`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_ACCESS_TOKEN`, `TIKTOK_CLIENT_KEY`,
  `TIKTOK_CLIENT_SECRET`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_APP_URL`,
  `VITE_DEMO_MODE`; y, usadas por el código: `MINA_FEATURES_ENABLED`, `CONTENT_SHADOW_RUN_ENABLED`, `CONTENT_SHADOW_PROVIDER`,
  `CONTENT_SHADOW_BUDGET_MODE`, `MEDIA_CHECK_SHARED_SECRET`, `MEDIA_GC_SHARED_SECRET`, `ACCOUNT_DELETION_SHARED_SECRET`,
  `RESEND_WEBHOOK_SECRET`, `OPENAI_API_KEY` (solo si se reactiva la IA).
- **No respaldado por GitHub** (requiere respaldo privado propio): `.env.local` y copias `.env.local.*.bak`, `.vercel/` (enlace a
  proyectos), `supabase/.temp/`, sesiones del navegador, secretos de Vercel/Cloudflare/Supabase, datos y objetos de R2/Supabase,
  claves de Production generadas con `scripts/generate-production-secrets.mjs`.

## 2. Comandos

- `npm run dev`: solo Vite; `/api` **no** se sirve. `npm run dev:local`: Vercel Functions + Vite (necesita `vercel dev` y entorno).
- `npm run build` (`tsc -b && vite build`), `npm run lint` (warnings fallan), `npm test`, `npm run test:e2e`.
- No ejecutar `npm run admin:bootstrap-invitation` salvo petición explícita (genera una invitación ADMIN real).
- Worker: `workers/media-delivery` (tests: `npx vitest run workers/media-delivery`).

## 3. Recuperar desde GitHub y localizar el último commit archivado

`git fetch --all --prune`, `git branch -r`, y mirar `docs/PROJECT_CLOSURE.md` (rama y hash archivados). Verificar con
`git rev-parse <rama>` contra el hash anotado. Si el cierre no pudo publicarse, el contenido solo existe en el equipo local original.

## 4. Revisar migraciones antes de aplicarlas

`supabase/migrations/` (73 archivos; última `20261126120000_community_shadow_capture_switch.sql`, **solo DEV**). Nunca editar una
migración ya aplicada. Comparar `supabase_migrations.schema_migrations` del entorno con la carpeta, leer cada migración pendiente y
ensayar con `scripts/rehearse-pending-migrations.mjs` / PGlite antes de tocar Production.

## 5. Reactivar servicios

Modo restringido: `MINA_FEATURES_ENABLED` (lista `instagram,tiktok,cosplay`) y, para medios de Cosplay, `COSPLAY_PUBLIC=true` en el
Worker. IA: ver `OPENAI_SHADOW_REACTIVATION.md`. Captura shadow: `update community_shadow_capture_control set enabled = true`.
Detalle en `MINA_RESTRICTED_MODE.md`. Los cambios de variables de Vercel exigen un despliegue nuevo.

## 6. Desplegar (referencia)

- Vercel: DEV mediante despliegue Preview del proyecto `upmina-web-testing`; Production a través del proyecto `upmina-web`. Alias estable
  DEV: `https://upmina-web-testing.vercel.app`.
- Worker DEV: desde `workers/media-delivery`, `npx wrangler@4.151.1 deploy --config wrangler.jsonc --keep-vars`.
- Worker Production: solo con `wrangler.prod.jsonc` y autorización explícita; recordar que restringe Cosplay si `COSPLAY_PUBLIC` no es
  `true`.
- Límite Hobby de Vercel: 12 funciones; usar los dispatchers existentes (`api/admin/[action].ts`, etc.).

## 7. Rollback

Vercel: promover un despliegue anterior (`request_rollback`/panel). Worker: `wrangler rollback` a una versión previa (la de Production
anterior es la desplegada el 2026-10-14). Código: `git revert` (nunca force-push). Base de datos: migración nueva compensatoria; hay
`docs/9K-R5J-rollback.sql` como ejemplo.

## 8. Riesgo del despliegue automático desde GitHub

El proyecto Vercel `upmina-web` está enlazado a `edwin390/upmina-web`. En este cierre **no se pudo leer su configuración Git**
(la API devolvió 403), así que no se demostró qué ramas despliegan ni si se crean Preview para ramas distintas de `main`. Vercel suele
crear Preview por cada rama y desplegar `main` a Production. No hay GitHub Actions (`.github/` solo contiene un agente). Por eso el
respaldo en GitHub **no se publicó**. Para publicarlo con seguridad: (a) confirmar en Vercel → Settings → Git que "Ignored Build Step"
o "Production Branch"/preview están acotados, o desactivar temporalmente Previews para `archive/*`; o (b) subir el respaldo a un
repositorio privado distinto sin Vercel. Las dos opciones las decide el propietario.
