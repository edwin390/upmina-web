# R5-S1 · Prueba real de eliminación física en R2 DEV (PREPARADA, NO EJECUTADA)

Estado: **sin ejecutar**. Requiere autorización expresa de la persona propietaria. Solo DEV
(`rkqeqbqwdswhpzwqptac`, bucket `upmina-media-dev-public` y `upmina-media-dev-private`). Nunca
Production. Esta prueba valida el mecanismo **hacia adelante**; no es una prueba retrospectiva del
caso 9K-R4-E5.

## Reglas
- Solo una cuenta y un post **sintéticos creados para la prueba**. Nunca contenido de usuarios reales.
- No se crean tokens ni se leen secretos en el chat. El HEAD lo hace quien tenga acceso de lectura
  a R2 (consola de Cloudflare o AWS CLI con credenciales propias que nunca se pegan aquí).
- No se ejecuta GC ni cron a mano ni se acelera nada. Se observa el flujo real de la aplicación.
- Se guardan solo CSV de claves, códigos HTTP y fechas. Sin URLs firmadas.

## Fase 0 · Preparación
1. Crear con la UI normal un post sintético con 1 imagen y 1 vídeo corto (archivos de prueba).
2. Anotar (SELECT de solo lectura):

```sql
select p.id as post_id, pm.asset_id, a.domain, a.kind, a.status, a.storage_key,
       a.private_original_key, a.created_at
from community_posts p
join community_post_media pm on pm.post_id = p.id
join media_assets a on a.id = pm.asset_id
where p.id = '<POST_ID>';

select asset_id, variant, storage_key from media_asset_variants where asset_id in (<ASSET_IDS>);
```

3. Lista de claves esperadas por asset. Imagen: `community/<assetId>/w480|w960|w1600|w2560.webp`
   (solo las variantes que existan). Vídeo: `community/<assetId>/original.<mp4|mov|webm>`. Privado
   (tras `ready` debería estar vacío): `objects/community/<assetId>/original.*` y
   `staging/community/<assetId>/original.*`.
4. Guardar `evidence/before.csv` con: `post_id, asset_id, bucket, key, http_head, timestamp_utc`.

## Fase 1 · HEAD inicial (debe ser 200 en las claves públicas esperadas)
- Bucket exacto: `upmina-media-dev-public` para variantes/vídeo; `upmina-media-dev-private` para
  originales. Registrar el código de cada clave.
- Si alguna clave pública esperada no da 200: **BLOCKED** (la línea base no es válida).

## Fase 2 · Borrado voluntario (escenario A)
1. Con la sesión de la cuenta sintética, borrar el post desde la interfaz normal de Community.
   Anotar la hora UTC exacta.
2. Comprobar de inmediato: el post desaparece del feed y de su URL (404).
3. La respuesta de `POST /api/admin/community-post-delete` debe traer `allCleaned: true` (limpieza
   inmediata confirmada por R2). Si trae `false`, los assets quedan en `deleting` y el GC los
   reintenta en el siguiente tick (≤ 5 min con backoff).

## Fase 3 · Comprobaciones posteriores
```sql
select id, status, purge_attempts, purge_last_error_class, purge_next_attempt_at
from media_assets where id in (<ASSET_IDS>);        -- 0 filas = finalizado
select count(*) from community_post_media where asset_id in (<ASSET_IDS>);          -- 0
select count(*) from media_asset_variants where asset_id in (<ASSET_IDS>);          -- 0
select count(*) from media_assets where status = 'deleting';                         -- sin pendientes
```
- HEAD de **todas** las claves de `before.csv` en ambos buckets → `after.csv`.

## Criterio
| Resultado | Condición |
|---|---|
| **PASS** | post 404 + 0 filas de asset + HEAD 404 en TODAS las claves de ambos buckets |
| **FAIL** | cualquier HEAD 200 con la fila ya finalizada (el sistema borró la fila sin borrar el objeto) |
| **BLOCKED** | no se pudo hacer HEAD, la línea base no daba 200 o el asset sigue `deleting` (reintento pendiente) |

Si el resultado es inesperado: no repetir ni limpiar a mano. Guardar `before.csv`, `after.csv` y las
consultas, y reportar.

## Escenario B (moderación + purga) · Fuera de esta fase
La retención de 72 h por moderación es un flujo separado y no se modifica. Se prueba aparte, con el
mismo manifiesto previo, esperando el plazo real. Es la prueba que sí cubre lo que E5 no pudo
demostrar.
