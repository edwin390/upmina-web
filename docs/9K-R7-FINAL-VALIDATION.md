# 9K-R7 · Validación final controlada (2026-10-10, preparación; nada remoto ejecutado)

> **ACTUALIZACIÓN 2026-10-10 (§15):** el propietario fijó `min_age = 4 horas` (en lugar de 24 h) y la prueba remota se
> ejecutó en DEV con éxito funcional. Los apartados 1–14 son el diseño y la preparación originales con 24 h y se
> conservan como historial: donde digan «24 h», el valor vigente en DEV es **4 h**. La comprobación DIRECTA de R2 también
> resultó favorable (§15.4). El cron conserva su frecuencia de 5 minutos.

**Estado: VALIDADO en DEV con 4 h (marcador, GC y cierre de la sesión multipart en R2 confirmados).** (Antes de la prueba el estado era
PARTIAL.)

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

## 14. Prueba remota B/C — preparación ejecutada (2026-10-10, 14:47–14:48Z)

**Alcance autorizado:** solo `protected_before` y `batch_limit` de la política DEV, y una reserva sintética B por el flujo
normal. `enabled` NO se activó; no se ejecutó barrido, GC ni `media_abandoned_sweep`.

### Compuerta previa (SELECT 14:47:41Z) — todo coincidió

`enabled=false`, `min_age=24:00:00`, `last_run_at` NULL, 0 `deleting`; Asset A `a9c4e223…` `reserved`, creado
2026-10-09 23:06:39.885Z, con multipart; ningún otro asset posterior al corte; único cron
(`select public.community_media_purge_tick();`, md5 `a11fc58e…`); el tick y ninguna otra función referencian
`media_abandoned_sweep`; huella de assets `6f2399df22b82bd4774636532534297a` (154 filas).

### Escritura (14:47:55Z) — una sola sentencia con guardas

`update media_abandon_policy set protected_before = date_trunc('second', clock_timestamp()), batch_limit = 1 where
singleton and enabled=false and min_age='24 hours' and last_run_at is null and protected_before='2026-10-09 23:00Z' and
batch_limit=20` → **`protected_before = 2026-10-10 14:47:55+00`, `batch_limit = 1`**, `enabled=false`, `min_age=24:00:00`.

### Prueba de exclusión (SELECT, predicado del marcador con el reloj adelantado 30 días)

Los 6 pendientes (`5073059a`, `8d94a817`, `9bcaf8c0`, `bff7445d`, `ce25dadb` y Asset A `a9c4e223`) tienen
`created_at < protected_before` → **ninguno es seleccionable**. Posteriores al nuevo corte: 0.

### Estado posterior (14:48:07Z)

Política: `false · 24:00:00 · batch_limit 1 · corte 14:47:55Z · last_run_at NULL`; 154 assets, huella **idéntica**
(`6f2399df…`); 0 `deleting`; Asset A `reserved`, `updated_at` sin cambios; 1 cron con el mismo md5.

### Asset B — NO creado todavía

La reserva multipart exige una sesión autenticada y subir archivo desde el navegador (flujo normal); no puede hacerla
el agente. **Asset B: pendiente de que el propietario lo cree.** Cuando exista: B.created_at > 14:47:55Z (cualquier
reserva nueva lo cumple) y será elegible a `B.created_at + 24 h` (el primer tick ≥ esa hora, ticks cada 5 min).

#### Crear B (propietario)

1. Con una cuenta de PRUEBA de DEV (alias `upmina-testing-backend.vercel.app`), iniciar una subida de un vídeo de
   prueba sintético (no personal) de tamaño suficiente para multipart y cerrar la pestaña tras ≥ 1 parte. No publicar.
2. Verificar con `scripts/r2-multipart-check-dev.mjs` (`OPEN_SESSION parts ≥ 1`) y por SELECT: exactamente un asset
   con `created_at > 2026-10-10 14:47:55Z`, `status='reserved'`, con `multipart_upload_id`. Anotar su id y
   `created_at`: **hora de elegibilidad = created_at + 24 h** (si el único candidato es B).
