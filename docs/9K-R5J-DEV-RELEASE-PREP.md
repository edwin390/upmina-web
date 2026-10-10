# 9K-R5-J · Preparación de integración y despliegue controlado en DEV (SOLO PREPARACIÓN · nada desplegado · nada aplicado)

Fecha de las comprobaciones: 2026-10-10 ≈ 01:40Z. Proyectos DEV (de la configuración existente, no inventados):
Supabase `rkqeqbqwdswhpzwqptac` (enlazado en `supabase/.temp/project-ref`), Vercel `upmina-web-testing`
(`prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP`, `team_co8xhbacSFWYpnVU7iDOjszT`, scope `edwin-9cad`; en `.vercel/project.json`
del paquete). Producción no se tocó en ningún momento.

## 1. Estado de R7 — **RISK** (no completada; sin interferencia con el despliegue)

Verificado por documentación local y SELECT en DEV (solo lectura):

| Hecho                                                                                                             | Valor                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Documentación                                                                                                     | `docs/9K-R7-ABANDONED-RESERVATIONS.md`: migración 20261028 aplicada **inerte** el 2026-10-09; la validación con Asset A/B figura como plan, **no como completada** |
| `media_abandon_policy`                                                                                            | `enabled=false`, `min_age=24:00:00`, `batch_limit=20`, `protected_before=2026-10-09 23:00Z`, todos los `last_*` NULL (el barrido nunca se ha ejecutado)            |
| Asset A (`a9c4e223…`)                                                                                             | sigue `reserved` (creado 23:06Z; único asset posterior al corte)                                                                                                   |
| Asset B                                                                                                           | **no existe** (ningún otro asset posterior al corte); la ventana planificada (≈ 01:00–01:09Z) ya pasó                                                              |
| Cron                                                                                                              | 1 job activo `community-media-purge-tick` (`*/5 * * * *`); 0 assets `deleting`                                                                                     |
| Prueba R7                                                                                                         | **pendiente**; no puedo afirmar que terminara. No se activó la política                                                                                            |
| Conclusión: R7 está **inactiva** (`enabled=false`), así que ni las migraciones 29–31 ni el despliegue la afectan: |
| ninguna toca `media_assets`, GC, cron ni la política. Riesgos: (a) si más adelante se activa la política con      |
| `min_age=2h`, Asset A (ya con >2 h) sería elegible de inmediato; (b) no deben crearse assets nuevos mientras      |
| una prueba R7 esté pendiente. **Este paquete no modifica nada de R7**; la decisión sobre cuándo retomar R7 es     |
| tuya y es independiente del despliegue de moderación. Si prefieres no mezclar, retomar R7 después.                |

## 2. Inventario exacto de cambios

Inspección real: `git status` (≈ 70 modificados y ≈ 90 sin seguimiento) + cierre de imports desde
`api/admin/[action].ts` (48 archivos) y `AdminModerationPage.tsx` (37 archivos), cruzado con el estado de git.

### 2.1 Obligatorios para moderación (entran en el paquete)

- Backend: `api/admin/[action].ts` (solo añade 2 rutas de strike), `moderation-strike-contract.ts`,
  `moderation-strike-handlers.ts`, `moderation-case-contract.ts`, `moderation-case-parser.ts`,
  `moderation-case-handlers.ts` (todo en `src/lib/`).
- Frontend: `moderation-client.ts`, `pages/admin/AdminModerationPage.tsx` + 6 componentes nuevos
  (`ModerationAuditList`, `ModerationMedia`, `ModerationPendingCounter`, `ModerationQueueFilters`,
  `ModerationStrikePanel`, `ModerationStrikeUnavailable`), `i18n/locales/{es,en,de}/moderation.json`.
- Tests asociados (12 archivos) y `vite.config.ts` (solo el tope de 6 workers de R5-I).
- Migraciones: ver §4.

### 2.2 Dependencias compartidas (construidas desde HEAD + SOLO el cambio de moderación)

- `src/i18n/messages.ts` y `messages-parity.test.ts`: el árbol local mezcla tres namespaces nuevos
  (`auth`, `secrets`, `moderation`). El paquete parte de HEAD y añade únicamente `moderation`.
- `src/lib/moderation-handlers.test.ts`: contiene tests de R5-G/H **y** de AUTH-2 (cuenta incompleta). Al
  paquete va con los de R5 y sin el bloque AUTH-2.
- `vite.config.ts`: HEAD + solo `poolOptions` (test).

### 2.3 Ajenos a moderación (NO entran; presentes en el árbol local)

