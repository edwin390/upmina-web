# 9K-R6 · Protección de sesiones multipart abandonadas (IMPLEMENTADA EN LOCAL · NO APLICADA · NO DESPLEGADA)

## Problema
Una reserva multipart abandonada (pestaña cerrada, conexión perdida) conserva `multipart_upload_id`.
El barrido la marcaba `deleting`, el GC borraba claves y **finalizaba (borraba la fila)**: el
identificador se perdía sin `AbortMultipartUpload` y las partes subidas quedaban en R2 hasta la
caducidad automática de R2 (7 días por defecto según la documentación de Cloudflare; no verificado aquí).

## Invariante
Una fila de `media_assets` con `multipart_upload_id` no nulo **no se puede borrar**. Solo el GC lo pone
a NULL, y solo tras abortar la sesión con **ese identificador exacto**.

## Cambios
| Archivo | Cambio |
|---|---|
| `supabase/migrations/20261027120000_media_multipart_abort_guard.sql` (nuevo) | `community_asset_gc_objects` (misma firma, conserva las claves canónicas de 20261026) devuelve `multipartUploadId` / `multipartKey`; nueva `community_asset_gc_multipart_cleared(asset, claim_token, upload_id)`; `community_asset_gc_finalize` (misma firma) devuelve `multipart_pending` y programa reintento si queda sesión; trigger `BEFORE DELETE` `media_assets_block_delete_open_multipart` (errcode 23001) |
| `src/lib/media-gc.ts` | `processAsset`: valida la sesión, `abortMultipart` (NoSuchUpload = éxito), `multipart_cleared` con el id exacto y SOLO entonces borra objetos y finaliza. Clases de error nuevas: `r2_multipart_abort_failed`, `multipart_clear_failed`, `multipart_pending`. `PhysicalDeleteIo.abortMultipart?` (por defecto `abortPrivateMultipartUpload`; si falta, falla cerrado) |
| `src/lib/cosplay-media-lifecycle.ts` | `attemptMediaAssetCleanup`: si la fila tiene `multipart_upload_id` devuelve `cleaned:false` y delega en el GC |
| tests | `media-gc.test.ts` (+11), `media-abandoned-cleanup.test.ts` (+23, PGlite real), `cosplay-media-lifecycle.test.ts` (+1; mock con `abortPrivateMultipartUpload`), `community-owner-delete-gc.test.ts` (mock con `abortPrivateMultipartUpload`) |

`/api/media/abort` **no cambia**: ya aborta antes de marcar `deleting` y, si el aborto falla, devuelve
503 con la fila intacta.

## Garantías verificadas (SQL real, PGlite)
- El identificador sobrevive a barrido → `deleting` → GC fallido; solo desaparece tras `cleared`.
- `cleared` exige asset `deleting`, token igual, lease vivo e id idéntico (`upload_id_changed` si no coincide; `invalid_claim`; `already_gone`; idempotente con `already_cleared`).
- Aborto OK + `cleared` falla: el reintento vuelve a abortar (NoSuchUpload), limpia y finaliza.
- Aborto falla: ni se limpia el id, ni se borra nada, ni se finaliza (backoff 60 s…6 h del GC existente).
- Un GC antiguo (sin esta lógica) no puede borrar la fila: `finalize` devuelve `multipart_pending`.
- `DELETE` directo con sesión abierta es rechazado; sin sesión sigue funcionando y las variantes se borran en cascada (todo o nada).
- No hay FK `ON DELETE CASCADE` desde otras tablas hacia `media_assets`; `created_by → auth.users` es `SET NULL` (UPDATE).
- Permisos: la RPC nueva solo la ejecuta `service_role`; funciones nuevas con `owner postgres`, `security definer` y `search_path` fijado.

## Efecto conocido en otros flujos
`POST /api/media/reserve` borra la fila en su `catch` si falla la firma tras crear la sesión multipart
(`media-handlers.ts:421`). Antes eso dejaba una sesión huérfana **y** perdía el id; ahora el `DELETE` es
rechazado por la barrera (el error se ignora) y la fila queda `reserved` con su id, de modo que el
barrido (≥ 2 h, 24 h por defecto) y el GC la aborten y limpien. El cliente recibe el 500 de siempre. Sin
cambio de código.

