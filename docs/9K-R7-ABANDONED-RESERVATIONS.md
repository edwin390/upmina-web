# 9K-R7 · Detección automática de reservas abandonadas (IMPLEMENTADA EN LOCAL · NO APLICADA · NO ACTIVADA)

## Qué hace
Un paso nuevo del cron EXISTENTE (`community-media-purge-tick`, cada 5 min) marca `deleting` las
reservas pendientes abandonadas. El GC existente (con la protección multipart de 20261027) hace el
resto: aborta la sesión con el `uploadId` guardado, borra objetos y finaliza. **No hay jobs nuevos ni
cambios en el backend/Vercel.** La migración se entrega con la detección **desactivada**
(`media_abandon_policy.enabled = false`): aplicarla no cambia ningún comportamiento.

## Auditoría (solo lectura)
| Tema | Hallazgo |
|---|---|
| `media_abandoned_sweep` (20261026) | `security definer`, owner `postgres`, ejecutable por `service_role`, **sin corte histórico**; mínimos duros ready 6 h / pendiente 2 h / failed 6 h; límite 1–200; revalidación bajo lock. No está programada. **Se deja intacta y sin usar** |
| Cron | 1 job: `select public.community_media_purge_tick();` → purga lógica → `media_gc_backlog()` → POST firmado a `/api/media/gc` solo si hay `deleting` elegibles |
| Estados | `reserved → uploaded → verifying → processing → ready`; `failed → uploaded` (reintento); cualquiera → `deleting`; `deleting` terminal |
| Reloj de actividad | `updated_at`; el trigger `media_assets_touch_activity` lo renueva en **cada cambio de estado**. No hay heartbeat/lease durante la subida (el estado no cambia mientras se suben bytes) |
| ¿Abandono o subida en curso? | Las URLs prefirmadas caducan a los **15 min** (PUT único) y **30 min** (partes) desde la reserva y se validan al empezar cada petición. Una subida legítima solo puede escribir ≈ 30 min + lo que tarde la última parte; `uploaded/verifying/processing` ocurren dentro de una sola petición de `/api/media/complete`. Por eso 2 h de inactividad (mínimo duro) ya implica que no hay subida posible, y 24 h es un margen muy conservador. **24 h desde `created_at` no es el criterio**: es `updated_at` ≥ umbral y `created_at` ≥ umbral |
| `ready` / `failed` | Fuera del barrido automático: un `ready` sin publicar puede estar en un editor abierto; un `failed` admite reintento del usuario |
| Permisos mínimos | Marcador y tabla solo para `postgres` (el cron corre como `postgres`); `anon`, `authenticated` y `service_role` sin acceso |

### Carreras (reserve / complete / abort / sweep / GC)
- **reserve vs marcador:** un asset nuevo tiene edad 0 → no es candidato.
- **complete vs marcador:** `complete` mueve `reserved → uploaded` con UPDATE condicionado al estado; si el marcador gana, el UPDATE de `complete` afecta 0 filas y falla (409/estado no válido); si `complete` gana, `updated_at` se renueva y la revalidación bajo lock lo omite.
- **abort vs marcador:** `abort` bloquea con UPDATE condicionado; sobre un `deleting` solo reintenta la limpieza.
- **marcador vs marcador/tick:** advisory lock del tick + lock de la fila de política + `FOR UPDATE SKIP LOCKED`.
- **GC vs marcador:** el GC solo actúa sobre `deleting`; el marcador nunca toca `purge_*`.
- **multipart:** el marcador solo cambia `status`; `multipart_upload_id` y `private_original_key` quedan intactos y la barrera `BEFORE DELETE` + `finalize` impiden perderlos antes del aborto confirmado.

### Inventario DEV (SELECT, 2026-10-09 ~22:47Z; sin modificar nada)
- Pendientes (`reserved/uploaded/verifying/processing`): **5**, todos `reserved`: `5073059a` (cosplay, 27-sep), `8d94a817` (community, 01-oct) y los tres huérfanos `9bcaf8c0`, `bff7445d`, `ce25dadb` (9-oct 18:51–18:53Z). Ninguno con multipart.
- Asset más reciente de DEV: 2026-10-09 19:51Z → el corte `2026-10-09 23:00Z` los cubre a todos, incluidos los ~38 candidatos históricos y los huérfanos.
- Antes del corte: community failed 4 / ready 52 / reserved 4; cosplay failed 5 / ready 87 / reserved 1.
- Elegibles con el diseño nuevo (corte + 2 h) ahora mismo: **0**. Sin corte serían 5 (los reservados) — el corte es lo que los protege.