AUTH/cuenta incompleta (`account-state.ts`, `account-incomplete*`, `auth-context`, Login/Signup/Verify*,
`moderation-handlers.ts` hunks AUTH-2, hunks AUTH-2 de `community-like-handlers.ts` y
`community-post-handlers.ts`), Easter eggs 9N (`src/secrets/`, `App.tsx`, `Footer.tsx`, `AmbientBackground`,
`vite-env.d.ts`, `.env.example`, `public/images/echidna.gif` borrado), home/estilos (`HomePage`, `Header`,
`globals.css`, secciones sociales), y todo R2/R6: `r2-client.ts` (checksum, **excluido a propósito**),
`media-gc.ts`, `cosplay-media-lifecycle.ts`, `media-handlers.ts`, `useMediaUpload.ts`, `media-client.ts`
(R6 ya desplegado en DEV desde el paquete anterior; sin diferencias en este paquete), scripts `r2-*`,
`workers/media-delivery`, `AGENTS.md`, `.agents/`, `evidence/`, otros docs.

### 2.4 Decisiones que quedan para ti (ambigüedad documentada; NO incluidas)

1. **Mapeo de `author_restricted` en escritura** (`community-restriction.ts` + 3 hunks en
   `community-post-handlers.ts`, mezclados con hunks AUTH-2 en el mismo archivo). Sin ello, el autor con
   strike que intente guardar/ordenar/quitar medios en DEV recibirá un error genérico (500/422) en vez del aviso
   de restricción. La **base de datos sí lo bloquea** (migración 24 ya aplicada). No afecta a la validación de
   moderación (aplicar/revocar), pero sí al UX del autor sancionado. Para incluirlo hay que separar hunks
   (no se hizo por la regla de no incluir archivos mixtos).
2. **Mapeo AUTH-2** (migración 25 ya aplicada en DEV; el backend desplegado no lo mapea). Estado actual de DEV,
   no cambia con este paquete.
3. Avisos de restricción en frontend (`CommunityRestrictionNotice`, etc.): ajenos al panel de moderación.

### 2.5 Configuraciones afectadas

Ninguna variable de entorno nueva, ni `vercel.json`, ni `package.json`/lock, ni cron, ni R2. El aislamiento
se verificó con un diff archivo a archivo contra el paquete DEV actualmente desplegado: cambian solo los
12 archivos de moderación listados (+ tests/migraciones/docs nuevos). **Cero archivos de almacenamiento o
infraestructura** (`r2-client`, `media-*`, `cosplay-media-lifecycle`, `workers/`, `vercel.json`, `package*`).

## 3. Paquete aislado — **PASS con avisos**

Ruta: `C:\Dev\upmina-web-r5-deploy` (generado por script desde el paquete DEV desplegado
`C:\Dev\upmina-web-r2-deploy` = HEAD `6a2e441` + R2/R6; el árbol original no se modificó; sin commit ni push).

- Contiene `.vercel/project.json` del proyecto DEV (ya existente en el paquete anterior). Sin `.env*` reales
  (solo `.env.example`), sin `node_modules` propio: es una **unión de directorio** al `node_modules` del
  paquete anterior (no se reinstaló nada).
- Normalizado a LF: el paquete anterior tenía CRLF y rompía tests estáticos de migraciones (hallazgo, §6).
- Escaneo de secretos (JWT, PEM, `sbp_`, `sk_live`, AWS): solo coincidencias en regex de tests existentes
  (`expect(sql).not.toMatch(/…sk_live…/)`); ningún secreto.
- `tsconfig.*.tsbuildinfo` generados por `tsc -b` eliminados del paquete.
- Avisos: ver §6 (tests no herméticos, flakes ajenos).

## 4. Migraciones (orden completo y estado en DEV)

Historial remoto verificado con `list_migrations` (SELECT): **42 migraciones, última `20261028120000`**. El
`db push --linked --dry-run` (sin escritura) lista **exactamente** las 3 pendientes:
`20261029…`, `20261030…`, `20261031…`. (Nota: el CLI inicializa un rol temporal de login para conectar, igual
que en los dry-runs anteriores; no escribe en el esquema.)