3. No crear ningún otro asset hasta terminar (cualquier reserva posterior al corte sería seleccionable).

#### Crear C (más adelante)

C se crea ≈ 23 h después de B (entre B+23 h y B+23 h 50 min), con el mismo flujo, SIN cerrar la pestaña si es posible
o dejándola `reserved` reciente (< 24 h al activar). Debe haber exactamente B (≥ 24 h) y C (< 24 h) posteriores al corte.

### Condiciones de parada

Cualquier asset nuevo distinto de B/C; `deleting` > 0; `enabled=true` o `min_age≠24 h`; Asset A o históricos
cambiados (huella); el cron distinto; B con `updated_at` reciente; fallos del GC pendientes (`media_gc_backlog`).
En cualquiera: NO activar.

### Ejecución controlada futura (cada escritura requiere autorización explícita; ≥ B+24 h y con C reciente)

1. SELECT previo: simulación `docs/9K-R7-eligibility-simulation.sql` (`interval '24 hours'`): exactamente B `ELEGIBLE`,
   C `RECIENTE`, A y los demás `PROTEGIDO_HISTORICO`; huella de assets (salvo B/C) igual a `6f2399df…`.
2. `update media_abandon_policy set enabled = true;` y esperar UN tick natural (≤ 5 min).
3. `update media_abandon_policy set enabled = false;` inmediatamente.
4. Verificar: `last_candidates=1, last_marked=1, last_error_class` NULL; B `deleting` → desaparece tras el GC y su
   sesión R2 queda `NO_OPEN_SESSION`; C `reserved`; A `reserved` con su multipart; huella del resto igual;
   `net._http_response` con `claimed=1, finalized=1`.
5. Fallos: `enabled=false`; si el GC falla, la fila y el `uploadId` sobreviven y se reintenta (§8).

### Riesgos

Cualquier subida real a DEV antes de terminar crea un asset seleccionable; el reloj de B corre desde que se
reserva, no desde el cierre de la pestaña (actividad = `updated_at`); A (≈ 15 h) sigue protegido solo por el corte
nuevo; el JSON del tick no se persiste.

### Asset B creado (SELECT 14:51:52Z)

- **B = `c08496fa-ee49-4f2e-b494-d7e685e49623`** · community/video · `reserved` · multipart presente · 92 174 109 B.
- **Creado: 2026-10-10 14:50:58.80001Z** (`updated_at` igual). **Primera elegibilidad: 2026-10-11 14:50:58.8Z** → el primer
  tick natural es el de **2026-10-11 14:55:00Z**.
- Sin vínculos: 0 filas en `community_post_media` (no está asociado a ninguna publicación ni texto).
- Único asset posterior al corte (`14:47:55Z`); política `false · 24:00:00 · batch_limit 1`, `last_run_at` NULL;
  0 `deleting`; Asset A `reserved`. Nota: B tiene el mismo tamaño que A (mismo archivo sintético de prueba).
- Pendiente: C entre 2026-10-11 13:50Z y 14:40Z (B+23 h … B+23 h 50 min).

## 15. Ejecución remota en DEV con `min_age = 4 horas` (2026-10-10, 22:03–22:05Z)

### 15.1 Cambio de umbral
- Solo cambió el valor de la política DEV (`update media_abandon_policy set min_age = interval '4 hours'`, 21:57Z, con
  guardas, 1 fila, `enabled=false`). La migración `20261028` NO se modificó: acepta de 2 h a 30 d (CHECK) y la función usa
  `greatest(min_age, 2 h)`; el valor por defecto de la tabla sigue siendo 24 h. Sin cambios de código.
- Elegibilidad (sin cambios): estado pendiente (`reserved/uploaded/verifying/processing`), dominio community/cosplay,
  `created_at >= protected_before` y `created_at` y `updated_at` ≤ ahora − `min_age`, revalidado bajo lock.
  Una subida con actividad reciente (`updated_at`) no se marca por superar 4 h desde su creación. Las publicaciones solo
  adjuntan assets `ready`, que el marcador nunca toca. Las URLs de partes caducan a los 30 min, muy por debajo del
  mínimo duro de 2 h.
