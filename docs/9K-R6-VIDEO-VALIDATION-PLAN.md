# 9K-R6 · Validación de vídeos en R2 DEV (PLAN, NO EJECUTADO)

Solo DEV (`rkqeqbqwdswhpzwqptac`, buckets `upmina-media-dev-*`, alias `upmina-testing-backend.vercel.app`).
Los tres assets `reserved` huérfanos y los 38 candidatos históricos NO forman parte de esta fase.

## 1. Arquitectura real (con referencias)
| Tema | Hallazgo | Fuente |
|---|---|---|
| Formatos | `video/mp4`, `video/quicktime` (.mov), `video/webm` | `media-domain.ts:34`; picker `CommunityPostEditorForm.tsx:34` |
| Tamaño | máx. **100 MiB** (cliente y servidor); **1 vídeo por publicación**, 10 medios en total | `media-domain.ts:91`, `CommunityPostEditorForm.tsx:30-37` |
| PUT vs multipart | `< 16 MiB` → PUT simple; `>= 16 MiB` → multipart, partes de 8 MiB (`ceil(bytes/8 MiB)` partes) | `media-domain.ts:100-109`, `media-handlers.ts:382-407` |
| Subida | directa navegador→R2 con URL prefirmada (XHR PUT, solo `Content-Type`); las partes se suben **en serie** y se lee el `ETag` de cada una | `media-client.ts:196-220`, `useMediaUpload.ts:316-336` |
| reserve | crea fila `reserved` (`pipeline_version video-v1`), clave **registrada** `private_original_key = staging/community/<id>/original.<ext>`; si multipart, guarda `multipart_upload_id` | `media-handlers.ts:376-410` |
| complete | multipart: `CompleteMultipartUpload` con las partes; luego HEAD y comparación de tamaño; copia `staging→objects/…/original.<ext>`; **copia servidor-a-servidor** `objects→community/<id>/original.<ext>` (bucket público); `ready` con `storage_key` = clave pública y `private_original_key = NULL`; borra el original privado | `media-handlers.ts:607-720`, `r2-client.ts:326` |
| Thumbnails / pósteres / transcodificación | **No existen**: sin FFmpeg ni variantes; 0 filas en `media_asset_variants` para un vídeo | `media-handlers.ts:666` (comentario), `media-domain.ts:168-179` |
| abort | `deleting` → reintenta limpieza; `ready` → RPC de descarte; reserved/uploaded/failed → **primero `AbortMultipartUpload`** (si falla, 503 y la fila no se toca), luego `deleting` y limpieza inline | `media-handlers.ts:867-960` |
| Borrado de publicación | `community_post_delete` → assets `deleting` → limpieza inline; claves que intenta borrar: `storage_key` registrada + candidatas canónicas `community/<id>/w480|960|1600|2560.webp` y `original.mp4|mov|webm` + `private_original_key` si existe; GC las repite cada 5 min si falla | `cosplay-media-lifecycle.ts:47-68`, `media-gc.ts:74-110` |
| Límites | Los bytes del vídeo nunca pasan por Vercel (PUT y COPY van a R2). No hay `maxDuration` propio en `vercel.json`; `CopyObject` de R2 admite hasta 5 GiB (muy por encima de 100 MiB). Duración solo informativa; ancho/alto obligatorios (los lee un `<video>` en el navegador, un códec no soportado falla antes de reservar) | `vercel.json`, `media-handlers.ts:601`, `useMediaUpload.ts:243-249` |

### Claves físicas de un vídeo `ready`
- **Registrada en BD:** `storage_key = community/<assetId>/original.<mp4|mov|webm>` (bucket público). `private_original_key` NULL.
- **Inferidas (esperan 404):** `staging/community/<id>/original.<ext>`, `objects/community/<id>/original.<ext>`, las otras dos extensiones y `w480|960|1600|2560.webp`.
- Durante la subida (antes de `complete`): la registrada es `staging/…/original.<ext>`.