## Limitación residual: PUT en vuelo
- Las URLs de cada parte caducan a los 30 min de la reserva (`PRESIGN_TTL_MULTIPART_PART_SECONDS`); el barrido exige ≥ 2 h. Cuando el barrido o el GC actúan sobre una reserva abandonada ya no puede haber PUT válidos, así que el aborto del GC no compite con una subida activa.
- **Sí queda** el caso de `/api/media/abort` invocado por el usuario mientras una parte aún se sube: el estándar S3 permite que esa parte termine de guardarse tras el aborto. Esta fase no la limpia: el aborto del handler pone `multipart_upload_id = NULL`. Mitigación futura posible (no incluida): que el handler deje el id y lo cierre el GC (segundo aborto). La prueba R6-S3 solo cubrió una sesión con 0 partes; **no está probado** que el aborto elimine partes ya almacenadas.

## Compatibilidad y orden de despliegue
- Backend nuevo + BD antigua: `gc_objects` no trae los campos → sin aborto, `finalize` borra como hoy (sin protección, sin romper nada).
- BD nueva + backend antiguo: ignora los campos; `finalize` devuelve `multipart_pending` → el backend antiguo lo registra como `gc_finalize_failed` y reintenta; nunca borra.
- Orden recomendado: **migración primero** (protección inmediata), luego backend.

## Plan de despliegue DEV (NO ejecutado; requiere autorización por paso)
Entorno: Supabase `rkqeqbqwdswhpzwqptac`, Vercel `upmina-web-testing` (`prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP`).
1. **Previo (SELECT):** `select count(*) from media_assets where multipart_upload_id is not null` (hoy 0); recuentos de assets/posts; los tres `reserved` huérfanos y los 38 candidatos sin cambios; 1 solo job de cron; `media_gc_backlog` a cero.
2. **Migración:** `npx supabase@2.120.0 migration list --linked` y `db push --linked --dry-run` (debe listar SOLO `20261027120000`); luego `db push --linked`.
3. **Verificación (SELECT):** funciones (`owner postgres`, `security definer`, `search_path`, ACL solo `service_role`), trigger presente, 41 migraciones, recuentos idénticos al paso 1.
4. **Backend** (el paquete incluye también el ajuste `requestChecksumCalculation`, aún no desplegado en el alias): `cd C:/Dev/upmina-web-r2-deploy` y `VERCEL_ORG_ID=team_co8xhbacSFWYpnVU7iDOjszT VERCEL_PROJECT_ID=prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP npx vercel@59.19.1 deploy --scope edwin-9cad --yes` (Preview, sin `--prod`). Comprobar READY, exposición de archivos, logs y rutas; luego mover SOLO el alias `upmina-testing-backend.vercel.app`.
5. **Prueba dirigida (abajo).**

**Rollback**
- Backend: `npx vercel@59.19.1 alias set https://upmina-web-testing-qykxblyup-edwin-9cad.vercel.app upmina-testing-backend.vercel.app --scope edwin-9cad` (despliegue `dpl_2rcgbiQtGUfWuBMotKQdXz6mXpUp`: el backend actual del alias, sin la corrección de checksum ni esta fase).
- BD: una migración NUEVA (nunca editar la aplicada) que haga `drop trigger media_assets_block_delete_open_multipart on public.media_assets; drop function public.media_assets_block_delete_open_multipart(); drop function public.community_asset_gc_multipart_cleared(uuid, uuid, text);` y restaure `community_asset_gc_finalize` (20261020) y `community_asset_gc_objects` (20261026) con `create or replace`. Es segura porque ninguna fila conserva ya un `multipart_upload_id` sin gestionar mientras no haya reservas multipart abandonadas.