## Diseño (migración `20261028120000_media_abandoned_reservations_auto.sql`)
1. **`media_abandon_policy`** (fila única, RLS activada y sin policies, sin acceso para `anon/authenticated/service_role`): `enabled` (por defecto **false**), `min_age` (24 h; CHECK 2 h–30 d), `batch_limit` (20; CHECK 1–100), `protected_before` (por defecto y **suelo CHECK** `2026-10-09 23:00:00+00`: solo puede subirse) y métricas `last_run_at, last_candidates, last_marked, last_skipped, last_duration_ms, last_error_class`.
2. **`media_abandoned_reservations_mark(p_now default null)`** (`security definer`, owner/ejecutor `postgres`): lee la política (lock), sale si está desactivada, selecciona pendientes con `created_at >= protected_before`, `created_at` y `updated_at` ≤ ahora − `min_age` (≥ 2 h), `ORDER BY updated_at`, `LIMIT batch_limit`, `FOR UPDATE SKIP LOCKED`; **revalida bajo lock** y solo entonces `status = 'deleting'`. Un error se contiene (subtransacción), se registra solo como clase y no afecta a nada más. `p_now` existe para pruebas deterministas y solo lo puede pasar `postgres`.
3. **`community_media_purge_tick()`** idéntico a 20261021 más el paso 1b (aislado con su propio `begin/exception`), ejecutado **antes** de consultar el backlog: lo marcado se despierta en el mismo tick. El comando del cron no cambia.
4. **Métricas:** respuesta del tick (`abandoned: {status, candidates, marked, skipped, durationMs}`), fila de política (última ejecución), `cron.job_run_details`, `net._http_response` (`claimed/finalized/failed`) y logs de `/api/media/gc`.

## Archivos locales (sin commit)
- `supabase/migrations/20261028120000_media_abandoned_reservations_auto.sql` (nuevo)
- `src/lib/media-abandoned-reservations.test.ts` (nuevo, 24 tests PGlite)
- `docs/9K-R7-ABANDONED-RESERVATIONS.md` (este documento)

Sin cambios en `src/` de producción, `api/`, scripts ni en el backend desplegado.

## Pruebas (resultados)
- `media-abandoned-reservations.test.ts`: **24/24** (SQL real). Cubren: política por defecto y CHECK (2 h, lote, fila única, suelo del corte), permisos, desactivado, umbral exacto y por debajo, todos los estados pendientes, cosplay, `ready/failed/deleting` intactos, exclusión histórica (huérfanos 18:51–18:53Z, 27-sep, 22:59:59Z; elegible justo en el corte), actividad reciente, renovación por el trigger, límite por lote con reanudación, idempotencia, métricas, contención de errores con rollback del lote, tick (desactivado, activado y mismo tick, aislamiento ante fallo), integración con el GC multipart (aborto con id exacto y finalización; fallo de R2 conserva fila e id; solo se procesan los marcados), estructura de la migración (sin jobs nuevos, sin llamar al barrido general) y el supuesto de TTL < 2 h.
- Mutaciones comprobadas: quitar el filtro `protected_before` o el de `updated_at` hace fallar las pruebas.
- Suite completa: **232 archivos / 6925 tests** OK (con PGlite); `tsc -b`, ESLint, Prettier y `npm run build` OK.

## Plan exacto de activación y validación en DEV (NADA ejecutado)
Cada paso necesita autorización explícita.
1. **Previo (SELECT):** tabla `media_abandon_policy` inexistente; 5 pendientes protegidos; huella de assets `bddc979f…`; backlog a cero; 1 cron.
2. **Migración inerte:** `db push --linked --dry-run` (debe listar solo `20261028120000…`) y `db push --linked`. Verificar: tabla (1 fila, `enabled=false`, 24 h, 20, corte 23:00Z), ACL (solo postgres), función de marcado, tick reemplazado (el comando del cron sigue siendo `select public.community_media_purge_tick();`), un tick natural con `abandoned.status=disabled`, datos idénticos. Sin deploy de backend.
3. **Validación (~2 h 15 min, requiere assets creados DESPUÉS del corte):**
   - T0: el propietario sube un MP4 grande por Chrome y cierra la pestaña con ≥ 1 parte → **reserva abandonada X1** (confirmar con `r2-multipart-check-dev.mjs`: `OPEN_SESSION parts ≥ 1`).
   - T0 + 1 h 50 min: el propietario inicia otra subida y la deja **en curso/recién reservada X2** (edad < 2 h).
   - T0 + 2 h 05 min (autorizado): `update media_abandon_policy set enabled = true, min_age = interval '2 hours';` (1 fila).
   - Siguiente tick natural: esperado `abandoned: ran, marked 1` (X1) → mismo tick `gc_enqueued` → siguiente respuesta `claimed 1, finalized 1`. X1 desaparece, su sesión R2 pasa a `NO_OPEN_SESSION` (script del propietario). X2 sigue `reserved`.
   - Comprobar: los 5 pendientes históricos, los ~38 candidatos y el resto de assets intactos (huella), `policy.last_*` coherentes, sin errores en logs.
   - Cierre: `update media_abandon_policy set min_age = interval '24 hours';` y decidir si `enabled` queda en true.
   - Durante la ventana con 2 h **no deben crearse otros assets de prueba** que pudieran ser barridos.