## 2. Riesgos (por gravedad)
1. **ALTA · Multipart abandonado no se aborta en el GC ni en el barrido.** `abortPrivateMultipartUpload` solo se llama desde `/api/media/abort`; `media-gc.ts`, `cosplay-media-lifecycle.ts` y la migración 20261026 no contienen lógica de multipart. Si el usuario cierra la pestaña a mitad, la sesión queda abierta y la partes ocupan almacenamiento (R2 las aborta por su regla por defecto tras 7 días, no por esta aplicación). Además, al borrarse la fila se pierde el `uploadId`. Un HEAD 404 no detecta esto.
2. **ALTA para S2 · CORS puede no exponer `ETag`.** Sin `ExposeHeaders: ETag` el navegador no lee la cabecera y la subida falla con «R2 no devolvió ETag» (`useMediaUpload.ts:332`). No sé si la política actual lo incluye (la editaste a mano).
3. **MEDIA · Checksum en `UploadPart`.** Las imágenes suben bien con el alias actual (sin el ajuste), así que R2 tolera el `x-amz-checksum-crc32` de la URL en PUT simple; para `UploadPart` no está probado. El ajuste `WHEN_REQUIRED` sigue sin desplegar.
4. **MEDIA · Una subida fallida (item en error) no aborta nada automáticamente.** Solo `remove()`/cancelar llama a abort (`useMediaUpload.ts:451-466`). Un fallo + recarga deja la reserva (y la sesión multipart) huérfanas.
5. **BAJA · Reproducción con Range/seek** depende del origen público de DEV; no está probada.
6. **BAJA · Tiempo de subida:** las partes van en serie; un archivo de 100 MiB son 13 partes.

## 3. Plan de pruebas
Convención: cada manifiesto lleva claves REGISTRADAS (de un SELECT) e INFERIDAS marcadas, y se ejecuta con
`node scripts/r2-head-dev.mjs --env-file .env.local --keys-file evidence\<archivo>.csv` (lo ejecutas tú).

SELECT común (post de prueba `<POST>`):
```sql
select pm.post_id, a.id, a.kind, a.status, a.storage_key, a.private_original_key, a.source_bytes,
       a.multipart_upload_id is not null as has_multipart, a.updated_at
from community_post_media pm join media_assets a on a.id = pm.asset_id where pm.post_id = '<POST>';
```

### R6-S1 · Vídeo pequeño
- **Archivo:** MP4 H.264/AAC, ~5–8 MiB, 5–15 s (< 16 MiB para forzar PUT simple).
- **Manual:** publicar en Community DEV con el texto «PRUEBA R6-S1 <fecha>»; reproducir (play y seek); avisarme.
- **Yo (SELECT):** post/asset; `status ready`, `has_multipart false`, `storage_key` pública, `private_original_key` NULL.
- **HEAD antes:** `public, community/<id>/original.mp4` → EXISTS 200 (registrada). Inferidas → NOT_FOUND: `staging/…`, `objects/…` (private), `original.mov|webm`, `w480…w2560.webp`.
- **Borrado:** tú, desde la interfaz del autor. **HEAD después:** las ocho claves → NOT_FOUND.
- **Supabase:** 0 filas de post, asset, enlaces; 0 assets en `deleting`.
- **Modifica datos/coste:** 1 asset, ~8 MiB en R2 durante minutos.
- **Recuperación:** si queda en `deleting`, esperar el tick del cron (≤5 min); no tocar otros assets.

### R6-S2 · Vídeo grande / multipart
- **Archivo:** MP4 de ~20–24 MiB (3 partes: 8+8+resto). Mínimo 16 MiB; 100 MiB es el techo.
- **Previo:** confirmar CORS `ExposeHeaders: ["ETag"]` (riesgo 2). Decidir si se prueba con el alias actual o tras desplegar el ajuste de checksum (riesgo 3).
- **Manual:** publicar «PRUEBA R6-S2», reproducir, avisarme.
- **SELECT:** `has_multipart false` tras `ready` (se limpia en `complete`), `source_bytes` ≈ tamaño, `storage_key` pública.
- **HEAD antes:** igual que S1; el HEAD de la pública debe mostrar el tamaño total (el script no lo imprime hoy: comparar con el SELECT).
- **Multipart:** (a) BD: `multipart_upload_id IS NULL`; (b) HEAD solo no prueba que no haya sesiones abiertas: propongo un script de solo lectura `ListParts` por `uploadId` (NoSuchUpload = sesión cerrada), a preparar con tu autorización.
- **Borrado y HEAD después:** como S1.