## Prueba dirigida a UN asset nuevo (no toca los históricos)
Requiere: migración aplicada + backend desplegado. El barrido **no se ejecuta**.
1. **Línea base:** `node scripts/r2-multipart-check-dev.mjs --env-file .env.local` → `NO_OPEN_SESSION`. SELECT: tres huérfanos `reserved`, 0 en `deleting`.
2. **Crear el caso (tú):** MP4 de 60–90 MiB, DevTools throttling «Fast 3G», iniciar la publicación en Community DEV y, cuando el script muestre `OPEN_SESSION` con `parts` ≥ 1, **cerrar la pestaña** (abandono real, sin `abort`).
3. **Identificar (SELECT mío):** el asset nuevo `reserved` con `multipart_upload_id` presente (único creado tras la línea base). No se imprime el id de sesión.
4. **Autorización explícita** para un único UPDATE (marcar `deleting` equivale a borrar):
   `update media_assets set status='deleting' where id='<ASSET>' and status='reserved' and multipart_upload_id is not null;` → debe afectar exactamente 1 fila.
5. **Esperar** el tick natural del cron (≤ 5 min); nada manual.
6. **Comprobar:** `r2-multipart-check-dev.mjs` → `NO_OPEN_SESSION` (partes eliminadas con la sesión); SELECT: asset inexistente; `net._http_response` con `claimed:1, finalized:1, failed:0`; logs de `/api/media/gc` 200; huérfanos, 38 candidatos y recuentos globales sin cambios.
7. **Fallo (sin tocar R2):** cubierto por los tests (aborto fallido → fila e id intactos, reintento con backoff). No se provoca en DEV.
Criterio: PASS si 6 se cumple; FAIL si queda `OPEN_SESSION`, la fila desaparece con id presente (imposible por el trigger) o se procesa otro asset.

## Aplicación en Supabase DEV (2026-10-09, ~20:53Z)
Solo `rkqeqbqwdswhpzwqptac` (enlazado y confirmado), con `npx supabase@2.120.0 db push --linked`. Production sin tocar.

**Comprobaciones previas (SELECT / CLI)**
- Assets con `multipart_upload_id` no nulo: **0**; sin sesiones activas que proteger. `deleting` 0, `media_gc_backlog` a cero, un solo job de cron (`community-media-purge-tick`, */5).
- `migration list --linked`: 40 locales = 40 remotas; solo `20261027120000` pendiente. `db push --dry-run`: «Would push» únicamente `20261027120000_media_multipart_abort_guard.sql`.
- Semántica: la definición viva de `community_asset_gc_finalize` coincide con 20261020 salvo el bloque añadido; `gc_objects` conserva las claves canónicas de 20261026; firmas, `security definer`, `search_path` y ACL (`service_role`) de las funciones existentes sin cambios; reintentos reutilizan `community_asset_gc_fail` (60 s…6 h). Pruebas SQL locales: finalize no borra con sesión pendiente y `multipart_cleared` exige el id exacto y el claim vivo (ver arriba).
- Rollback de `reserve` (punto 6): la barrera rechaza el `DELETE` y el handler lo ignora (`media-handlers.ts:421` no inspecciona el resultado). El fallo **no es silencioso a nivel de resultado** (el cliente recibe el 500 de siempre, visible en los logs de Vercel) y la fila queda `reserved` con su id, detectable con `r2-multipart-check-dev.mjs` y recuperable por barrido (≥ 2 h) + GC. **Lo que sí se descarta es el detalle del error de BD** (no se registra). Mejora opcional (no hecha, requiere revisión): registrar un log genérico en ese `catch`.

**Resultado:** migración aplicada (41 migraciones, última `20261027120000`).

**Verificación posterior (solo lectura)**
| Objeto | Resultado |
|---|---|
| `community_asset_gc_multipart_cleared(uuid, uuid, text)` | existe · `jsonb` · owner `postgres` · `security definer` · `search_path=pg_catalog, public` · ACL `postgres`, `service_role` |
| `community_asset_gc_objects(uuid, uuid)` / `community_asset_gc_finalize(uuid, uuid)` | misma firma y tipo; owner/secdef/search_path/ACL idénticos a antes; solo cambia la definición |
| `media_assets_block_delete_open_multipart()` | trigger function · owner `postgres` · ACL solo `postgres` |
| Trigger `media_assets_block_delete_open_multipart` | `BEFORE DELETE` por fila `WHEN (old.multipart_upload_id IS NOT NULL)`; `media_assets_touch_activity` intacto |
| Funciones no tocadas (`claim`, `fail`, `media_gc_backlog`, `media_abandoned_sweep`, `community_media_asset_discard`) | `md5` de definición idéntico antes/después |