| Id                                                                                                              | Propósito                                                 | Dependencias          | Estado en DEV                             | Compat. con backend DEPLOYED actual            | Riesgo                                           | Reversión       |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------- | ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------ | --------------- |
| 20261023 strikes_foundation                                                                                     | tabla/RPC de strikes                                      | 20261015 (decisiones) | Aplicada (RPC y tabla presentes; 0 filas) | No usada por el backend actual                 | —                                                | n/a             |
| 20261024 strike_write_enforcement                                                                               | bloqueo de escrituras del autor sancionado                | 23                    | Aplicada                                  | Backend actual sin mapeo de error (ver 2.4)    | Solo si hay strikes                              | n/a             |
| 20261025 account_complete_authority                                                                             | cuenta completa                                           | —                     | Aplicada                                  | Backend actual sin mapeo                       | —                                                | n/a             |
| 20261026/27/28                                                                                                  | R6/R7 (medios)                                            | —                     | Aplicadas (R7 inerte)                     | Compatible                                     | —                                                | n/a             |
| **20261029** moderation_audit_strike_events                                                                     | eventos de strike en la auditoría del caso (`cycle_read`) | 22 (última def.), 23  | **Pendiente**                             | Segura: el parser antiguo ignora `strikeLevel` | Bajo (`create or replace`)                       | Rollback §9     |
| **20261030** moderation_queue_filters                                                                           | `cases_read` con 5 params nuevos (DEFAULT)                | 13, 29 indiferente    | **Pendiente**                             | Segura: llamada de 5 args sigue válida         | Medio (`drop`+`create` de la función de la cola) | Rollback §9     |
| **20261031** moderation_pending_count                                                                           | contador agregado                                         | roles                 | **Pendiente**                             | Segura (función nueva sin uso)                 | Bajo                                             | `drop function` |
| **Línea base verificada:** `md5(prosrc)` en DEV de `community_moderation_cycle_read` =                          |
| `d9e18810bfdba74530bac73266c3cb1e` (= definición de 20261022) y de `community_moderation_cases_read` (5 args) = |
| `7305cbd15cb95e901193646a05477806` (= 20261013), `owner=postgres`, ACL solo `postgres`/`service_role`. Las      |
| migraciones 29–31 parten exactamente de esas definiciones.                                                      |
| Pruebas locales (PGlite): `moderation-migrations-chain` (5), `moderation-audit-strike-events` (7),              |
| `moderation-queue-filters-sql` (24), `moderation-pending-count-sql` (10) y `moderation-rollback-r5j` (3: el     |
| rollback devuelve los `md5(prosrc)` de DEV, es idempotente y deja la cola antigua operativa con los mismos      |
| permisos). **Límite:** la cadena se probó con las migraciones 7–24 + 29–31 (las 25–28 no interactúan con estas  |
| funciones); no se comparó el texto de 23–28 con lo aplicado en DEV (solo versión/nombre).                       |

## 5. Pruebas ejecutadas en el paquete

- `tsc -b` OK · ESLint (`src api vite.config.ts`, 0 warnings) OK · Prettier (archivos de moderación) OK ·
  `npm run build` OK.
- Suite completa del paquete: **205 archivos / 6450 tests**, 0 errores de worker, 0 omitidos, en 2 ejecuciones
  consecutivas finales (y 2 ejecuciones previas equivalentes). Otras dos ejecuciones del paquete tuvieron 1–2
  fallos esporádicos ajenos a moderación (ver §6); por eso **PASS con RISK**, no PASS limpio.
- Rutas administrativas protegidas (comprobado en código y tests): `moderation-cases` (lectura, contador y
  detalle) y `moderation-strike-apply` llaman a `requireCapability("moderation")` = JWT verificado + rol actual +
  capacidad + MFA reciente; `moderation-strike-revoke` añade developer/admin; el contador se sirve DESPUÉS de esa
  comprobación. Cubierto por `moderation-handlers.test.ts` y `moderation-strike-api.test.ts` (401/403, MFA vencida,
  roles).
- Sin cambios de almacenamiento: diff vs paquete desplegado (§2.5).

## 6. Hallazgos y riesgos

1. **Tests no herméticos (nuevo):** 16 archivos fallan sin `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (en el
   árbol principal pasan porque Vite carga `.env.local`). En el paquete (sin `.env`) se ejecutan con valores
   **sintéticos** (`https://synthetic.invalid`, `synthetic-anon`) por variable de entorno. Con
   `SUPABASE_SERVICE_ROLE_KEY` definida, `twitch-reliability` falla (por eso NO se define). Recomendación futura:
   fijar esas variables en `setupTests.ts`.