### R6-S3 · Subida interrumpida
- **Archivo:** MP4 de ~60–90 MiB (≥8 partes, tiempo para cancelar).
- **Manual:** empezar a subir, y con la barra al ~30–50 % quitar el elemento del editor (esto llama a `/api/media/abort`). No cerrar la pestaña.
- **Antes de cancelar (SELECT):** asset `reserved`, `has_multipart true` (anotar el id; el `uploadId` no se copia a ningún documento).
- **Después:** fila inexistente o `deleting`→desaparece; HEAD de `staging/community/<id>/original.<ext>` → NOT_FOUND (esto no demuestra que la sesión esté cerrada); la verificación de sesión requiere el script ListParts **antes** de que la fila desaparezca (después ya no hay `uploadId`) o el abort devuelve éxito y la fila se elimina.
- **Distinción:** cancelación correcta = `/api/media/abort` 200 y fila final ausente. Abandono = cerrar pestaña/recargar: la fila queda `reserved` con multipart abierto y SOLO la recogería el barrido a las 24 h, sin abortar la sesión (riesgo 1). **No ejecutar la variante abandono** salvo que quieras medir ese riesgo; generaría un nuevo huérfano.
- **Recuperación:** si falla el abort (503), la fila queda intacta; reintentar con el mismo flujo.

### R6-S4 · Consistencia final
Con SELECT: posts/assets/enlaces de R6-S1..S3 inexistentes; ningún `deleting`; recuento de `media_assets` = línea base + los 3 huérfanos (+ lo que no hayas eliminado). HEAD final de todos los manifiestos → NOT_FOUND. Documentar PASS/FAIL/BLOCKED por escenario en `docs/9K-R5-S1-DELETION-TEST-EVIDENCE.md` o un `9K-R6-EVIDENCE.md`.

## 4. Primer paso manual
Abre Cloudflare → R2 → `upmina-media-dev-private` → Settings → CORS y verifica que alguna regla con tu origen tenga `ExposeHeaders` con `ETag`, `AllowedMethods` con `PUT` y `AllowedHeaders` con `content-type`. Después sube el vídeo de S1.

## 5. Bloqueos
- S2/S3 dependen de `ETag` expuesto (riesgo 2).
- La verificación de sesiones multipart abiertas no existe aún (requiere el script `ListParts`).
- Decisión: probar S2 con el alias actual (sin el ajuste de checksum) o desplegar antes el Preview ya preparado.

## Evidencia R6-S1 (inicial, SELECT 2026-10-09; borrado NO ejecutado, sin veredicto)
| Dato | Valor |
|---|---|
| Post | `6a27b913-7542-4661-9690-625516b33abd` · `published` · texto «prueba r2 video s1» · creado 19:53:40Z · 1 medio |
| Asset | `e9aeba36-f5ce-4211-a968-ec330c71c79e` · `video` · `ready` · creado 19:53:15Z, `ready` 19:53:18Z |
| MIME / tamaño | `video/mp4` · 1 003 703 B (~0,96 MiB) · 576×1024 · 10,17 s → **PUT simple** (< 16 MiB) |
| `storage_key` (registrada) | `community/e9aeba36-f5ce-4211-a968-ec330c71c79e/original.mp4` |
| `private_original_key` / `multipart_upload_id` | NULL / ninguno |
| Variantes | 0 (esperado en vídeo) |

Existe otra publicación reciente sin texto (`ff67d382-…`, vídeo `dbd82160-…`, 19:51Z); no coincide con el texto de la prueba y no se toca.

Manifiesto: `evidence/r2-video-s1-before.csv` (9 claves). Esperado antes del borrado:
- **EXISTS 200:** `upmina-media-dev-public` · `community/e9aeba36-f5ce-4211-a968-ec330c71c79e/original.mp4` (única clave registrada).
- **NOT_FOUND 404 (inferidas):** `staging/…/original.mp4` y `objects/…/original.mp4` (privado), `original.mov|webm` y `w480|960|1600|2560.webp` (público).
Si el `.mp4` no da 200, o un privado da 200, la línea base no es válida (BLOCKED) y se anota.
Pendiente: HEAD previo (propietario), reproducción, borrado, HEAD posterior y SELECT final.

### R6-S1 · Resultados y veredicto (2026-10-09)
**HEAD previo** 19:55:24.927Z (propietario): `community/e9aeba36-f5ce-4211-a968-ec330c71c79e/original.mp4` EXISTS 200; las otras 8 claves NOT_FOUND 404. Subida y reproducción correctas.
**Borrado** desde la interfaz normal del autor. **HEAD posterior** 19:56:46.802Z: las 9 claves NOT_FOUND 404.

