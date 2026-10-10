# 9K-R5-S1 · Evidencia de la prueba de eliminación voluntaria (DEV)

Estado: **EJECUTADA (2026-10-09). Veredicto físico: PASS · inicio inmediato: PASS con matiz (ver abajo).** Solo Supabase DEV `rkqeqbqwdswhpzwqptac`; verificación posterior solo con SELECT y lectura de logs.

## Identificación (SELECT, 2026-10-09)
La publicación que el propietario confirmó como de prueba tiene texto `edwin` (no el texto previsto).

| Dato | Valor |
|---|---|
| post | `ed5f7a86-817d-4dba-a6c5-0fd30c157585` (`published`, creada 2026-10-09 19:32:55Z, 1 medio, posición 0) |
| asset | `50c6a566-22fa-4e22-a5c2-7cc1ff6db31b` · community · image · `ready` |
| asset creado / último cambio de estado | 19:30:26Z / 19:30:31Z · `purge_attempts` 0 · sin multipart |
| `storage_key` | `community/50c6a566-22fa-4e22-a5c2-7cc1ff6db31b/w960.webp` |
| `private_original_key` | NULL (original privado ya no retenido) |
| variantes registradas | 480 → `community/50c6a566-22fa-4e22-a5c2-7cc1ff6db31b/w480.webp`, 960 → `community/50c6a566-22fa-4e22-a5c2-7cc1ff6db31b/w960.webp` |

## Objetos a consultar (`evidence/r2-delete-before.csv`)
| Bucket | Clave | Esperado antes |
|---|---|---|
| `upmina-media-dev-public` | `community/50c6a566-22fa-4e22-a5c2-7cc1ff6db31b/w480.webp` | EXISTS 200 |
| `upmina-media-dev-public` | `community/50c6a566-22fa-4e22-a5c2-7cc1ff6db31b/w960.webp` | EXISTS 200 |
| `upmina-media-dev-public` | `community/50c6a566-22fa-4e22-a5c2-7cc1ff6db31b/w1600.webp`, `w2560.webp` | NOT_FOUND 404 (nunca generadas; las incluye la lista canónica del GC) |
| `upmina-media-dev-private` | `staging/community/50c6a566-22fa-4e22-a5c2-7cc1ff6db31b/original.png`, `objects/community/50c6a566-22fa-4e22-a5c2-7cc1ff6db31b/original.png` | NOT_FOUND 404 (eliminadas tras el procesado; extensión derivada del MIME image/png, no leída de la BD) |

Si w480 o w960 no dan EXISTS, la línea base no es válida (BLOCKED). Si un privado da EXISTS, es un original retenido y debe anotarse.

## HEAD antes del borrado (ejecutado por el propietario)
2026-10-09T19:35:37.001Z · `w480.webp` EXISTS 200 · `w960.webp` EXISTS 200 · `w1600`, `w2560`, `staging/…/original.png`, `objects/…/original.png` NOT_FOUND 404. Línea base válida.

## Borrado
Publicación eliminada por su autora desde la interfaz normal de Community DEV.

## HEAD después del borrado
2026-10-09T19:37:21.458Z · las seis claves NOT_FOUND 404.

## Estado en Supabase (SELECT, tras el borrado)
| Comprobación | Resultado |
|---|---|
| Post `ed5f7a86-…` | 0 filas |
| Asset `50c6a566-…` | 0 filas (finalizado) |
| `media_asset_variants` / `community_post_media` del asset | 0 / 0 |
| Assets en `deleting` (global) | 0 |
| `moderation_audit_log` con el post o el asset | 0 filas (el borrado voluntario no escribe auditoría aquí) |
| `net._http_response` desde 19:30Z | vacío |

## Línea temporal (UTC)
| Hora | Hecho | Fuente |
|---|---|---|
| 19:30:26.1 | Asset creado (reserve 19:30:26.03, complete 19:30:30.14, `ready` 19:30:31.9) | BD + logs Vercel |
| 19:32:55 | Post creado | BD |
| 19:35:00 | Último tick de cron anterior al borrado (succeeded) | `cron.job_run_details` |
| 19:35:37.001 | HEAD previo: w480/w960 existen | propietario |
| **19:37:18.397** | `POST /api/admin/community-post-delete` → 200 | log de ejecución Vercel (despliegue `dpl_2rcgbiQ…`) |
| 19:37:21.458 | HEAD posterior: las seis claves 404 | propietario |
| 19:40:00 | Siguiente tick de cron (posterior a todo lo anterior) | calendario del job |