2. **Fines de línea:** el paquete anterior tenía CRLF y rompía tests estáticos de migraciones; el nuevo está en LF.
3. **Flakes ajenos observados en el paquete:** `AccountPage.profile-edit` (relectura), `workers/media-delivery ›
tampered capability is rejected` (probablemente aleatoriedad de la firma). En el árbol principal:
   `CosplayEditorDialog.mfa` (foco). Ninguno es de moderación; no se tocaron.
4. **R7 sin completar** (§1) y Asset A en `reserved`: no interviene en el despliegue.
5. **Backend desplegado sin mapeo de `author_restricted`/AUTH-2** (§2.4): preexistente, no empeora.
6. **Panel autenticado sin validar en navegador** (BLOCKED en R5-I): la validación en DEV es la primera vez.
7. **Pérdida de datos:** ninguna migración borra datos; el rollback solo restaura funciones.
8. El alias de frontend/backend: el proyecto sirve SPA y `/api` en el mismo despliegue (rewrites en
   `vercel.json`). El alias usado hasta ahora es `upmina-testing-backend.vercel.app`; **no verifiqué** (no es
   lectura de Supabase) si existe otro alias distinto para el frontend: comprobar con `vercel alias ls` en la
   fase de comprobaciones previas.

## 7. Plan de despliegue DEV (NADA ejecutado; cada paso requiere tu autorización)

**0. Condiciones previas (todas deben cumplirse; si no, detener):**

- R7: `media_abandon_policy.enabled=false` (o decisión explícita tuya), 0 `deleting`, GC sin `failed/retrying`.
- Árbol principal sin cambios inesperados en los 12 archivos de §2.1 desde esta preparación (recalcular el diff
  del paquete o regenerarlo con `build_r5_pkg.py`).
- Paquete: repetir `tsc`, ESLint, build y suite (variables sintéticas, §6.1) y confirmar 0 omitidos.
- Vercel (lectura): desplegamiento activo y alias actuales del proyecto DEV; anotar sus ids para el rollback.
  Desde `C:\Dev\upmina-web-r5-deploy` (nunca desde la raíz del repo: ya hubo un `env ls` que consultó Producción).
  **1. Respaldo / recuperación SQL:** el rollback `docs/9K-R5J-rollback.sql` ya está generado y probado; guardar
  también `md5(prosrc)` actual de las 2 funciones (deben coincidir con §4) y el listado de migraciones (42).
  **2. Orden:** (a) migraciones, (b) backend+frontend (un solo despliegue Preview), (c) alias. Razón: SQL nuevo con
  backend antiguo es seguro; backend nuevo con SQL antiguo da errores en filtros/contador.
  **3. Migraciones:** `npx supabase@2.120.0 db push --linked --dry-run` (debe listar solo 29–31) → `db push --linked`.
  Verificar con SELECT: 45 migraciones (última 20261031), `md5(prosrc)` nuevos distintos de la línea base, una
  firma por función, ACL (`anon`/`authenticated` sin EXECUTE), `select community_moderation_pending_count(<id>)` no se
  ejecuta sin rol (no probar con datos reales de escritura), cron intacto (1 job).
  **4. Despliegue:** desde el paquete,
  `VERCEL_ORG_ID=team_co8xhbacSFWYpnVU7iDOjszT VERCEL_PROJECT_ID=prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP npx vercel@59.19.1 deploy --scope edwin-9cad --yes`
  (Preview, sin `--prod`). Esperar READY; comprobar logs sin errores.
  **5. Alias:** mover SOLO el alias DEV ya usado (`upmina-testing-backend.vercel.app`, o el que confirme §6.8) al
  nuevo despliegue. Anotar id anterior.
  **6. Humo (sin sesión, sin escrituras):** `/` y `/admin/moderation` → 200/redirección a login;
  `GET /api/admin/moderation-cases?summary=pending`, `…moderation-cases` y `POST …moderation-strike-apply` sin token
  → 401 y sin cuerpo con datos; cabecera `Cache-Control: no-store`; rutas públicas de Community/Cosplay/Twitch sin
  cambios (HTTP 200).
  **7. Validación autenticada (tú, con MFA reciente; yo no uso credenciales):** contador = recuento de «Activos»;
  filtros combinados y paginación (anterior/siguiente/inicio); abrir un caso del Historial «Procede»: auditoría
  legible; aplicar un strike a la cuenta de PRUEBA y revocarlo con developer/admin distinto (ambos eventos con su
  nivel, no en otros casos); imagen/vídeo con estado de carga y error simulado; 375 px sin desbordamiento; teclado.
  **8. Criterios de aceptación:** 7 verificado sin errores de consola/red inesperados; 0 respuestas 5xx en las rutas
  admin durante la prueba; `strikes_rows` coherente (+1/revocado); cron y R7 sin cambios (`policy.enabled=false`,
  0 `deleting` nuevos); assets sin cambios (misma huella).
  **9. Detener inmediatamente si:** el dry-run lista algo distinto de 29–31; el `md5(prosrc)` previo no coincide con
  §4; el diff del paquete incluye archivos de almacenamiento; un smoke devuelve datos sin token; 5xx en rutas admin;
  cualquier asset pasa a `deleting` o aparece `last_run_at` en la política; el GC reporta `failed/retrying`.
  **10. Reversión:** (1) volver el alias al despliegue anterior (id anotado en 0); (2) solo si el SQL nuevo causa
  daño, ejecutar `docs/9K-R5J-rollback.sql` (transacción; restaura `md5` de §4); (3) si se aplicó un strike de
  prueba, revocarlo desde la UI (no se borran filas); (4) verificar con SELECT los `md5(prosrc)`. Las migraciones ya
  registradas no se reescriben: el historial seguirá listando 29–31 aunque se restauren las funciones; una limpieza
  formal sería una migración nueva.