**Supabase (SELECT tras el borrado):** post 0 filas · asset 0 · variantes 0 · enlaces por asset 0 y por post 0 · auditoría con el post/asset 0 · assets en `deleting` 0.

| Hora (UTC) | Hecho | Fuente |
|---|---|---|
| 19:53:15.0 / 19:53:17.4 | `reserve` / `complete` → 200 (asset `ready` 19:53:18.6) | log Vercel + BD |
| 19:53:40.1 | `community-post-save` → 200 | log Vercel |
| 19:55:00 | último tick de cron antes del borrado (succeeded) | `cron.job_run_details` |
| 19:55:24.9 | HEAD previo | propietario |
| **19:56:42.564** | `POST /api/admin/community-post-delete` → 200 | log Vercel |
| 19:56:46.8 | HEAD posterior: todo 404 (~4,2 s tras la llamada) | propietario |
| 20:00:00 | siguiente tick previsto (posterior a todo lo anterior) | calendario del job |

**Comprobado:** el objeto existía a las 19:55:24 y no existe a las 19:56:46; la llamada de borrado fue a las 19:56:42; no hubo tick de cron entre ambos ni llamadas a `/api/media/gc` ni respuestas en `net._http_response`; no queda ninguna fila relacionada.
**No comprobado:** qué componente borró físicamente el objeto (no hay registro de `DeleteObjects` ni se vio `allCleaned`). Lo compatible con los datos es la limpieza inmediata del endpoint, pero es inferencia.

**Veredicto S1:** **PASS** eliminación física (9/9 claves, línea base válida) · **PASS** consistencia de BD (0 residuos). Borrado completado ~4 s tras la llamada, sin intervención de GC/cron observada.

## Preparación de S2 (multipart) — instrucciones
**Requisito previo:** en Cloudflare, la regla CORS del bucket `upmina-media-dev-private` debe incluir `ExposeHeaders: ["ETag"]` (sin ello la subida falla con «R2 no devolvió ETag para una parte»).
**Archivo:** MP4 de **20–24 MiB** (≈3 partes: 8 + 8 + resto; mínimo para multipart 16 MiB, techo 100 MiB), con códec que reproduzca el navegador (H.264/AAC).
**Pasos (tú):**
1. Abre DevTools → Network (conserva el registro, filtra por «r2.cloudflarestorage»).
2. Community DEV (`https://upmina-testing-backend.vercel.app`): nueva publicación, texto «PRUEBA R6 S2 MULTIPART», adjunta el MP4, espera a que termine y publica.
3. Comprueba que se reproduce (play y seek).
4. Pásame el texto de la publicación y la hora aproximada. No elimines todavía.
**Qué observar en Network:** 1 `reserve` (200) con respuesta `mode: multipart`; 3 PUT a R2 (OPTIONS 200 + PUT 200 con cabecera `ETag` visible); 1 `complete` (200, `status: ready`).
**Yo, después (SELECT):** post/asset `ready`, `source_bytes` ≈ tamaño, `multipart_upload_id` NULL (se limpia en complete), `storage_key` = `community/<id>/original.mp4`, `private_original_key` NULL. Manifiesto como S1 (1 registrada; 8 inferidas NOT_FOUND). Después tú ejecutas el HEAD previo, borras desde la interfaz y repites el HEAD.
**Verificación de sesiones multipart:** la BD (`multipart_upload_id` NULL) y un HEAD no demuestran que R2 no tenga una sesión abierta; solo un `ListParts` por `uploadId` lo haría y hoy no existe ese script (pendiente de autorización). En un S2 correcto la sesión se cierra con `CompleteMultipartUpload`.

### Qué muestra el frontend si falla S2 (código)
Los errores salen en la tarjeta del elemento (`CommunityPostEditorForm.tsx:407`, `item.errorMessage`); no hay mensaje específico de ETag ni de checksum, y el código HTTP no se muestra.
| Fallo | Mensaje visible | Origen |
|---|---|---|
| Preflight/CORS bloqueado o red caída | «Error de red durante la subida» | `media-client.ts` (`xhr.onerror`; CORS y red son indistinguibles) |
| R2 responde no-2xx (p. ej. 400 por checksum o 403 por firma) | «La subida a R2 falló» (el status va en el error pero no se pinta) | `media-client.ts` (`xhr.onload`) |
| `ETag` no expuesto por CORS | «R2 no devolvió ETag para una parte» | `useMediaUpload.ts:332` |
| `CompleteMultipartUpload` rechazado | mensaje del servidor «No se pudo completar la subida multipart» | `media-handlers.ts:622` |
Para distinguir causa mira DevTools: OPTIONS fallido = CORS; PUT con 400 y cuerpo XML de R2 = checksum/firma; PUT 200 sin `ETag` visible = falta `ExposeHeaders`.