4. **Rollback (inmediato, sin deploy):** `update media_abandon_policy set enabled = false;`. Rollback completo: una migración nueva que elimine la tabla y la función y restaure el tick de `20261021120000` (sin tocar la migración aplicada). Lo ya marcado `deleting` sigue su curso en el GC (es lo que se quería borrar).

## Riesgos pendientes y condiciones que impedirían activar
- **Condiciones de bloqueo:** la tabla de política no existe / `enabled` ya true sin autorización; un asset pendiente creado después del corte que no sea de la prueba; el GC con `failed`/`retrying` > 0 o `attemptsAtLeast10`; el alias DEV no está en un backend con la protección multipart (`dpl_6AGTMU5…` o posterior); cualquier discrepancia en la huella de assets.
- **Los históricos NO se limpian con esto:** los 5 pendientes antiguos y los ~38 candidatos (ready sin publicar, failed) quedan protegidos para siempre por el corte. Su limpieza es una decisión aparte (propuesta: lista explícita de IDs).
- `media_abandoned_sweep` sigue invocable por `service_role` y **sin corte histórico**: no programarla ni ejecutarla; valorar retirarle el permiso en una migración futura.
- El corte es una fecha fija pensada para DEV (todo asset anterior queda protegido); no usar tal cual en Production sin revisar su valor.
- `ready` sin publicar y `failed` no se limpian automáticamente (decisión de producto: ¿72 h?).
- Las métricas de la política solo guardan la última ejecución; el histórico está en `cron.job_run_details`, pg_net y los logs.
- Si algún día se alargan los TTL de las URLs prefirmadas por encima de 1 h, hay que revisar el mínimo de 2 h (hay un test que lo vigila).

## Aplicación de la migración inerte en Supabase DEV (2026-10-09, 22:52:58Z)
Solo `rkqeqbqwdswhpzwqptac`; migración `20261028120000_media_abandoned_reservations_auto.sql`. **La política NO se activó**, no se redujo `min_age`, no se tocó ningún asset, no se ejecutó ningún barrido/GC/abort/cron manual, sin R2, sin deploy.

**Antes de aplicar:** `db push --dry-run` listó únicamente `20261028120000_media_abandoned_reservations_auto.sql` (41 migraciones aplicadas, última `20261027120000`). Las comprobaciones de comportamiento (valores por defecto, CHECK del corte, filtros, límite por lote, permisos, aislamiento del tick, cron sin cambios) se verificaron con las 99 pruebas locales de los tres archivos relacionados (`media-abandoned-reservations`, `media-purge-scheduler-contract`, `media-abandoned-cleanup`) y la revisión de la migración. Estado remoto previo: tabla inexistente, 153 assets (0 `deleting`, 0 multipart), huella `bddc979f…`, 5 pendientes históricos, backlog a cero, un único cron.

**Resultado (SELECT):**
| Comprobación | Valor |
|---|---|
| Migraciones | 42 · última `20261028120000` |
| `media_abandon_policy` | 1 fila: `enabled=false`, `min_age=24:00:00`, `batch_limit=20`, `protected_before=2026-10-09 23:00:00+00`, métricas `last_*` a NULL |
| CHECK | `min_age` 2 h–30 d, `batch_limit` 1–100, `singleton`, `last_error_class` acotada y **`media_abandon_policy_cutoff_floor`: `protected_before >= 2026-10-09 23:00:00+00`** (impide retroceder el corte) |
| Permisos de la tabla | ACL solo `postgres=arwdDxtm/postgres`; RLS activada, 0 policies → `anon/authenticated/service_role` sin acceso |
| `media_abandoned_reservations_mark(timestamptz)` | owner `postgres`, `security definer`, `search_path=pg_catalog, public`, ACL solo `postgres` |
| `community_media_purge_tick()` | reemplazado; owner `postgres`, `security definer`, mismo `search_path`, ACL solo `postgres` |
| Cron | 1 job (`community-media-purge-tick`, `*/5 * * * *`, activo, comando `select public.community_media_purge_tick();`): ni duplicado ni cambiado |