## 8. Acciones que requieren tu autorización explícita

1. Decidir si incluir el mapeo `author_restricted` (§2.4.1) → implica separar hunks del archivo mixto.
2. Aplicar migraciones 20261029–31 en DEV.
3. Desplegar el paquete a Vercel DEV (Preview) y mover el alias.
4. Cualquier lectura/escritura sobre alias/ajustes de Vercel (la preparación no las hizo).
5. Retomar o descartar la prueba R7 (independiente).
6. Aplicar un strike de prueba y su revocación en DEV (escritura de datos de prueba).

## 9. Rollback SQL

`docs/9K-R5J-rollback.sql` (copia en el paquete). Probado en PGlite por `moderation-rollback-r5j.test.ts`.

---

# R5-J.1 — Cierre previo al despliegue (2026-10-10 ≈ 02:40Z · nada desplegado · nada aplicado)

## A. Ajuste `author_restricted` — PASS

**Qué hace (y solo eso).** La BD sigue siendo la autoridad (migración 24, ya aplicada en DEV): los escritores
`community_post_save[_atomic]`, `..._reorder_media`, `..._detach_media` lanzan `author_restricted` sin datos.
El backend lo traduce a una respuesta controlada:

- restricción vigente → `403 { error, code: "author_restricted", restriction: { level, permanent, endsAt, reason } }`;
- la restricción ya no existe al releer (revocada/expirada) → `409 author_restriction_changed`;
- lectura fallida o forma inesperada → `403 author_restricted` **sin** detalle;
- cualquier otro error de la BD → mapa cerrado existente o 500 genérico (sin leer restricción, sin texto crudo).

Nunca reintenta la escritura, nunca consulta la restricción en el borrado propio ni en escrituras que la BD acepta,
y proyecta solo campos de producto (sin moderador, caso, ciclo, decisión, reportantes ni auditoría).
El frontend (editor de Community) muestra `CommunityRestrictionNotice` (título, nivel, plazo o «permanente»,
motivo, recordatorio de que puede borrar sus publicaciones) o el aviso neutro del 409; conserva el borrador y no
reintenta. El texto es copy de producto en español, igual que el resto del editor de Community (no hay namespace
i18n de Community); el panel de moderación sí está en es/en/de. El motivo del strike se muestra al propio autor
por diseño de R5-E.

**Hunks trasladados (no se copió ningún archivo mixto completo):**

| Archivo del paquete                                                        | Origen       | Qué se trasladó                                                      |
| -------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| `src/lib/community-restriction.ts` (nuevo)                                 | principal    | íntegro (sin referencias a AUTH-2; verificado)                       |
| `src/lib/author-restriction.ts`, `CommunityRestrictionNotice.tsx` (nuevos) | principal    | íntegros (idem)                                                      |
| `src/lib/community-post-handlers.ts`                                       | HEAD + hunks | import, `respondWriterFailure` y su uso en save/reorder/detach       |
| `src/lib/community-client.ts`                                              | HEAD + hunks | import del parser y el campo `restriction` en `CommunityClientError` |
| `CommunityPostEditorForm.tsx`                                              | HEAD + hunks | estado, limpieza al enviar, rama en el `catch`, render del aviso     |