## Evidencia R6-S2 (inicial, SELECT 2026-10-09; borrado NO ejecutado, sin veredicto)
| Dato | Valor |
|---|---|
| Post | `b2eda39b-6f51-4aa2-a88a-85eeed0e1ef0` · `published` · creado 20:04:58Z · 1 medio · **`text` NULL** (no contiene «PRUEBA R6 S2 MULTIPART») |
| Asset | `1fb8b97d-8b25-430d-818f-e8c004feffd1` · `video` · `ready` · creado 20:03:11Z, `ready` 20:04:16Z · `processing_attempts` 1 |
| MIME / tamaño | `video/mp4` · 23 044 751 B (**21,98 MiB**, ≥ 16 MiB) · 576×1024 · 237,4 s |
| `storage_key` (registrada) | `community/1fb8b97d-8b25-430d-818f-e8c004feffd1/original.mp4` |
| `private_original_key` / `multipart_upload_id` | NULL / NULL (estado posterior a `complete`) |
| Variantes | 0 |

**Identificación:** el texto del post está vacío, por lo que se identificó por fecha y tamaño: es la única publicación con un vídeo de ~22 MiB y la única creada tras la subida (la otra reciente es el vídeo de 0,96 MiB de ~19:51Z). Pendiente de confirmación del propietario antes del borrado.

**Compatibilidad con multipart completado (evidencia, no prueba independiente):**
- 23 044 751 B ≥ 16 MiB → el servidor elige multipart por tamaño (`usesMultipart`); `ceil(bytes / 8 MiB)` = 3 partes, igual que los 3 PUT 200 observados.
- Logs Vercel: `reserve` 20:03:10.7Z → `complete` 20:04:10.6Z (≈60 s de subida) → 200; el asset quedó `ready` a 20:04:16Z.
- Para llegar a `ready`, `complete` tuvo que (1) completar el multipart y (2) comprobar por HEAD que el tamaño del objeto reensamblado era exactamente 23 044 751 B; si no, habría quedado `failed/upload_incomplete`.
- `multipart_upload_id` NULL es lo que `complete` escribe tras completar; **no** demuestra por sí mismo que nunca hubiera una sesión ni que no exista otra abierta. Eso solo lo probaría un `ListParts`/`ListMultipartUploads` (no disponible hoy).

**Manifiesto:** `evidence/r2-video-s2-before.csv` (9 claves).
- **EXISTS 200:** `upmina-media-dev-public` · `community/1fb8b97d-8b25-430d-818f-e8c004feffd1/original.mp4` (registrada).
- **NOT_FOUND 404 (inferidas):** `staging/…/original.mp4` y `objects/…/original.mp4` (privado); `original.mov|webm` y `w480|960|1600|2560.webp` (público).
Pendiente: HEAD previo, confirmación de identidad, borrado, HEAD posterior y SELECT final.

### R6-S2 · Resultados y veredicto (2026-10-09)
**Subida:** MP4 de 23 044 751 B (21,98 MiB), 3 PUT a R2 (200), `complete` 200, reproducción correcta.
**HEAD previo** 20:09:01.970Z: `community/1fb8b97d-8b25-430d-818f-e8c004feffd1/original.mp4` EXISTS 200; las otras 8 claves NOT_FOUND 404.
**HEAD posterior** 20:10:03.609Z: las 9 claves NOT_FOUND 404.
**Supabase (SELECT):** post 0 · asset 0 · variantes 0 · enlaces por asset 0 y por post 0 · auditoría 0 · assets en `deleting` 0. Los tres `reserved` huérfanos siguen intactos.

| Hora (UTC) | Hecho | Fuente |
|---|---|---|
| 20:03:10.7 / 20:04:10.6 | `reserve` / `complete` → 200 | log Vercel |
| 20:09:01.9 | HEAD previo | propietario |
| 20:09:59.762 | `POST /api/admin/community-post-delete` → 200 | log Vercel |
| 20:10:00.068 | tick de cron (succeeded) | `cron.job_run_details` |
| 20:10:00.136 | respuesta de pg_net 200 con `claimed:0, finalized:0, failed:0` | `net._http_response` |
| 20:10:00.478 | `/api/media/gc` → 200 | log Vercel |
| 20:10:03.6 | HEAD posterior: todo 404 | propietario |