**Datos sin cambios (antes → después):** 153 assets (community: failed 4, ready 52, reserved 4; cosplay: failed 5, ready 87, reserved 1), 11 posts, 25 enlaces, 308 variantes, 0 `deleting`, 0 con `multipart_upload_id`, 0 filas con `purge_*`; huella `md5` de (id, estado, updated_at) de todos los assets **idéntica** (`bddc979f…`); los tres huérfanos siguen `reserved`; cron único sin cambios. No se ejecutó UPDATE/DELETE de assets, abort, GC, cron manual ni barrido; sin cambios en R2, Preview, alias, commit ni push.

## Despliegue del backend en Vercel DEV (2026-10-09, ~20:58Z)
Solo proyecto `upmina-web-testing` (`prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP`, scope `edwin-9cad`), Preview sin `--prod`, desde el paquete aislado `C:\Dev\upmina-web-r2-deploy` (nunca el árbol principal).

| | Identificador | URL |
|---|---|---|
| **Nuevo (alias actual)** | `dpl_6AGTMU5asb2GdQcrhVsfERp3Yv1e` | `https://upmina-web-testing-pccytl1nz-edwin-9cad.vercel.app` |
| **Anterior (rollback)** | `dpl_2rcgbiQtGUfWuBMotKQdXz6mXpUp` | `https://upmina-web-testing-qykxblyup-edwin-9cad.vercel.app` |
| Preview huérfano anterior (sin alias, con ajuste de checksum; no usado) | `upmina-web-testing-24b70pvvl` | — |

**Decisión sobre el ajuste de checksum:** se EXCLUYE del despliegue. `r2-client.ts` y su test del paquete son idénticos al commit `6a2e441` (verificado), sin `requestChecksumCalculation`; el cambio sigue solo en el árbol principal. La exclusión se hizo quitando esos dos archivos de la lista del script de empaquetado (herramienta local), sin modificar el repositorio. PUT simple y multipart ya funcionan con ese comportamiento en el alias anterior.

**Comprobaciones previas**
- Alias antes: `dpl_2rcgbiQ…`, proyecto `upmina-web-testing`, Ready, preview.
- Variables del proyecto DEV (solo nombres/entornos): 15, todas `Preview`, con `R2_DEV_*` y sin `R2_PROD_*`. (Aviso: un primer `env ls` ejecutado desde la raíz del repo consultó por error los metadatos del proyecto `upmina-web` de Production —solo nombres y entornos, sin valores— y se repitió desde el paquete; no se leyó ni modificó nada de Production.)
- Paquete frente al despliegue activo (527 archivos idénticos): cambian solo `media-gc.ts`, `cosplay-media-lifecycle.ts`, sus tests (`media-gc`, `cosplay-media-lifecycle`, `community-owner-delete-gc`, `media-abandoned-cleanup`, `media-handlers.test`) y se añade la migración 20261027. `r2-client.ts` y `media-handlers.ts` sin cambios.
- En el paquete: 235 tests (r2-client, media-gc, media-handlers, cosplay-media-lifecycle, owner-delete, abandoned-cleanup, gc-handler, gc-db-contract) OK; `tsc -b` OK; `npm run build` OK; Prettier OK.
- Cron: un solo job; ni su comando ni ninguna función pública distinta de `media_abandoned_sweep` la invoca. El despliegue no programa ni ejecuta el barrido.