**Revertido a propósito (AUTH-2 / reserva de media):** import y uso de `account-state`, eliminación de `no_profile`
y del mensaje `profile_required`, `AccountIncompleteNotice`, mensaje de asset caducado, y el **precheck de reserva
de media** (`media-handlers.ts`, `media-client.ts`, `useMediaUpload.ts`): toca el flujo de media/R2 ya desplegado
y no es autoridad (la BD ya bloquea). Consecuencia: un autor sancionado todavía puede reservar una subida; el aviso
aparece al guardar la publicación. El diff del paquete frente a HEAD en estos 3 archivos contiene solo líneas de
restricción (revisado línea a línea).

**Tests (paquete; los de handlers también en el principal):** contrato R5-C de los 3 escritores (campos aprobados,
permanente, 409 por revocación, 6 lecturas defectuosas, borrado propio, errores de negocio intactos, sin filtración)

- **nuevos:** usuario sin restricción no consulta la restricción tras un guardado correcto; error inesperado de la
  BD = 500 genérico sin leer restricción ni texto interno. Editor: crear y editar (borrador conservado, sin éxito falso,
  sin reintento), detalle ausente, 409, segundo envío = intento nuevo, otros errores intactos, sin datos de moderación.
  Clientes (`author-restriction-clients`), parser y aviso (`author-restriction`, `CommunityRestrictionNotice`).
  Se eliminaron del paquete solo los tests del precheck de reserva de media. Ningún test se modificó para ocultar una
  regresión.

## B. Destino Vercel DEV — CONFIRMED (lectura: `vercel ls`, `vercel alias ls`; sin cambios)

| Dato                               | Valor                                                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proyecto vinculado al paquete      | `upmina-web-testing` (`prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP`, `team_co8xhbacSFWYpnVU7iDOjszT`, scope `edwin-9cad`)                                                                   |
| Alias de la app DEV (SPA + API)    | `upmina-testing-backend.vercel.app` → `upmina-web-testing-pccytl1nz-edwin-9cad.vercel.app` (despliegue R6, Ready, Preview, hace ~6 h)                                            |
| Despliegues anteriores (rollback)  | `…qykxblyup…` (anterior a R6), `…24b70pvvl…` (huérfano con checksum, sin alias)                                                                                                  |
| Otros alias del proyecto DEV       | `upmina-web-testing.vercel.app` y `upmina-web-testing-edwin-9cad.vercel.app` → `…gd7diyhgk…` (hace 5 d, entorno _Production_ del proyecto de pruebas, SPA+API antiguos)          |
| Origen de la API en el frontend    | **relativo** (`fetch("/api/…")`; sin `VITE_API*`): cada despliegue sirve su SPA y su API (rewrites de `vercel.json`)                                                             |
| ¿Frontend separado?                | Existe un alias antiguo (`upmina-web-testing.vercel.app`), **no usado** por las validaciones R6; un despliegue Preview NO lo mueve                                               |
| Qué cambiaría un despliegue futuro | Un nuevo Preview (URL propia) + `alias set <nuevo> upmina-testing-backend.vercel.app` (solo ese alias). `upmina-web-testing.vercel.app` solo cambiaría con `--prod`: **no usar** |
| Producción real                    | proyecto `upmina-web` y dominios `upminaa-web.com`: no se tocan ni se vinculan al paquete                                                                                        |

Riesgo: el alias antiguo `upmina-web-testing.vercel.app` seguirá con el backend viejo; validar siempre en
`upmina-testing-backend.vercel.app`.

## C. Aislamiento (diff frente al paquete DEV desplegado) — PASS

16 archivos modificados + 38 añadidos (todos de moderación, restricción, tests, rollback/docs y migraciones).
Modificados: `api/admin/[action].ts` (+2 rutas), `moderation-case-{contract,parser,handlers}.ts`,
`moderation-client.ts`, `AdminModerationPage.tsx`, `messages.ts`, `community-post-handlers.ts`,
`community-client.ts`, `CommunityPostEditorForm.tsx`, `vite.config.ts` y 5 tests. **Sin cambios** en `r2-client`,
`media-*`, `cosplay-media-lifecycle`, `useMediaUpload`, `workers/`, `vercel.json`, `package*`, AUTH-2 (`account-*`),
9N (`src/secrets`, `App.tsx`, `Footer`), cron ni R7. Única coincidencia con «áreas prohibidas»: el _archivo_
`20261028…media_abandoned_reservations_auto.sql` (R7 inerte), ya aplicado en DEV, incluido solo para alinear el
historial local; nunca se empuja (el dry-run no lo lista). Igual para 23, 24 y 25 (aplicadas). Las 9 migraciones ≥ 23
son idénticas byte a byte (LF) a las del árbol principal. Sin `.env` reales; escaneo de secretos limpio (solo
regex defensivas de tests existentes). El árbol principal no se limpió ni restableció.