**Hubo un tick de cron/GC en la ventana (a ~0,7 s del borrado), pero su respuesta fue `claimed: 0`: el GC no reclamó ni finalizó este asset.** Las marcas de tiempo de Vercel y pg_net no están alineadas al milisegundo, por lo que no se interpreta el orden fino.
**Comprobado:** el objeto desapareció entre 20:09:01 y 20:10:03; el GC del tick de las 20:10 no procesó nada; no quedan filas.
**No comprobado:** qué operación borró físicamente el objeto (sin registro de `DeleteObjects` ni `allCleaned`). Que fuera la limpieza inmediata del endpoint es lo único que el GC (claimed 0) no explica por descarte, pero sigue siendo inferencia.

**Veredicto S2:** **PASS** eliminación física (9/9) · **PASS** consistencia de BD (0 residuos). La sesión multipart no se verificó con una prueba independiente (ver S3).

## R6-S3 · Cancelación multipart (preparado, NO ejecutado)
### Herramienta de solo lectura
`scripts/r2-multipart-check-dev.mjs` (+ `scripts/lib/r2-multipart-check-dev.mjs`, 6 tests): solo `ListMultipartUploads` y `ListParts`, solo `upmina-media-dev-private`, prefijos `staging/community/` o `staging/community/<assetId>/`. Imprime clave, fecha de inicio, **solo los 6 últimos caracteres del UploadId**, nº de partes y bytes; nunca ETags, credenciales ni URLs. 403/red salen como ERROR, no como «sin sesiones». Las credenciales las carga `--env-file` (solo las 5 variables `R2_DEV_*`) o el entorno.
```powershell
node scripts/r2-multipart-check-dev.mjs --env-file .env.local                 # todas las sesiones de staging/community/
node scripts/r2-multipart-check-dev.mjs --env-file .env.local --asset <assetId>
```
Salidas: `NO_OPEN_SESSION` · `OPEN_SESSION | initiated | upload=…xxxxxx | parts=N | bytes=M` · `ERROR | http | detalle`.

### Captura del `multipart_upload_id` — no hace falta
El script encuentra la sesión por su **clave** (`staging/community/<assetId>/original.mp4`), no por el `uploadId`. El assetId se obtiene por SELECT (o del nombre de la clave que imprime el script). El `uploadId` no se copia a ningún archivo ni documento y la URL de cada parte (firmada) no se usa.

### Procedimiento
**Archivo:** MP4 de 60–90 MiB (8–12 partes). En DevTools → Network → Throttling «Fast 3G» (o similar) para disponer de tiempo.
1. **Línea base:** `node scripts/r2-multipart-check-dev.mjs --env-file .env.local` → esperado `NO_OPEN_SESSION`.
2. Community DEV: nueva publicación «PRUEBA R6 S3 CANCELA», adjunta el MP4 y deja que empiece a subir. **No cierres la pestaña.**
3. Con la barra al 30–50 %: ejecuta el mismo comando → esperado `OPEN_SESSION` con `parts` > 0 y `bytes` crecientes (anota la clave: contiene el assetId). Pídeme el SELECT (esperado: `reserved`, `multipart_upload_id` presente).
4. **Cancela quitando el elemento del editor** (llama a `/api/media/abort`). No uses «cerrar pestaña».
5. Repite el comando: esperado `NO_OPEN_SESSION`. Después, SELECT mío: asset inexistente; HEAD de `staging/community/<assetId>/original.mp4` → NOT_FOUND (esto último no sustituye al paso 5).
**Resultados:** PASS = OPEN_SESSION en 3 y NO_OPEN_SESSION en 5 con fila eliminada. FAIL = sigue OPEN_SESSION tras el abort (o el abort devolvió 503: la fila queda intacta y la sesión viva). BLOCKED = ERROR 403/red.
**Recuperación:** si el abort falla, repetir quitar el elemento o volver a llamar al flujo de abort con la misma sesión; no tocar otros assets ni ejecutar GC.
**Modifican datos/coste:** 1 asset `reserved` y hasta ~90 MiB de partes en R2 durante minutos; el script no modifica nada.

