# Estado del proyecto UPMINA Web

Fecha de cierre del desarrollo activo: 2026-10-18 (pausa indefinida; el proyecto se conserva, no se abandona).
Rama de trabajo: `legal/phase1`. Los hashes finales están en `docs/PROJECT_CLOSURE.md`.

> El código archivado puede ser **más reciente** que el desplegado. No asumir que Production tiene lo que tiene DEV.

## 1. Funcionalidades terminadas (código + pruebas)

Twitch, YouTube, Community (publicar, editar, feed, perfiles, reportes), moderación humana, copyright/strikes, cuentas y
eliminación de cuentas, páginas legales (borrador pendiente de revisión legal), panel Admin/Developer con MFA (AAL2), almacenamiento
de medios en R2 con Worker de entrega, borrado físico en R2, moderación shadow con proveedor fake y proveedor OpenAI protegido
(sin activar).

## 2. Funcionalidades restringidas (modo restringido, ver `MINA_RESTRICTED_MODE.md`)

Instagram, TikTok y Cosplays: desactivadas en interfaz y en API (503 `feature_unavailable`) salvo `MINA_FEATURES_ENABLED`.
Medios de Cosplay: el Worker responde 404 `no-store` salvo `COSPLAY_PUBLIC=true`. Captura de trabajos shadow: apagada en DEV
(`community_shadow_capture_control.enabled=false`). IA: `CONTENT_SHADOW_RUN_ENABLED=false` en Preview; `CONTENT_SHADOW_PROVIDER` y
`OPENAI_API_KEY` ausentes. No se eliminaron assets ni publicaciones.

## 3. Pendiente

- Comprobaciones autenticadas **NO verificadas** (solo hay evidencia de 403 con una sesión sin privilegios, que no las sustituye):
  A) borrado de Cosplay por propietario autorizado; B) desconexión de cuentas sociales por usuario autorizado; C) bloqueo de
  `content-shadow-run` con sesión developer y MFA reciente.
- Llevar el modo restringido, la captura shadow y el Worker a Production (no hecho).
- Revisión legal de los textos legales; autorización de Mina para Instagram/TikTok/Cosplays.
- Ver también `ROADMAP.md`.

## 4. Diferencias DEV / Production

| Aspecto                   | DEV                                                   | Production                                  |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| Supabase                  | `rkqeqbqwdswhpzwqptac`                                | `dmtuvzfdaectvqczwfhx`                      |
| Vercel                    | `edwin-9cad/upmina-web-testing` (`prj_fz4fs3FB…`)     | proyecto `upmina-web` enlazado a GitHub     |
| Sitio                     | `https://upmina-web-testing.vercel.app`               | `https://upminaa-web.com`                   |
| Worker de medios          | `upmina-media-delivery-dev`, versión `f4b97e61-8674-44ee-95e2-0585cfbeb0fd` | `upmina-media-delivery-prod` (desplegado 2026-10-14, sin los últimos cambios) |
| Modo restringido          | Aplicado                                              | **No** aplicado                             |
| Captura shadow (mig. 20261126…) | Aplicada, apagada                               | **No** aplicada (ni las migraciones shadow) |
| Cosplay en el Worker      | 404 `no-store`                                        | Sin cambios: sigue sirviendo públicamente   |

El estado remoto de Production no se ha reverificado en este cierre; no afirmar que está validado.

## 5. Riesgos conocidos

- Desplegar este código en Production desactiva Instagram/TikTok/Cosplays por defecto (deseado, pero confirmar antes).
- Redesplegar el Worker de Production con esta fuente restringe Cosplay por defecto.
- Copias `immutable` de medios Cosplay pueden seguir en cachés de navegadores.
- Un push a GitHub puede provocar despliegues (ver `DEPLOYMENT_AND_RECOVERY.md`).
- La migración del interruptor shadow solo se probó en PGlite y en DEV.

## 6. Pruebas

Completadas: suite Worker (81), pruebas enfocadas del modo restringido, E2E fake de moderación shadow en DEV, validación manual de
endpoints 503 en DEV. No ejecutadas en el cierre: suite completa y E2E Playwright. Pendientes: A, B y C de la sección 3.

## 7. Últimos despliegues conocidos

DEV: Worker `f4b97e61-…` (2026-10-18); Preview Vercel `dpl_4yQucETiFBDGisvprfrMnBCJgaeM` con modo restringido. Production: Worker
`upmina-media-delivery-prod` de 2026-10-14; el sitio no se tocó en este cierre.

## 8. Qué se necesita para retomar

Acceso a GitHub (`edwin390/upmina-web`), Vercel (equipo `edwin-9cad`), Supabase (ambos proyectos), Cloudflare (cuenta con los Workers y
buckets R2), Node 24.x. Los secretos **no** están en Git: ver `DEPLOYMENT_AND_RECOVERY.md`, sección 1.
