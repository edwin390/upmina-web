# 9K-R7 · Validación final controlada (2026-10-10, preparación; nada remoto ejecutado)

**Estado final: PARTIAL.** Lógica y aislamiento demostrados localmente; la prueba remota B/C NO se ejecutó (no
autorizada) y por tanto R7 **no está completamente validado**. Compuerta de seguridad: **PASS condicionado** a un
paso previo obligatorio (subir `protected_before`); **FAIL** si se intentara con la política tal cual está.

## 1. Piezas implicadas

- SQL: `media_abandon_policy`, `media_abandoned_reservations_mark(p_now)`, `community_media_purge_tick()` (20261028).
- Cron: único job `community-media-purge-tick` (`*/5 * * * *`, activo) → tick → marcador → backlog → POST firmado.
- GC: `/api/media/gc` (`media-gc-handler.ts`, `media-gc.ts`) + RPC de claim/finalize; solo actúa sobre `deleting`.
- `media_abandoned_sweep` (20261026): ejecutable por `service_role`, sin corte. **Ninguna función ni cron lo
  referencia** (SELECT a `pg_proc` y `cron.job`). No participa en la prueba y no debe ejecutarse.

## 2. Estado de R7 (SELECT 04:22Z)

`enabled=false`, `min_age=24:00:00`, `batch_limit=20`, `protected_before=2026-10-09 23:00Z`, `last_run_at` NULL; sin
triggers en la política; 0 assets `deleting`; assets: ready 139, failed 9, reserved 6.

## 3. Candidatos actuales (sin datos personales)

| Asset                               | Dominio/estado                    | Creado (UTC)        | Veredicto con la política actual                                               |
| ----------------------------------- | --------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `5073059a`                          | cosplay/reserved                  | 2026-09-27          | histórico protegido                                                            |
| `8d94a817`                          | community/reserved                | 2026-10-01          | histórico protegido                                                            |
| `9bcaf8c0`, `bff7445d`, `ce25dadb`  | community/reserved                | 2026-10-09 ~18:5x   | histórico protegido                                                            |
| **Asset A `a9c4e223`**              | community/reserved, con multipart | 2026-10-09 23:06:39 | **POSTERIOR AL CORTE → elegible desde 2026-10-10 23:06:39Z con `min_age=24h`** |
| Ready/failed: excluidos por estado. |

## 4. Hallazgo bloqueante y respuesta

**El corte histórico NO protege a Asset A** (es posterior al corte). Con `min_age=24h` A se vuelve elegible hoy a las
23:06Z, ANTES de que cualquier B creado hoy cumpla 24 h. Activar el marcador global después de esa hora, sin más,
borraría A (y abortaría su sesión multipart).

**¿Se puede aislar por asset?** No: el marcador no acepta lista de ids ni filtro por asset (tampoco `p_now` ayuda;
solo existe para pruebas y solo `postgres` lo invoca). El único mecanismo real son las columnas de la política:

- `protected_before` solo puede **subirse** (el CHECK fija un suelo, no un techo). Fijándolo en un instante entre
  `A.created_at` y `B.created_at` se excluye A y todo lo anterior, EN la propia consulta.
- `batch_limit=1` como segunda barrera (limita el daño a un asset).
- `min_age=24h` (objetivo; sin tocar fechas de creación).

Demostrado en PGlite (4 tests nuevos en `media-abandoned-reservations.test.ts`):

1. Sin subir el corte, el barrido global SÍ marca un «A» posterior y antiguo (documenta el riesgo).
2. Con `protected_before` entre A y B: se marca solo B (`candidates=1, marked=1`); A, C reciente, 2 históricos,
   ready/failed intactos y un `deleting` ajeno sin cambios; segunda ejecución idempotente (0).
3. El GC posterior reclama 1, aborta la sesión de B con su `uploadId` exacto, finaliza solo B; nunca A, C ni históricos.
4. Con C reciente y sin B elegible: 0 marcados; el corte no puede bajarse del suelo.
   Además, la barrera multipart impide borrar la fila de un asset con sesión abierta (se vio al intentar limpiar el
   escenario), de modo que un borrado indebido por otra vía también está frenado.

## 5. Compuerta de seguridad