### Riesgo: que el GC o el barrido eliminen la fila antes de abortar la sesión
- El GC solo actúa sobre filas `deleting`, y `/api/media/abort` aborta la sesión **antes** de marcar `deleting` (si el aborto falla, 503 y fila intacta) → el flujo de cancelación es seguro en ese orden.
- `media_abandoned_sweep` marca como `deleting` reservas con ≥ 24 h (mínimo duro 2 h) sin considerar `multipart_upload_id`; el GC borra claves, **no aborta multipart** (sin lógica de multipart en `media-gc.ts`, `cosplay-media-lifecycle.ts` ni en la migración 20261026). La fila se elimina y el `uploadId` se pierde → sesión huérfana invisible a HEAD, con partes ocupando espacio hasta la limpieza automática por defecto de R2 (7 días según la documentación de Cloudflare; no verificado aquí).
- Ventana de riesgo real: subidas abandonadas (pestaña cerrada) o fallidas sin «quitar». La prueba S3 no ejercita esto; hoy hay 0 reservas multipart abandonadas (las tres huérfanas son PNG de PUT simple).
- Mitigación sugerida (fuera de esta fase, requiere código y migración): abortar la sesión antes de borrar la fila en el GC/barrido, o excluir del barrido las filas con `multipart_upload_id` y abortarlas por otra vía. Hasta entonces, el script permite detectar sesiones sueltas.

### R6-S3 · Resultados y veredicto (2026-10-09)
**Evidencia R2 (solo lectura, propietario):** ANTES 20:35:57.972Z → `OPEN_SESSION` (`staging/community/ac208adc-8ec0-4bcb-9c29-c087bf322021/original.mp4`, iniciada 20:35:50.502Z, **parts=0, bytes=0**). DESPUÉS 20:36:56.953Z → `NO_OPEN_SESSION`.

**Supabase (SELECT tras la cancelación):** asset 0 filas · variantes 0 · enlaces community 0 y cosplay 0 · auditoría 0 · ningún asset con `multipart_upload_id` · ningún asset en `deleting` · ningún asset creado desde 20:30Z · los tres `reserved` huérfanos intactos.

| Hora (UTC) | Hecho | Fuente |
|---|---|---|
| 20:35:00.079 | último tick de cron antes de la ventana (succeeded) | `cron.job_run_details` |
| 20:35:48.668 | `POST /api/media/reserve` → 200 | log Vercel |
| 20:35:50.502 | sesión multipart iniciada en R2 | script de lectura |
| 20:35:57.972 | ANTES: OPEN_SESSION, 0 partes | script de lectura |
| **20:36:49.983** | `POST /api/media/abort` → 200 | log Vercel |
| 20:36:56.953 | DESPUÉS: NO_OPEN_SESSION (~7 s tras el abort) | script de lectura |
| 20:40:00 | siguiente tick previsto (posterior a la ventana) | calendario del job |

**Cron/GC en la ventana (20:35:50–20:36:57):** ninguno. No hubo tick de cron entre 20:35:00 y 20:40:00, no hay llamadas a `/api/media/gc` en los logs y `net._http_response` no tiene filas desde 20:30Z.

**Veredictos**
- **Sesión R2 cerrada: PASS** (OPEN_SESSION → NO_OPEN_SESSION con el mismo prefijo del asset, dos lecturas autenticadas).
- **Estado de BD: PASS** (0 filas relacionadas, sin `multipart_upload_id` residual, sin `deleting`).
- **Atribución al flujo de abort: respaldada por correlación, no por evidencia directa.** Hay un `/api/media/abort` 200 a las 20:36:49.983, ~7 s antes del NO_OPEN_SESSION, y no hubo GC/cron en la ventana. Faltan el cuerpo de la respuesta (`deleted`/`deleting`) y un registro de `AbortMultipartUpload` en R2; el código llama a abort antes de marcar el asset, pero eso no se observó.

**Alcance y límites (expreso):** la sesión tenía **cero partes completadas** (parts=0, bytes=0) en la lectura previa. **No se ha probado** que el abort elimine partes ya almacenadas, ni la carrera con un PUT de parte en vuelo. No se ejerció el escenario de subida abandonada (cierre de pestaña) ni la ausencia de aborto en GC/barrido (riesgo documentado arriba). Un `ListParts` posterior a la cancelación no existe: `NO_OPEN_SESSION` significa que la sesión ya no está listada.