**Primeros ticks naturales con la función nueva:** 22:55:00.070 y 23:00:00.074 (`succeeded`). Tras el 23:00: `media_gc_backlog` a cero, `net._http_response` sin respuestas nuevas (nada que despertar), política con `enabled=false`, `last_run_at=NULL`, `last_error_class=NULL`; 153 assets, 0 `deleting`, 0 con `multipart_upload_id`, **huella de assets idéntica (`bddc979f…`)**, ningún asset creado desde las 22:50Z (ninguna sesión multipart nueva), los 5 pendientes históricos (los tres huérfanos, `5073059a`, `8d94a817`) en `reserved`.

**Límite de la evidencia:** `cron.job_run_details` solo guarda «1 row»; el JSON que devuelve el tick (`abandoned.status = "disabled"`) no se almacena, y los logs de Postgres no están disponibles con la herramienta usada. Que el barrido informó `disabled` se infiere de: tick `succeeded` con la función nueva, `last_run_at` sin escribir (el marcador sale antes de escribir cuando está desactivado), ningún cambio en los datos y la prueba local del tick (`abandoned.status = disabled`). No se ha comprobado «GC funcionando normalmente» con un `deleting` real tras este cambio: el último caso real (S5) fue antes de la migración y el backlog está vacío; se comprobará al activar.

## Preparación de la validación automática en DEV (2026-10-09, 23:04Z) — solo lectura
**Precondiciones verificadas (SELECT):** política `enabled=false · 24:00:00 · 20 · 2026-10-09 23:00:00+00`, `last_run_at` NULL; cron único activo (ticks 22:45–23:00 `succeeded`); **0 assets creados desde el corte** (0 pendientes posteriores); 153 assets, 0 `deleting`, 0 con multipart, huella `bddc979f…`; backlog a cero; `community_asset_gc_multipart_cleared` y la barrera `BEFORE DELETE` presentes; el alias sigue en `dpl_6AGTMU5…` (Ready) y los hashes de `media-gc.ts` y `cosplay-media-lifecycle.ts` desplegados coinciden con el paquete con protección multipart (`/api/media/gc` → 405 a GET).

**Consulta de elegibilidad (min_age = 2 h, solo lectura):** `docs/9K-R7-eligibility-simulation.sql`. Ahora devuelve 5 filas, todas `PROTEGIDO_HISTORICO (nunca)` (`5073059a`, `8d94a817`, `9bcaf8c0`, `bff7445d`, `ce25dadb`) y ninguna `ELEGIBLE`.

**Cómo distinguir A y B:** ambos serán los únicos assets con `created_at >= 2026-10-09 23:00Z`. A es el primero creado (su clave `staging/community/<id>/original.mp4` la imprime el script de R2 con `initiated`), B el segundo (≥ ~1 h 50 min después). Se recomienda usar dos archivos de distinto tamaño para que `source_bytes` también los distinga.

## Asset A confirmado (SELECT, 2026-10-09 23:10Z)
`a9c4e223-7d01-4bf2-a564-a2f17c8b18a9` · community/video · `reserved` · `private_original_key` exactamente `staging/community/a9c4e223-…/original.mp4` · 92 174 109 B · `multipart_upload_id` presente (longitud 343, huella `d3bfdafc9e86`) · sin enlaces · sin claim/intentos · **`created_at = updated_at = 2026-10-09 23:06:39.885064+00`** (posterior al corte). R2 (propietario): `OPEN_SESSION`, `initiated 23:06:40.110Z`, `parts=2`, `bytes=16 777 216`.
Política: `false · 24:00:00 · 20 · 2026-10-09 23:00:00+00 · last_run_at NULL`. Único asset posterior al corte: A. Resto de assets: huella `bddc979f…`, 154 totales, 0 `deleting`, 1 con multipart (A). Los 5 pendientes históricos: `PROTEGIDO_HISTORICO (nunca)`.
**Elegibilidad con `min_age = 2 h`:** `max(created_at, updated_at) + 2 h = 2026-10-10 01:06:39.885Z`. El marcador exige `created_at ≤ ahora − 2 h` y `updated_at ≤ ahora − 2 h` con `ahora = clock_timestamp()` del tick; el tick de 01:05:00 queda por debajo (23:05:00 < 23:06:39.9), así que **el primer tick que lo marcaría es el de 2026-10-10 01:10:00Z**. Con 24 h sería 2026-10-11 ~23:10Z.