| Condición                               | Evidencia                                                                                                                                   | Estado                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Selección limitada a assets autorizados | solo con `protected_before` ↑ + SELECT previo que liste exactamente 1 candidato                                                             | PASS condicionado                                                      |
| Asset A no seleccionable                | `protected_before > A.created_at` (test 2)                                                                                                  | PASS condicionado                                                      |
| Históricos no seleccionables            | filtro en la consulta + corte ↑ (tests existentes y 2)                                                                                      | PASS                                                                   |
| ready/failed/deleting excluidos         | tests existentes y 2                                                                                                                        | PASS                                                                   |
| GC no toca reales                       | reclama solo `deleting`; test 3; backlog actual 0                                                                                           | PASS (revisar backlog antes)                                           |
| Barrido antiguo ausente                 | sin referencias en funciones/cron; ACL solo postgres/service_role                                                                           | PASS (no invocarlo)                                                    |
| Observable                              | `policy.last_*`, respuesta del tick (`abandoned`), `cron.job_run_details`, `net._http_response`, logs de `/api/media/gc`, SELECT de estados | PASS parcial: el JSON del tick no se persiste                          |
| Recuperación                            | ver §8                                                                                                                                      | PASS parcial: el borrado de B es irreversible por diseño (B sintético) |
| Concurrencia real                       | PGlite = 1 conexión; `SKIP LOCKED`/locks solo por revisión                                                                                  | NO verificado (brecha)                                                 |

## 6. Diseño de B y C

- **B** (abandonada): reserva multipart creada por el propietario con una subida de ≥ 1 parte y pestaña cerrada;
  sin vínculo con publicaciones. Debe ser el ÚNICO asset nuevo creado tras fijar el corte.
- **C** (control reciente): reserva creada ≥ 23 h después de B y < 24 h antes de activar; sin vínculos.
- Reglas: no tocar fechas; no reutilizar A; ningún otro asset de prueba ni de usuarios reales en la ventana.
- Cronología: T0 = B; T0+23 h = C; T0+24 h 05 min = activar (B tiene > 24 h, C ≈ 1 h).

## 7. Procedimiento remoto exacto (NO EJECUTADO; cada escritura requiere autorización explícita)

1. **Previo (SELECT)**: política desactivada; 0 `deleting`; backlog GC 0; huella `md5` de `media_assets` anotada; alias
   DEV con backend con protección multipart; asset A intacto.
2. **Fijar el corte (escritura 1, política inerte)**: justo antes de crear B,
   `update media_abandon_policy set protected_before = <instante de T0 menos 1 minuto>, batch_limit = 1;`
   (el instante debe ser > A.created_at 2026-10-09 23:06:39.885Z; `enabled` sigue en false).
3. T0: el propietario crea B; verificar sesión R2 abierta con su script. T0+23 h: crear C.
4. **Simulación previa** (`docs/9K-R7-eligibility-simulation.sql` con `interval '24 hours'`): debe mostrar EXACTAMENTE
   B como `ELEGIBLE`, C `RECIENTE`, A y el resto `PROTEGIDO_HISTORICO`. Si hay otro candidato: DETENER.
5. **Activar (escritura 2)**: `update media_abandon_policy set enabled = true;` y esperar UN tick natural (≤ 5 min).
6. **Desactivar de inmediato (escritura 3)**: `update media_abandon_policy set enabled = false;` (no esperar más ticks).
7. **Verificar**: `last_candidates=1, last_marked=1`, `last_error_class` NULL; B `deleting` → tras el ciclo del GC
   desaparece y su sesión R2 pasa a `NO_OPEN_SESSION`; C `reserved`; A `reserved` con su `multipart_upload_id`;
   huella del resto idéntica; `net._http_response` con `claimed=1, finalized=1`.
8. **Cierre**: dejar `enabled=false`; decidir si el corte elevado se mantiene (recomendado: sí).

## 8. Recuperación

- Cualquier anomalía antes del tick: `enabled=false` (revierte todo sin deploy).
- Marcado erróneo de un asset real: antes de que el GC lo reclame no hay vuelta atrás por API; por eso el paso 4 es
  obligatorio. Si ocurriera, `update media_assets set status=<anterior>` solo por `postgres` y solo mientras sea
  `deleting` sin claim (autorizar caso a caso) y revisar `failure_code`.
- Fallo del GC (R2 caído): la fila y el `uploadId` sobreviven y se reintenta (test «si el aborto falla»); con
  `enabled=false` no se marcan más. Un `deleting` atascado se investiga con `media_gc_backlog()`.
- Fallo del barrido: queda `last_error_class='mark_failed'`, lote deshecho; desactivar y revisar logs.

## 9. Pruebas ejecutadas (local)