**Verificación del Preview:** los hashes de `media-gc.ts`, `cosplay-media-lifecycle.ts`, `r2-client.ts`, `media-handlers.ts` y de la migración coinciden con el paquete (535 archivos). Exposición: 10 rutas internas (`.env`, `.claude/`, `supabase/migrations/…`, `docs/…`, `CLAUDE.md`, `package.json`, `src/lib/media-gc.ts`, `.git/config`, `.vercel/project.json`…) devuelven el HTML de fallback del SPA (mismo hash que una ruta inexistente): sin exposición. Rutas: `/` 200 (una primera petición tras crear el despliegue/alias devolvió 308 transitorio y las siguientes 200), `community-feed` 200, `abort|reserve|complete|gc|access|community-post-delete|community-post-save` 405 a GET, `twitch-status` 503 (credenciales de Twitch ausentes, preexistente). Logs del Preview: solo el 503 de Twitch y el aviso DEP0169 de Node; sin errores nuevos.

**Alias:** `alias set https://upmina-web-testing-pccytl1nz-edwin-9cad.vercel.app upmina-testing-backend.vercel.app --scope edwin-9cad` → `upmina-testing-backend.vercel.app` = `dpl_6AGTMU5asb2GdQcrhVsfERp3Yv1e` (Ready). Mismas rutas por el alias con el mismo resultado.

**Estado de Supabase tras el despliegue (SELECT):** `media_gc_backlog` a cero; 153 assets, 0 `deleting`, 0 con `multipart_upload_id`, 0 con `purge_*`; huella `md5` de todos los assets idéntica a la anterior (`bddc979f…`); los tres huérfanos `reserved`; 41 migraciones; cron: ticks 20:50 y 20:55 `succeeded`, sin respuestas de pg_net ni llamadas a `/api/media/gc`. No se ejecutó barrido ni limpieza.

**Rollback del backend (un comando):**
```bash
npx vercel@59.19.1 alias set https://upmina-web-testing-qykxblyup-edwin-9cad.vercel.app upmina-testing-backend.vercel.app --scope edwin-9cad
```
Es compatible con la BD ya migrada: el backend anterior ignora los campos nuevos y su `finalize` recibe `multipart_pending` (reintento, nunca borra).

## Prueba dirigida R6-S4 · recuperación de un multipart abandonado (2026-10-09)
Asset `632c57f4-700b-4bdf-9d7e-567de170e0f7` (community, video, 92 174 109 B, creado 21:49:43Z, pestaña cerrada a mitad de subida, 0 partes). Solo Supabase DEV; backend `dpl_6AGTMU5asb2GdQcrhVsfERp3Yv1e`.

**Identidad de la sesión.** `ListMultipartUploads` de R2 devuelve un texto de `UploadId` distinto en cada consulta y distinto del guardado en Supabase (mismo `initiated`, misma clave, una sola reserva en los logs); la documentación de Cloudflare no trata el formato ni la estabilidad del identificador. El script de diagnóstico (ahora con huella SHA-256 de 12 hex + longitud y `--expected-upload-id-env`) comprobó con `ListParts` que el identificador de Supabase (huella `752d974c8b40`, longitud 343) direcciona una sesión viva de la clave (`EXPECTED_ID result=VALID_SESSION`). Los identificadores completos nunca se imprimieron.

**Comprobaciones previas (SELECT, 22:20:54Z):** `reserved`, misma `private_original_key`, mismo `multipart_upload_id` (huella `752d974c8b40`), `purge_attempts` 0 sin claim; 154 assets, 0 `deleting`, 1 con multipart; cron único activo (ticks 22:10/22:15/22:20 `succeeded`); alias = `dpl_6AGTMU5…` Ready; huérfanos `reserved`; huella del resto de assets `bddc979f…`.

**Escritura (22:21:14Z), un único UPDATE** condicionado a `id`, `status='reserved'`, `multipart_upload_id` no nulo con huella `752d974c8b40` y `private_original_key` exacta: `status → deleting`. **Filas afectadas: 1**; `multipart_upload_id` y `private_original_key` conservados.

