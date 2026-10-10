# 9K-R4-E5 · Estado documentado

**9K-R4-E5 — Ausencia actual del objeto en R2 confirmada con HEAD autenticado (2026-10-09T18:43:37.422Z: `NOT_FOUND | 404`) y, antes, de forma visual. El momento exacto y el mecanismo físico del borrado no se conocen.**

## Qué está demostrado
| Hecho | Fuente | Tipo |
|---|---|---|
| El asset de E5 es `61f428b8-4d0e-48a4-abf8-c8b046a2ac31` y estaba en el post `c2edd913-289f-4563-a655-dc65960c86ea` (posición 0) | Script de montaje `e5-a.mjs` (reserve → complete → `community-post-save` con ese assetId) y su salida, 2026-10-06 ~02:47Z; manifiesto escrito 02:49:38Z | Directa (artefactos locales) |
| Tenía exactamente 1 objeto público: `community/61f428b8-4d0e-48a4-abf8-c8b046a2ac31/w480.webp` (bucket `upmina-media-dev-public`); sin original privado retenido | Salida del script (`variants 1`, `private none-retained`) y `keyHash 1b43bfc9b4` = SHA-256 de esa clave (comprobado contra `w960`, `w1600`, `w2560` y `original.mp4`, que no coinciden) | Directa |
| El objeto existía antes de la purga | HEAD autenticado del 2026-10-06 02:50:06Z (`exist [true]`) | Directa (histórica) |
| La purga automática ocurrió y el GC finalizó 1 asset | `post_purged` (`assets_marked: 1`), pg_net 200 `claimed:1, finalized:1, failed:0`, RPC claim/objects/finalize 2026-10-09 02:50:00–02:50:02Z | Indirecta |
| La fila, las variantes y el post ya no existen en Supabase; la auditoría se conserva | SELECT de solo lectura | Directa (actual) |
| El prefijo `community/61f428b8-4d0e-48a4-abf8-c8b046a2ac31/` ya no aparece en R2 | Comprobación **visual manual** del propietario en el dashboard de Cloudflare | Directa (actual, visual) |
| `community/61f428b8-4d0e-48a4-abf8-c8b046a2ac31/w480.webp` en `upmina-media-dev-public` devolvió `NOT_FOUND \| 404` | HEAD autenticado con `scripts/r2-head-dev.mjs`, ejecutado por el propietario, 2026-10-09T18:43:37.422Z | Directa (actual, autenticada) |

## Qué NO se afirma
- El HEAD autenticado confirma la ausencia **en el instante de la consulta** (2026-10-09T18:43:37Z). No dice cuándo desapareció el objeto ni por qué mecanismo; no prueba que fuera el `DeleteObjects` del GC.
- No existe un registro histórico directo de la operación `DeleteObjects`. R2 Data Access Logs no estaban verificados como activos y no se pueden recuperar retroactivamente.
- El tiempo entre `objects` y `finalize` (~283 ms) es un indicio, no una prueba.
- Una prueba posterior con otra publicación (ver `9K-R5-S1-R2-DELETION-TEST.md`) valida el mecanismo, no sustituye a E5.

## Cierre
El HEAD autenticado pendiente ya se realizó y dio 404 (no 403 ni fallo de red). Lo que sigue sin demostrarse es el momento y el mecanismo físicos del borrado.

## Higiene
`scratchpad/e5-manifest.json` guarda credenciales de prueba en texto plano (ver informe de la fase R5-S1). Los identificadores de arriba no son secretos y bastan para documentar E5; las credenciales no hacen falta.