- Tests locales nuevos (`media-abandoned-reservations.test.ts`, 4 casos): CHECK/función con 4 h, A protegido + B
  abandonado + C reciente + D con actividad, límite exacto 4 h, ready/failed intactos.

### 15.2 Escenario
| Asset | Papel | Estado previo |
|---|---|---|
| A `a9c4e223…` | protegido por `protected_before` (2026-10-10 14:47:55Z) | `reserved`, multipart |
| B `c08496fa…` | abandonado (creado 14:50:58Z, ≈ 7 h sin actividad) | `reserved`, multipart |
| C1 `f62735d5…` | reciente (creado 22:00:13Z) | `reserved`, multipart |
| C2 `34671246…` | reciente (creado 22:00:35Z) | `reserved`, multipart |
C1 y C2 son dos reservas de la misma cuenta de prueba (se previó un solo C). SELECT previo (22:03:42Z): único candidato B;
0 `deleting`; 157 assets; cron activo.

### 15.3 Resultados reales
- Activación `enabled=true` a las 22:03:53Z (1 fila, con guardas) y desactivación inmediata tras el único tick natural.
- Tick de las 22:05:00Z: `last_candidates=1`, `last_marked=1`, `last_skipped=0`, `last_error_class=NULL`, 14 ms.
- GC (`net._http_response` id 15, HTTP 200): `claimed=1, finalized=1, alreadyGone=0, failed=0, stale=0, blocked=0`.
- B eliminado (0 filas); total de assets 157 → 156; 0 `deleting`; huella del resto de assets idéntica a la previa
  (`5ab07710…`); A, C1 y C2 siguen `reserved` con `updated_at` sin cambios.
- Política final: `enabled=false`, `min_age=04:00:00`, `batch_limit=1`, `protected_before` sin cambios.
- No se ejecutó GC manual ni se tocó ningún asset a mano; cron sin cambios (único job, 5 min, `succeeded`).

### 15.4 Verificación directa de R2 — FAVORABLE (2026-10-10 22:10Z)
`scripts/r2-multipart-check-dev.mjs` (solo `ListMultipartUploads` y `ListParts`; no imprime credenciales ni el UploadId
completo) sobre el bucket privado DEV, configuración leída del `.env.local` habitual del proyecto. Exit 0 en ambas:
- `--asset c08496fa-ee49-4f2e-b494-d7e685e49623` (B): **`NO_OPEN_SESSION`** → B ya no tiene sesión multipart abierta.
- Sin `--asset` (todo `staging/community/`): exactamente tres sesiones abiertas, todas esperadas:
  A `a9c4e223…` (iniciada 2026-10-09 23:06:40Z, 7 partes, 58 720 256 B), C1 `f62735d5…` (22:00:14Z, 1 parte,
  8 388 608 B) y C2 `34671246…` (22:00:35Z, 1 parte, 8 388 608 B). B no figura.
- Alcance de la prueba: B nunca se completó, así que la ausencia de sesión abierta equivale a «abortada». Cubre la
  sesión multipart; no inspecciona otros prefijos ni objetos `ready`. El cierre queda respaldado además por la respuesta
  del GC (`claimed=1, finalized=1, failed=0`). Sin escrituras: ni R2, ni Supabase, ni la política (sigue `enabled=false`).

### 15.5 Límites que siguen vigentes
- Concurrencia real con dos conexiones sin probar (PGlite usa una).
- El JSON del tick no se persiste (la evidencia son `policy.last_*` y la respuesta del GC).
- C1 y C2 pasan a ser elegibles desde 2026-10-11 02:00Z si la política se activara de nuevo: no reutilizarlos como
  control y no activar R7 sin una nueva autorización.
- Producción: R7 y su migración NO están aplicados (ver auditoría maestra).