## Comprobado vs inferido
**Comprobado**
- Los dos objetos existían a las 19:35:37 y no existen a las 19:37:21 (HEAD autenticado, 404 y no 403).
- La fila del asset ya no existe y no queda nada en `deleting`.
- La llamada al endpoint de borrado ocurrió a las 19:37:18 con 200, ~3,1 s antes del HEAD posterior.
- Entre las 19:35:00 y las 19:40:00 no hubo ningún tick de cron; no hay llamadas a `/api/media/gc` en los logs de ese despliegue ni respuestas en `net._http_response`.

**Inferido (no probado directamente)**
- Que el borrado físico lo hizo la limpieza inmediata del endpoint: es lo único que encaja con la ausencia de cron y de llamadas a `/api/media/gc`, y con que el código solo elimina la fila del asset tras borrar en R2. No hay registro de `DeleteObjects` ni se vio el cuerpo de la respuesta (`allCleaned`).
- Que no hubo reintentos: la fila no pasó por observación intermedia y `purge_attempts` no se puede leer ya (la fila no existe). Con el tiempo de 3,1 s y ningún ciclo de cron, no hay indicio de reintento.

## Veredictos
- **Resultado físico: PASS.** Post 404 (0 filas), asset finalizado y las dos variantes reales con HEAD 404 (más las cuatro claves de control).
- **Inicio inmediato del borrado: PASS con matiz.** El borrado terminó antes de 3,1 s desde la llamada al endpoint y sin intervención de cron/GC. El matiz: la atribución al endpoint es inferencia, y no se capturó `allCleaned`.

## Residuos y riesgos
- Tres assets `reserved` huérfanos de los intentos bloqueados por CORS (18:51:35, 18:52:33 y 18:53:01Z): `9bcaf8c0-1cf8-4fba-bcd2-52c01e7d91e3`, `bff7445d-7128-48f6-ab41-5be43df397bc`, `ce25dadb-9e1f-49bf-a263-d1477462d149`. Sin vincular y sin objeto subido (el PUT fue bloqueado). No se tocaron; el barrido los recogería a las 24 h.
- Otros dos assets creados a las 19:30 (reserve 19:30:09 y 19:30:17) ya no existen en BD; no se investigó cómo se eliminaron (probablemente retirados del editor por el flujo de descarte).
- El ajuste de checksum (`requestChecksumCalculation`) sigue local y sin desplegar; hay un Preview sin alias (`upmina-web-testing-24b70pvvl`).
- No se probó el vídeo, el multipart ni el escenario B (moderación + purga a 72 h).

## Cierre R2 · revisión de tres reservas huérfanas (SELECT, 2026-10-09 19:42Z)
| Asset | Creado/actualizado (UTC) | Cumple 24 h | Clave registrada (`private_original_key`) |
|---|---|---|---|
| `9bcaf8c0-1cf8-4fba-bcd2-52c01e7d91e3` | 18:51:35 | 2026-10-10 18:51:35 | `staging/community/9bcaf8c0-…/original.jpg` (image/jpeg, 59 536 B) |
| `bff7445d-7128-48f6-ab41-5be43df397bc` | 18:52:33 | 2026-10-10 18:52:33 | `staging/community/bff7445d-…/original.png` (image/png, 257 990 B) |
| `ce25dadb-9e1f-49bf-a263-d1477462d149` | 18:53:01 | 2026-10-10 18:53:01 | `staging/community/ce25dadb-…/original.png` (image/png, 257 990 B) |

Los tres: `community`, `image`, `reserved`, creados por la misma cuenta, 0 enlaces a posts, 0 a cosplay, 0 variantes, sin multipart, `purge_*` vacíos, `storage_key` NULL. Faltan ~23 h para el umbral de 24 h del barrido (el mínimo duro de pendientes es 2 h).
Manifiesto: `evidence/r2-orphans-before.csv` (27 claves: 3 registradas, el resto marcado INFERIDA: `objects/…` y las variantes canónicas del GC). Como el PUT fue bloqueado por CORS, lo esperable es `NOT_FOUND` en todas; un EXISTS en el staging registrado indicaría que la subida llegó a escribirse.

### Limpiar solo estos tres
- `media_abandoned_sweep` **no** admite lista de IDs: solo filtra por antigüedad/dominio/límite; al cumplir 24 h arrastraría también los otros candidatos históricos (36 de la simulación).
- `community_media_asset_discard` solo acepta `ready`.
- `/api/media/abort` sirve para `reserved`, pero exige el JWT de la cuenta propietaria (no disponible aquí, y no se pega en el chat).
- Camino mínimo con mecanismo existente: marcar exactamente esos tres IDs como `deleting` (transición `reserved→deleting` válida) y dejar que el GC del cron (≤5 min) los reclame, borre en R2 (idempotente si no existen) y finalice. Es una escritura remota restringida a `where id in (3 IDs) and status='reserved'` y exige autorización explícita (marcar `deleting` equivale a borrar, sin deshacer).