- `media-abandoned-reservations` **29/29** (24 previos + 5 nuevos de aislamiento). Con cleanup, scheduler, GC×3 y
  purge-lifecycle: 7 archivos / **217/217**. `tsc -b`, ESLint, Prettier (test) y `npm run build` OK.
- Suite completa de la fase previa: 239 archivos / 7155 tests OK (el único cambio posterior es este test).
- Concurrencia real: no ejecutable en PGlite → brecha documentada.

## 10. Riesgos

Activar la política sin subir el corte borra A; C/B coinciden con actividad real de usuarios en DEV; el JSON del tick
no se guarda; el corte es específico de DEV; `media_abandoned_sweep` sigue invocable por `service_role`.

## 11. Criterios de aceptación

Solo B marcado y eliminado (R2 incluido); C, A y los históricos intactos; política `enabled=false` al final;
sin errores; huellas coincidentes. Hasta ejecutar §7: **PARTIAL**.

## 12. Para cerrar R7 y 9K

R7: autorización de las escrituras 1–3 y de la creación de B/C por el propietario (≈ 24 h de reloj). 9K: además,
validación autenticada de R5, confirmar el Preview sin diagnósticos TS, y commit/push.

## 13. Prueba acelerada LOCAL (ejecutada — resultados reales)

Sin PostgreSQL local (ni `postgres`, ni Docker, ni `pg`): se usó **PGlite** con el SQL real de la cadena de
migraciones y de 20261028 (marcador, tick, GC multipart). R2 es un mock; Supabase DEV, Asset A, cron y políticas
remotas no se tocaron. **Limitación:** PGlite es una sola conexión; la concurrencia real (`SKIP LOCKED`, lock de la
política, advisory lock) **sigue sin probarse** con dos sesiones.

**Cómo se aceleran las 24 h.** El reloj real (2026-10-10 04:26Z) deja `ahora − 25 h` por debajo del suelo del corte
(2026-10-09 23:00Z), así que no se puede crear un asset «antiguo y posterior al corte» solo retrocediendo fechas.
Los assets se crean con el reloj real y después se **desplazan sus timestamps con UPDATE local**
(`created_at = updated_at`), y el marcador real recibe un «ahora» adelantado (`p_now` = 2026-10-12 12:00Z). El
trigger de actividad no pisa los timestamps (test propio).

| Asset | Representa                      | Estado / edad simulada               | Resultado                                                      |
| ----- | ------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| B     | reserva abandonada (multipart)  | `reserved`, 25 h, posterior al corte | **marcada `deleting`** → GC aborta su sesión → fila finalizada |
| C     | reciente de control (multipart) | `reserved`, 1 h                      | intacta                                                        |
| D     | histórica protegida (multipart) | `reserved`, anterior al corte        | intacta                                                        |
| E     | publicada                       | `ready`, 30 h, enlazada a un post    | intacta                                                        |
| F     | fallida                         | `failed`, 30 h                       | intacta                                                        |

Resultados (7 tests nuevos, todos PASS; archivo 36/36):

- Marcador real: `candidates=1, marked=1, skipped=0`; solo B pasa a `deleting`.
- GC con R2 simulado: `claimed=1, finalized=1, failed=0`; **una sola llamada de aborto**, con la clave y el
  `uploadId` exactos de B; ninguna llamada menciona C, D, E ni F; B desaparece; el resto conserva su estado.
- Idempotencia: segundo marcador `candidates=0`; segundo GC `claimed=0` sin llamadas a R2.
- Reintento: con R2 caído (`failed=1`) B queda `deleting` con su `multipart_upload_id`, y el marcador no lo re-elige.
- Error del marcador: se contiene (`status=error`, sin texto interno), no marca nada y la siguiente ejecución sana
  marca B.
- Reloj real: nada elegible (las 24 h no han pasado).
- **Mutación:** hacer que el marcador incluya `ready`/`failed` hace fallar 3 de los 7 tests; migración restaurada
  byte a byte (`cmp`).
- No se halló ningún defecto; no hubo cambios en el SQL ni en el código de producción.

Validación global: `tsc -b`, `typecheck:functions`, ESLint (0 warnings), Prettier y build OK; suite completa
**239 archivos / 7167 tests, sin fallos ni workers perdidos**.

**Estado:** la lógica del marcador + GC queda validada localmente de extremo a extremo con datos sintéticos.
**R7 sigue PARTIAL** hasta ejecutar §7 en DEV (autorizado por separado) y probar la concurrencia con dos
conexiones reales; la compuerta del corte para Asset A (§4) sigue vigente.