## D. Migraciones — READY

Dry-run (sin escritura de esquema) vuelve a listar **exactamente** `20261029`, `20261030`, `20261031`. SELECT
(02:35Z): 42 migraciones (última `20261028`), `md5` de `cycle_read` `d9e18810…` y `cases_read` `7305cbd1…` (= línea
base del rollback), `community_moderation_pending_count` inexistente, 0 filas de strikes. Rollback
`docs/9K-R5J-rollback.sql` **sin cambios** (no hubo defecto); sus 3 tests siguen pasando.

## E. Comprobaciones previas de solo lectura (R7 no se manipuló) — PASS

`media_abandon_policy.enabled=false`, `min_age=24:00:00`, `last_run_at` NULL; 0 assets `deleting`; 154 assets, 1
posterior al corte (Asset A, `reserved`); Asset B inexistente; 1 cron activo. Ninguna comprobación escribe ni
requiere tocar R7.

## F. Resultados de validación (paquete, límite de 6 workers, variables `VITE_` sintéticas)

`tsc -b` OK · ESLint 0 warnings OK · Prettier (archivos tocados) OK · `npm run build` OK · **suite completa 3/3
ejecuciones: 209 archivos / 6502 tests, 0 errores de worker, 0 omitidos, 0 fallos**. En el árbol principal:
`tsc`, ESLint y `community-post-handlers.test.ts` (78) OK. Los flakes ajenos de R5-J (`AccountPage.profile-edit`,
`workers/media-delivery`, `CosplayEditorDialog.mfa`) no aparecieron en estas 3 ejecuciones; siguen siendo riesgo
preexistente (pasan en aislamiento).

## G. Riesgos residuales

1. Tests no herméticos (necesitan `VITE_SUPABASE_URL/ANON_KEY`; nunca `SUPABASE_SERVICE_ROLE_KEY`) — §6.1.
2. Flakes ajenos intermitentes bajo carga (§F).
3. Un autor sancionado aún puede reservar subidas (precheck excluido).
4. Alias antiguo `upmina-web-testing.vercel.app` no se actualizará.
5. Panel autenticado nunca validado en navegador.
6. No se comparó el texto de las migraciones 23–28 con lo aplicado (solo versión/nombre).
7. R7 sigue pendiente; Asset A (>2 h) sería elegible inmediatamente si se activara `min_age=2h`.
8. El CLI de Supabase crea un rol temporal al conectar (también en dry-run).

## H. Checklist de autorización (cada ítem por separado)

- [ ] Aplicar migraciones `20261029`, `20261030`, `20261031` en Supabase DEV (`rkqeqbqwdswhpzwqptac`).
- [ ] Desplegar un Preview del paquete `C:\Dev\upmina-web-r5-deploy` al proyecto `upmina-web-testing` (sin `--prod`).
- [ ] Mover SOLO el alias `upmina-testing-backend.vercel.app` al nuevo despliegue (anterior: `…pccytl1nz…`).
- [ ] Aplicar y revocar un strike de PRUEBA en DEV (escritura de datos de prueba, con tu cuenta MFA).
- [ ] (Independiente) retomar o descartar la prueba R7.
- [ ] (Opcional) decidir el precheck de reserva de media y el mapeo AUTH-2 como trabajo aparte.

---

# R5-K — Migraciones de moderación aplicadas en Supabase DEV (2026-10-10, 02:49Z) — PASS

Autorizado únicamente: `20261029120000`, `20261030120000`, `20261031120000` en `rkqeqbqwdswhpzwqptac`. No se
desplegó Vercel, no se movieron alias, no hubo commit/push, no se tocó Production, R2, `media_assets`, GC, cron,
R7, Asset A/B ni se generaron strikes. Los archivos SQL no se modificaron.

## Comprobaciones previas (todas OK, 02:49:18Z)