**Resultado del tick natural (22:25:00Z, sin ninguna invocación manual):**
| Fuente | Evidencia |
|---|---|
| `cron.job_run_details` | 22:25:00.087 `succeeded` |
| `net._http_response` | 22:25:00.150 → 200 `claimed:1, finalized:1, alreadyGone:0, failed:0, stale:0, blocked:0, failRecordFailed:0, malformed:0, errorClasses:{}` |
| Log Vercel | `POST /api/media/gc` → 200 a las 22:25:00.455 (solo el aviso DEP0169 de Node) |
| BD | asset `632c57f4-…` eliminado (0 filas); `media_gc_backlog` a cero; 153 assets, 0 `deleting`, 0 con `multipart_upload_id` |
| Sin efectos laterales | huella del resto de assets idéntica (`bddc979f…`); los tres huérfanos siguen `reserved`; ningún barrido |

**Qué demuestra y qué no.** La fila solo puede finalizar si la RPC `community_asset_gc_multipart_cleared` confirmó el identificador exacto y esa RPC solo se llama tras un `AbortMultipartUpload` correcto (o `NoSuchUpload`, tratado como éxito). Por tanto el flujo completó aborto → limpieza → borrado de objetos → finalización por el mecanismo automático. **No distingue** entre «el GC abortó la sesión» y «la sesión ya no existía»; la comprobación física (`NO_OPEN_SESSION` con `r2-multipart-check-dev.mjs`) la realiza el propietario. Sigue sin probarse el aborto de una sesión con partes ya almacenadas (esta tenía 0).

## Prueba dirigida R6-S5 · abandono multipart CON partes almacenadas (2026-10-09)
Asset `eb86ad95-0d28-4f7a-affd-adf4de314a96` (community, video, 92 174 109 B, creado 22:33:25Z). La subida se abandonó cerrando la pestaña con **2 partes confirmadas en R2** (`OPEN_SESSION`, `parts=2`, `bytes=16 777 216`, `initiated=22:33:25.257Z`, última lectura 22:34:24Z, hecha por el propietario).

**Comprobaciones previas (SELECT, 22:35:26Z):** `reserved`, `community/video`, `private_original_key` exactamente `staging/community/eb86ad95-…/original.mp4`, `multipart_upload_id` presente (longitud 343, huella SHA-256 truncada `9b0c8049c4be`), sin enlaces a posts (0) ni a cosplay (0), `purge_attempts` 0 sin claim; 154 assets, 0 `deleting`, 1 con multipart; cron único activo (ticks 22:25/22:30/22:35 `succeeded`); alias `dpl_6AGTMU5…` Ready (`/api/media/gc` 405 a GET); huérfanos `reserved`; huella del resto de assets `bddc979f…`.

**Escritura (22:35:39Z), un único UPDATE** condicionado a `id`, `status='reserved'`, `multipart_upload_id` no nulo con huella `9b0c8049c4be` y la clave exacta: `status → deleting`. **Filas afectadas: 1**; identificador y clave conservados.

**Tick natural 22:40:00Z (sin invocación manual):**
| Fuente | Evidencia |
|---|---|
| `cron.job_run_details` | 22:40:00.079 `succeeded` |
| `net._http_response` | 22:40:00.150 → 200 `claimed:1, finalized:1, alreadyGone:0, failed:0, stale:0, blocked:0, failRecordFailed:0, malformed:0, errorClasses:{}` |
| Log Vercel | `POST /api/media/gc` → 200 (22:40:00.412) |
| BD | asset eliminado (0 filas); `media_gc_backlog` a cero; 153 assets, 0 `deleting`, 0 con `multipart_upload_id` |
| Sin efectos laterales | huella del resto de assets idéntica (`bddc979f…`); tres huérfanos `reserved`; ningún barrido |

**Alcance de la evidencia:** la fila solo se finaliza si `community_asset_gc_multipart_cleared` confirmó el identificador exacto tras un `AbortMultipartUpload` correcto o `NoSuchUpload`. Esto demuestra el flujo automático completo para una reserva con 2 partes; que las partes hayan desaparecido de R2 (y que no fuera `NoSuchUpload`) lo debe confirmar la lectura física del propietario: `r2-multipart-check-dev.mjs --asset eb86ad95-…` debe dar `NO_OPEN_SESSION`.