| #                                                                                            | Comprobación                                                                                    | Resultado                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1                                                                                            | Proyecto vinculado desde el paquete (`supabase/.temp/project-ref`, copiado del árbol principal) | `rkqeqbqwdswhpzwqptac`                                                                                                              |
| 2                                                                                            | Historial DEV                                                                                   | 42 migraciones, última `20261028120000`                                                                                             |
| 3                                                                                            | Dry-run desde `C:\Dev\upmina-web-r5-deploy`                                                     | exactamente `20261029`, `20261030`, `20261031`, en ese orden                                                                        |
| 4                                                                                            | `md5(prosrc)`                                                                                   | `cycle_read` `d9e18810…`, `cases_read` `7305cbd1…` (= R5-J); `pending_count` inexistente                                            |
| 5–6                                                                                          | `media_abandon_policy`                                                                          | `enabled=false`, `min_age=24:00:00`, `last_run_at` NULL                                                                             |
| 7–8                                                                                          | Assets                                                                                          | 0 `deleting`; Asset A `reserved`                                                                                                    |
| 9                                                                                            | Rollback                                                                                        | `docs/9K-R5J-rollback.sql` existe; `moderation-rollback-r5j.test.ts` (3) pasó en las 3 últimas suites del paquete                   |
| 10                                                                                           | SQL                                                                                             | sha256 (LF) idéntico entre paquete y árbol principal: `ef2c7c6a…`, `13b68b24…`, `5fa17382…`, sin modificaciones desde la validación |
| Huellas previas (para comparar): assets `6f2399df22b82bd4774636532534297a` (154 filas), cron |
| `community-media-purge-tick                                                                  | */5 * * * *                                                                                     | activo                                                                                                                              | md5(command)=a11fc58e…`. |

## Aplicación

`npx supabase@2.120.0 db push --linked --yes` desde el paquete: «Applying migration» ×3 en orden, sin errores SQL
y sin intervención manual. No hubo fallos parciales: no se repitió ni se ejecutó rollback.

## Verificación posterior (solo lectura, 02:49:44Z)

| Elemento                                   | Resultado                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Historial                                  | **45** migraciones; última `20261031120000`; cola `…28, …29, …30, …31`                                                                                                                                                               |
| `community_moderation_cases_read`          | **una sola firma** (10 parámetros); `md5` `779c6efd…` = definición local de 20261030; `security definer`, owner `postgres`, `search_path=pg_catalog, public`; ACL `postgres, service_role`; `anon`/`authenticated` sin EXECUTE       |
| `community_moderation_cycle_read`          | `md5` `51b4a5d3…` = definición local de 20261029; ACL solo `postgres` (ni `service_role`, como diseñado)                                                                                                                             |
| `community_moderation_pending_count(uuid)` | existe; `md5` `d689334b…`; mismas propiedades que `cases_read`; EXECUTE solo `service_role`                                                                                                                                          |
| Compatibilidad                             | con un UUID inexistente, las dos funciones (incluida la nueva firma de `cases_read` con filtros) fallan cerradas con `P0001 actor_not_moderator` antes de leer datos: la firma nueva es invocable por el backend y no concede acceso |
| R7                                         | `enabled=false`, `min_age=24:00:00`, `last_run_at` NULL (sin cambios)                                                                                                                                                                |
| Cron                                       | misma huella (1 job activo, mismo comando)                                                                                                                                                                                           |
| Assets                                     | 154; huella `6f2399df…` idéntica; Asset A `reserved`; 0 `deleting`                                                                                                                                                                   |
| Datos de moderación                        | 0 strikes, 0 filas de auditoría `strike_*` (no se generó ninguno)                                                                                                                                                                    |

## Problemas detectados

Ninguno. Notas: (a) el CLI abre un rol temporal de conexión; (b) el backend DESPLEGADO en DEV sigue siendo el
anterior a R5 (no usa las funciones nuevas): con SQL nuevo + backend antiguo todo funciona como antes (llamada de 5
argumentos válida, parser antiguo ignora `strikeLevel`); (c) el rollback sigue siendo válido (sus `md5` objetivo son
los de la línea base R5-J).

## Estado final: PASS

Siguiente acción recomendada (requiere autorización nueva): desplegar el Preview del paquete al proyecto
`upmina-web-testing` y, tras las pruebas de humo, mover SOLO el alias `upmina-testing-backend.vercel.app`
(sección «Plan de despliegue» de R5-J y checklist de R5-J.1).

---

# R5-L/M — Despliegue en DEV (2026-10-10): Preview `dpl_4PaKcPDMeHdwaYJb8cr5A6FDfa1e` (`…cnnnjbp1u…`) en el alias `upmina-testing-backend.vercel.app` (anterior `dpl_6AGTMU5asb2GdQcrhVsfERp3Yv1e`, `…pccytl1nz…`). Humo y pruebas automatizadas: PASS; validación autenticada con MFA: pendiente. Detalle en `docs/9K-R5LM-DEV-VALIDATION.md`.
