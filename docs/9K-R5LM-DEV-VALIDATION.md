# 9K-R5-L/M · Despliegue y cierre técnico de moderación en DEV (2026-10-10, ≈ 03:00–03:25Z)

**Estado final: PARTIAL** — despliegue, alias y todas las pruebas automatizadas y de humo: PASS. Pendiente solo lo
que exige una sesión humana con MFA (§6). R5 puede considerarse cerrado **técnicamente**; no funcionalmente
validado en DEV hasta completar §6.

## 1. Despliegue

|                                                                                                                  | Identificador                               | URL                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| **Anterior (rollback del alias)**                                                                                | `dpl_6AGTMU5asb2GdQcrhVsfERp3Yv1e`          | `https://upmina-web-testing-pccytl1nz-edwin-9cad.vercel.app` |
| **Nuevo (Preview, sin `--prod`)**                                                                                | `dpl_4PaKcPDMeHdwaYJb8cr5A6FDfa1e`          | `https://upmina-web-testing-cnnnjbp1u-edwin-9cad.vercel.app` |
| **Alias DEV actualizado**                                                                                        | `upmina-testing-backend.vercel.app` → nuevo | **`https://upmina-testing-backend.vercel.app`**              |
| Proyecto `upmina-web-testing` (`prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP`), scope `edwin-9cad`, desde el paquete aislado |
| `C:\Dev\upmina-web-r5-deploy` (nunca desde el árbol principal). Preview Ready, 5 funciones (`api/admin/[action]` |
| 960 KB, `api/media/[resource]`, …). No se aplicaron migraciones nuevas (las 3 ya estaban: R5-K).                 |

## 2. Comprobaciones previas (Fase 1) — PASS

Vercel enlazado a `upmina-web-testing`; Supabase del paquete = `rkqeqbqwdswhpzwqptac` (solo para el dry-run de
R5-K; el directorio `supabase/.temp` se **eliminó** del paquete antes de desplegar para no subirlo); paquete sin
cambios ajenos desde R5-J.1 (16 modificados + 38 añadidos, 0 en R2/media/AUTH-2/9N/cron/package/vercel.json);
`tsc`, ESLint (0 warnings) y build OK; historial 45 migraciones, última `20261031`; `enabled=false`, 0 `deleting`;
alias antes: `…pccytl1nz…`; escaneo de secretos limpio, solo `.env.example`.

## 3. Pruebas de humo (Preview y luego alias) — PASS

| Prueba                                                                                                                         | Preview                | Alias      |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ---------- |
| `/`, `/community`, `/cosplay`, `/login`, `/admin/moderation` (SPA)                                                             | 200                    | 200        |
| `/api/content/community-feed`, `/api/content/cosplay-list`                                                                     | 200 (= alias anterior) | 200        |
| `GET moderation-cases` (cola, `summary=pending`, detalle)                                                                      | 401 `No autenticado`   | 401        |
| `POST moderation-strike-apply`, `moderation-strike-revoke`, `moderation-case-decision`                                         | 401                    | 401        |
| `GET /api/admin/access`                                                                                                        | 401                    | —          |
| `Cache-Control` de las respuestas administrativas                                                                              | `no-store`             | `no-store` |
| 5xx inesperados                                                                                                                | ninguno                | ninguno    |
| Notas: `/api/twitch-status` responde 503 tanto en el despliegue anterior como en el nuevo (credenciales de Twitch              |
| no configuradas en este Preview): **preexistente, sin cambio**. Las rutas de strike existen en el backend nuevo (401, no 404). |
| El bundle servido por el alias contiene el panel nuevo (rutas de strike, filtros, textos del contador y de                     |
| reintento de carga multimedia).                                                                                                |

## 4. Alias — PASS

Solo se movió `upmina-testing-backend.vercel.app`. Verificado con `alias ls`: apunta a `…cnnnjbp1u…`;
`upmina-web-testing.vercel.app` y `upmina-web-testing-edwin-9cad.vercel.app` siguen en `…gd7diyhgk…`; los alias de
Production (`upminaa-web.com`, `www`, `upmina-web.vercel.app`, `…git-main…`) siguen en `upmina-96juvj9cs`. Las
pruebas posteriores al cambio pasaron: **no se revirtió** el alias (el rollback documentado sería
`alias set https://upmina-web-testing-pccytl1nz-edwin-9cad.vercel.app upmina-testing-backend.vercel.app`). No se
ejecutó rollback SQL.
Navegador (en el alias): `/admin/moderation` redirige a `/login?returnTo=/admin/moderation` (escritorio); `/community`
a 375 px sin desbordamiento horizontal y sin errores de consola.

## 5. Validación funcional automatizada — PASS

Paquete (el mismo código desplegado), `tsc` OK; **suite completa 209 archivos / 6502 tests** en 2 ejecuciones
finales con 3 workers, sin errores de worker, sin omitidos, sin fallos. Cubre: Activos/Historial, filtros y
paginación (anterior/siguiente/inicio, carreras, cursor inválido), contador de pendientes (cero/uno/varios, >1
página, tras decisión, error/carga, permisos), detalle y auditoría traducida (es/en/de), aplicar y revocar
strikes (MFA, roles, un solo vuelo, `strikeUnavailable`), medios (carga/error/reintento/privacidad), mensajes
`author_restricted` (backend y editor), SQL real con PGlite (filtros, contador, eventos de strike, cadena 29→31 y
rollback con `md5` de DEV). Además, 1394 tests del subconjunto de moderación antes del despliegue.

## 6. BLOCKED por sesión humana / MFA (NO ejecutado, NO PASS)

Panel autenticado en el alias: contador real = recuento de «Activos»; filtros y paginación con datos reales de DEV
(≥ 20 casos); detalle y auditoría de un caso «Procede»; aplicar y revocar un strike en una cuenta de PRUEBA y ver
ambos eventos con su nivel; aviso `author_restricted` para el autor sancionado; imagen/vídeo con fallo simulado;
layout real a 375 px en el panel; teclado; compuerta MFA con TOTP vencido. (No se pidieron credenciales ni se
eludió MFA; tampoco se crearon strikes.)

## 7. R7 (Fase 6, SELECT 03:09Z) — sin cambios

`enabled=false`, `min_age=24:00:00`, `last_run_at` NULL; Asset A `reserved`; 0 `deleting`; 154 assets con la misma
huella `6f2399df…`; cron: 1 job activo con el mismo comando (`a11fc58e…`); 0 strikes. No se activó la política ni
se ejecutó ningún barrido.

## 8. Problemas encontrados y correcciones

1. **Workers de Vitest con poca memoria libre:** con ≈ 3,6 GB libres, una corrida del subconjunto con 6 workers
   perdió workers (`Worker exited unexpectedly`); con 3 workers pasó 39/39 archivos (1394 tests). Misma causa que
   R5-I (instancias PGlite simultáneas); el tope de 6 depende de la RAM libre. No se declaró PASS con workers perdidos.
2. **Flake del test `community-author-media-delivery › never leaks…`** (regex `/k1/i` sobre la firma aleatoria de
   `cap=`): reapareció en el paquete porque el paquete conservaba el test de HEAD. Se portó el mismo arreglo (solo
   test; ningún código desplegado cambia) y el archivo pasa 3/3 aislado y 2/2 en suite completa.
3. Sin defectos en el código desplegado.

## 9. Riesgos pendientes

- Validación autenticada pendiente (§6). - El backend nuevo corre contra SQL ya compatible; el rollback del alias
  es suficiente si se detecta un fallo (el SQL nuevo es compatible con el backend anterior). - `/api/twitch-status`
  503 (credenciales no presentes en el entorno Preview; preexistente). - Un autor sancionado todavía puede reservar
  una subida (precheck de reserva excluido del paquete; la publicación sí queda bloqueada). **[Actualizado 2026-10-10: ese paquete de R5J excluía el precheck; lo introdujo después AUTH-2 (`3ff2490`) y desde R5-F es fail-closed. Ver §12.]** - Flakes ajenos
  intermitentes (`AccountPage.profile-edit`, `workers/media-delivery`, `CosplayEditorDialog.mfa`) y tests no
  herméticos (necesitan `VITE_SUPABASE_URL/ANON_KEY`). - R7 sigue pendiente (Asset A sería elegible de inmediato con
  `min_age=2h`). - El Preview anterior huérfano `…24b70pvvl…` sigue existiendo (sin alias).

## 10. Siguiente paso humano

Iniciar sesión con una cuenta moderadora (MFA reciente) en `https://upmina-testing-backend.vercel.app/admin/moderation`
y recorrer §6; después decidir si retomar R7.

## 11. Validación real de la revocación de strike en DEV (2026-10-10, 22:22–22:29Z)

**Resultado: R5 VALIDADO en DEV** (revocación entre dos cuentas, con MFA, auditoría correcta y privilegios restaurados).
Las escrituras las hizo el propietario desde la interfaz de DEV; el agente solo hizo SELECT. Production no se tocó.

| Caso | Resultado real |
|---|---|
| W1 cuenta nueva | No necesario: se reutilizó la cuenta de prueba `eds` (`c85a2760…`, correo confirmado, sin rol ni TOTP) |
| W2 invitación `moderator` | Creada por `edwin1` a las 22:22:07Z y consumida por `eds` |
| W3 activación + TOTP | `eds` con fila en `admin_roles` y factor TOTP `verified` |
| W4 subir a `developer` | `role_changed moderator>developer`, actor `edwin1`, 22:24:03Z |
| W5 revocar el strike | Strike `b03759c0…` (nivel 1, aplicado por `edwin1` a `9k_e5_72h_author`): `revoked_at=22:26:13.5Z`, `revoked_by=eds` (≠ aplicador), motivo guardado (35 caracteres); 1 evento `strike_revoked` (actor `eds`, objetivo el mismo strike, metadatos `level/case_id/decision_id`); auditoría de moderación 84 → 85; es el único strike y el único revocado |
| W6 retirar acceso | `access_removed developer>-`, actor `edwin1`, objetivo `eds`, 22:29:09Z; `eds` sin filas en `admin_roles` |

**Estado final (SELECT 22:29Z):** `admin_roles` = `edwin1=admin` + `9k_e5_72h_mod=moderator`; strike y evento
`strike_revoked` intactos; R7 `enabled=false` (`min_age=4 h`, `last_run_at` de la prueba del 10-oct, sin cambios);
156 assets, 0 `deleting`, huella `5ab07710…` idéntica a la posterior a la prueba de R7; A, C1 y C2 `reserved` con
`updated_at` sin cambios; cron activo.

**Notas:**
- La auditoría de equipo (`admin_team_audit`) registra `role_changed` y `access_removed`, pero NO la creación ni el
  consumo de la invitación; esa traza está en `admin_invitations`. Es el diseño actual, no un fallo.
- Quedan como historial: la invitación consumida, los eventos de auditoría y el factor TOTP de `eds`. No se borraron
  cuentas ni se quitó el TOTP.
- La revocación de un strike es irreversible por diseño (un strike por decisión): no se puede repetir esta prueba.

## 12. R5-F: cierre del flujo de cuentas sancionadas (2026-10-10, implementación LOCAL; sin commit)

Esta sección distingue lo que ya existía de lo nuevo. Las validaciones W1–W6 (§11) no se tocan ni se repiten.

### 12.1 Regla real de los strikes (leída del SQL, sin cambios)
- Nivel = `min(strikes NO revocados del usuario + 1, 3)`. La **expiración natural NO quita un strike de la escalada**;
  solo la revocación lo hace.
- Strike 1 = 14 días, Strike 2 = 1 mes calendario (UTC), Strike 3 = permanente. El plazo se calcula al emitir y no se recalcula.
- **Cada nivel restringe**: mientras la sanción está vigente (no revocada y permanente o `sanction_ends_at` futuro) el autor
  no puede crear, editar, reordenar ni desadjuntar media de publicaciones de Community
  (`community_assert_author_may_write`, migración `20261024120000`). Borrar sus propias publicaciones, dar likes,
  reportar, editar el perfil y Cosplay (administradores) no se bloquean.
- Consecuencia para los textos: el Strike 1 y el Strike 2 **ya impiden publicar** (de forma temporal); el Strike 3 es la
  restricción permanente. Los avisos de Strike 1/2 se redactaron con esta semántica (ver 12.5).

### 12.2 Qué ya existía antes de R5-F
- Guard autoritativo en la BD para los cuatro escritores de publicaciones (rechazo `author_restricted`, sin datos).
- Traducción HTTP (403 con `restriction`, 409 `author_restriction_changed`) y `CommunityRestrictionNotice`
  (nivel, plazo, motivo, recordatorio de borrado propio) mostrados **tras** un intento de guardar o adjuntar.
- Precheck de reserva de media para Community (introducido por AUTH-2, `3ff2490`; el paquete DEV de R5J lo excluía).
  Era NO autoritativo y **fail-open**: si la lectura de la restricción fallaba, la reserva continuaba.

### 12.3 Nuevo en R5-F
- **Reserva de media fail-closed** (`handleMediaReserve`): restricción vigente → 403 `author_restricted`; sin restricción
  confirmada → flujo normal; lectura fallida o respuesta con forma inesperada → **503 `restriction_unavailable`**
  (`Retry-After: 5`), siempre ANTES de crear la fila de `media_assets` y cualquier sesión o URL de R2. Cosplay
  (administradores) no consulta la restricción, como antes. R7 y sus tiempos no cambian.
- **Consulta GET autenticada** `GET /api/admin/community-author-restriction` (nueva acción del dispatcher existente, sin
  entrypoint nuevo): la identidad sale solo del JWT verificado; ningún parámetro de query ni de body se lee. Respuesta
  `{restricted:false}` o `{restricted:true, restriction:{level, permanent, endsAt, reason}}`, `Cache-Control: private,
  no-store`; fallo de lectura → 503.
- **Compuerta de los editores** (`CommunityPostEditorGate` + `useAuthorRestriction`): crear y editar consultan el estado
  vigente al abrir. Cargando o con error → no se monta el formulario (el error ofrece «Reintentar»); restringido →
  `CommunityRestrictionNotice` + «Cerrar» en lugar del formulario (sin selector de archivos); sin restricción confirmada
  → formulario normal. Sin caché: una sanción revocada o expirada deja de bloquear en la siguiente apertura, sin cerrar
  sesión. Las respuestas tardías (otro intento, otro usuario, desmontaje) se descartan.
- Restricción que aparece con el editor abierto: sin cambios (el backend rechaza, aviso, borrador intacto, sin reintento).

### 12.4 Cobertura de tests
`media-handlers.test.ts` (fail-closed, incluidos vídeo multipart y ausencia de URLs/sesiones R2),
`community-post-handlers.test.ts` (GET: identidad solo del JWT, parámetros manipulados ignorados, 503, 401/405,
revocación), `author-restriction-clients.test.ts` (cliente: nunca «sin restricción» ante fallos),
`CommunityPostEditorGate.test.tsx` (carga, error y reintento, restricción, desbloqueo, respuesta tardía, desmontaje y que
el formulario solo se importa desde la compuerta) y `ProfilePage.test.tsx` (apertura real desde el perfil).
Sin validación en DEV todavía: requiere desplegar este cambio (ver 12.7).

### 12.5 Advertencias de Strike 1 y Strike 2 (implementadas en LOCAL)
Se muestran dentro de `CommunityRestrictionNotice` (un único componente, sin avisos duplicados), a partir de la
restricción VIGENTE que devuelve el servidor, y por tanto donde ya aparece el aviso: la compuerta del editor, el rechazo
al guardar o adjuntar y el rechazo de la reserva de media. Texto en `restrictionCopy` (`src/lib/author-restriction.ts`):
- **Strike 1:** «Has recibido tu primer strike por incumplir las normas de la comunidad.» + «No puedes crear ni editar
  publicaciones hasta {fecha}.» + «Advertencia: los strikes siguen contando aunque termine su restricción temporal, salvo
  que sean revocados. Un segundo strike supondrá una restricción de un mes y un tercero, la pérdida permanente del permiso
  para publicar.»
- **Strike 2:** «Has recibido tu segundo strike.» + el plazo + «Última advertencia: si recibes un tercer strike, perderás
  permanentemente el permiso para crear y editar publicaciones en la comunidad. Los strikes anteriores siguen contando
  incluso después de cumplir su restricción, salvo que sean revocados.»
- **Strike 3 (permanente):** sin cambios («Tu cuenta tiene un Strike 3 activo en Community.», permanente, motivo); no lleva
  advertencia porque es el máximo. Todos conservan motivo completo y «Puedes seguir eliminando tus propias publicaciones».
- **Expiración y revocación:** el servidor solo devuelve restricciones vigentes (no revocadas y con plazo futuro), así que
  una sanción expirada o revocada no genera aviso (el editor se abre). Si un aviso ya visible llega a su vencimiento según el
  reloj del dispositivo, se sustituye por el mensaje neutro «El estado de tu restricción cambió. Vuelve a intentarlo.».
- Las reglas, niveles y duraciones NO se modificaron. El texto está solo en español, como el resto del editor de Community.

### 12.6 Tests de las advertencias
`author-restriction.test.ts` (copia exacta por nivel, urgencia de Strike 2, Strike 3 y «sin detalle» sin advertencia),
`CommunityRestrictionNotice.test.tsx` (una sola advertencia por aviso, niveles 1/2/3, sin detalle y plazo vencido) y los
tests del editor, de la compuerta y del perfil adaptados al nuevo texto. Fechas de prueba en 2099 para que no caduquen.

### 12.7 Limitaciones reales y pendiente
- **No existe una pantalla donde el usuario consulte su historial de strikes** (solo hay vistas de moderación). No se
  construyó un módulo nuevo. Consecuencia: la advertencia solo se ve mientras hay una sanción vigente; con una sanción
  expirada pero strikes sin revocar el usuario no recibe ningún aviso hasta una nueva infracción (el servidor no expone hoy
  esos strikes al propio usuario). Cubrirlo exigiría ampliar la lectura de la restricción o crear esa pantalla.
- El nivel mostrado es el del strike vigente con el plazo más largo (regla de `community_author_restriction`).
- Validación manual en DEV pendiente: requiere desplegar este cambio y un strike activo (no existe ninguno; el único se
  revocó en W5). El backend de DEV hoy es el anterior: no tiene el GET ni el fail-closed ni estos textos.

## 13. Prueba integral R5-F en DEV (2026-10-10/11): despliegue, corrección de «No procede», P1 y P2

Estado: **EN CURSO**. P1 y P2 aprobadas visualmente; falta P3/P4 (strikes), bloqueo real de reservas, revocación y
recuperación. R5-F NO se da por terminado hasta completar esas comprobaciones.

### 13.1 Despliegue aislado (autorizado)
- Worktree `C:\Dev\upmina-web-r5f` sobre `6691b79` + los 18 archivos de R5-F (sin AUTH-3, REP-1, identidad, COPY-1, 9N ni
  rediseño). Verificado antes: el árbol de `6691b79` es idéntico al paquete que estaba en DEV salvo docs/scripts/un test.
- Preview `dpl_DooePqs24j7NHNQ6F7wpUeofb3B7` (`…6d92tlnyw…`) y alias `upmina-testing-backend.vercel.app` movido a él.
  Rollback disponible: `dpl_NpfoVbqaeuDixjT7mA7Z9Wkmf6GB` (`…14utbralr…`). Production sin cambios.
- Hallazgo: el botón «Reportar» pertenece a REP-1 (`b3ac59d`) y no está en DEV; el backend de 9K sí recibe reportes (5
  motivos). Las denuncias de esta prueba son fixtures de base de datos (ver 13.3), no una prueba del botón ni del endpoint.

### 13.2 Corrección de «No procede» (migración `20261031130000_no_procede_notice_after_hidden_only.sql`)
- Requisito: el aviso privado `reports_not_valid` («Caso resuelto» y mensaje temporal) solo se crea cuando la publicación
  estuvo ocultada (`hidden_pending_review`) y la decisión «No procede» la restaura. Antes (20261015) también se creaba si
  nunca había sido ocultada.
- Cambio único: la condición del INSERT del aviso añade `v_before_status = 'hidden_pending_review'`. El resto de la
  función es idéntico (test estático). Rollback de operador en `supabase/rollbacks/`.
- Aplicada en DEV con `supabase db push --linked` desde el worktree (dry-run previo: exactamente 1 migración). Verificado por
  SELECT: el cuerpo de la función cambió y contiene la condición; firma, `security definer`, propietario y permisos
  intactos; las otras 73 funciones públicas, las columnas, las restricciones y los triggers tienen huellas idénticas;
  historial 45 → 46. Los avisos ya existentes no se tocaron.
- Tests locales: 1–2 denuncias + «No procede» → publicación intacta, 0 avisos; 3 denunciantes → oculta, restaura, 1 aviso que
  se consume una vez; «Sí procede» (1 y 3) → `purge_after = removed_at + 72 h` y sin aviso de restauración.

### 13.3 Método de los fixtures
Denuncias creadas con la función de BD `community_post_report_submit(reporter, post, 'spam', null)` ejecutada por SQL
(incluye el guard de cuenta completa de AUTH-2 y el umbral real). Valida el umbral, la ocultación y el flujo de moderación;
NO valida el endpoint HTTP ni el botón Reportar. Decisiones y strikes se ejecutan desde el panel por el propietario (`edwin1`,
sesión real con MFA).

### 13.4 P1 — suspensión preventiva y «No procede»: APROBADA (visual)
- P1 = `dc81c5b2-711a-4e76-802b-2df67e7718df` ("publicacion prueba 1", autor `edwin390`). Reportes `spam` de `edwin`, `edwin1` y
  `eds` (3 distintos) → `hidden_pending_review` (v2), evento `post_quarantined`, 0 avisos, no pública.
- El propietario comprobó visualmente «Publicación pausada» (perfil y detalle) y que no es pública para otras cuentas.
- Tras «No procede» (panel, `edwin1`): P1 `published` v3, caso `closed`, 1 aviso `reports_not_valid` ya visto (la etiqueta
  «Caso resuelto» y el mensaje temporal se mostraron y consumieron); el propietario confirmó que la publicación restaurada
  es accesible sin sesión (ventana InPrivate).

### 13.5 P2 — «Sí procede» y retención de 72 h: APROBADA (visual); eliminación efectiva futura NO validada
- P2 = `b46dc25b-de92-4bfd-b93e-386f3eb6d7fc` ("Prueba de publicación AUTH-2 en DEV", autor `edwin390`). 1 reporte `spam` de
  `edwin` (fixture) → caso pendiente; decisión «Sí procede» por `edwin1`.
- SELECT: `removed_pending_purge` (v2), `removed_at = 2026-10-11 00:25:38.85Z`, `purge_after = 2026-10-14 00:25:38.85Z`
  (**= removed_at + 72 h**, comprobado), decisión `content_actioned` ligada a la publicación (misma marca de tiempo) con el mensaje de
  moderación (136 caracteres), caso y ciclo `closed`, reporte `actioned`, auditoría `content_actioned` (humana), **0 avisos
  `reports_not_valid`**.
- El propietario comprobó con capturas: etiqueta «Retirada» en el perfil, «Publicación retirada», aviso de eliminación
  permanente tras 72 horas con la fecha **13 de octubre de 2026, 18:25** (hora de la interfaz = 2026-10-14 00:25Z), el mensaje
  de moderación y que la publicación no es accesible públicamente.
- **Pendiente (no validado):** la purga automática y el GC de P2. Ocurrirán por el cron real a partir de
  2026-10-14 00:25Z; se evaluarán después por SELECT (fila eliminada, evento `post_purged`). No se alteró el reloj ni se
  forzó la eliminación. Referencia previa de la purga automática: E5 (2026-10-09). Otro fixture sintético
  (`93c30002-…0002`) se purgará el 2026-10-13 03:32Z.

### 13.6 Estado al cierre de este registro (SELECT)
P1 `published` v3; strikes: 1 en total, revocado (W5), 0 activos; `edwin390` sin restricción; roles `edwin1=admin` y
`9k_e5_72h_mod=moderator`; 13 publicaciones, 51 reportes, 18 avisos. Production y R7 sin cambios.

## 14. Strikes 1–3 y bloqueo real de reservas multimedia en DEV (2026-10-11)

Estado: **EN CURSO**. Aprobadas: P3/P4 preparadas, Strike 1/2/3 (visual, por el propietario) y el rechazo real de la
reserva multimedia. Pendiente: revocación, recuperación del acceso y restauración de roles.

### 14.1 Fixtures P3 y P4 y aplicación de strikes
- P3 = `371a7b8f-d22f-403e-886d-f9d461eeb0eb` ("Prueba R5-F Strike 2") y P4 = `5e0dc770-16aa-49c7-ac83-1d6ffef12e52`
  ("Prueba R5-F Strike 3"): publicaciones de solo texto de `edwin390` creadas con la función de BD `community_post_save` y un
  reporte `spam` de `edwin` cada una (`community_post_report_submit`). Son fixtures: no validan el editor ni el endpoint HTTP.
- El propietario resolvió «Sí procede» y aplicó los strikes desde el panel con sesión real y MFA (`eds` como moderador
  temporal). SELECT: P2 → Strike 1, P3 → Strike 2, P4 → Strike 3 (permanente); los tres activos, ninguno revocado.
- Los mensajes y bloqueos visuales de Strike 1, 2 y 3 (aviso con motivo, plazo y advertencias, editores de creación y edición
  sustituidos por el aviso) fueron comprobados y aprobados por el propietario con capturas.

### 14.2 Rechazo real de la reserva multimedia (restricción permanente, Strike 3): APROBADO
- Línea base (SELECT 2026-10-11 17:54Z): `edwin390` con 0 filas en `media_assets`; 156 assets en total (139 `ready`, 9 `failed`, 8
  `reserved`); 3 sesiones multipart en BD (A, C1 y C2 de R7); último asset creado 2026-10-10 22:00:35Z.
- Petición: UNA sola `POST /api/media/reserve` autenticada desde la sesión legítima de `edwin390` en el navegador del
  propietario, con el cuerpo mínimo válido `{domain:"community", kind:"image", sourceMime:"image/jpeg", sourceBytes:1000,
  sourceWidth:100, sourceHeight:100}` (el mismo cuerpo de reserva pasa con 200 sin sanción en `media-handlers.test.ts`). No se
  usó `service_role` ni se suplantó ninguna sesión; el fragmento no imprimía el token.
- Resultado real: **HTTP 403, `author_restricted`, `restriction: {level: 3, permanent: true}`**. La reserva se rechaza antes de
  crear la fila de `media_assets` o ninguna sesión de R2.
- Verificación posterior (SELECT 2026-10-11 ≈18:00Z): `edwin390` sigue con 0 filas; el total sigue en 156 con el mismo
  reparto por estado y el mismo último asset; las sesiones multipart en BD siguen siendo A, C1 y C2; y el script de solo
  lectura `scripts/r2-multipart-check-dev.mjs` lista exactamente esas tres sesiones abiertas en `staging/community/`.
  Sin sesiones ni filas nuevas.
- Sin efectos colaterales: 3 strikes de `edwin390` activos (4 en total, 1 revocado de W5), P1 `published` v3, P2 `removed_pending_purge`
  (`purge_after` 2026-10-14 00:25Z), P3 y P4 `removed_pending_purge`, decisiones `reports_not_valid` (P1) y `content_actioned` (P2–P4), 15
  publicaciones, 53 reportes y 18 avisos; roles `edwin1=admin`, `9k_e5_72h_mod=moderator`, `eds=moderator` (temporal, sin retirar
  todavía); R7 `enabled=false`, `min_age=4 h`, sin ejecuciones nuevas.
- Alcance: valida el bloqueo de reserva con una restricción permanente. El comportamiento fail-closed ante un fallo de la
  lectura de la restricción está cubierto por tests (503 `restriction_unavailable`), no se provocó en DEV. Cosplay
  administrativo no se probó en vivo (tests locales).

### 14.3 Pendiente de R5-F
Revocación de los tres strikes de `edwin390` (por `edwin1`, distinto del aplicador), recuperación del acceso a los
editores sin cerrar sesión, retirada del rol de `eds` y comprobación final de roles. Evaluación posterior por SELECT de
la purga automática de P2–P4 (no validada).

## 15. Revocación de los tres strikes y recuperación del acceso en DEV (2026-10-11)

Estado: **EN CURSO**. Revocación y recuperación de AMBOS editores (creación y edición): confirmadas visualmente. Pendiente:
retirada del rol temporal de `eds` y comprobación final de roles.

### 15.1 Revocaciones (SELECT 2026-10-11 ≈18:15Z)
El propietario revocó desde el panel, con la sesión real de `edwin1` y MFA, los tres strikes de `edwin390`:

| Strike | Decisión (publicación) | Aplicado por | Revocado (UTC) | Revocado por | Motivo guardado |
|---|---|---|---|---|---|
| L3 (permanente) | `5e0dc770…` (P4) | `eds` | 2026-10-11 18:08:59 | `edwin1` | sí (35 car.) |
| L1 | `b46dc25b…` (P2) | `eds` | 2026-10-11 18:09:43 | `edwin1` | sí (16 car.) |
| L2 | `371a7b8f…` (P3) | `eds` | 2026-10-11 18:10:44 | `edwin1` | sí (16 car.) |

- En los tres, quien revoca (`edwin1`) es distinto de quien aplicó (`eds`).
- Los tres tienen `revoked_at` y `revoked_by`; ninguno de `edwin390` sigue activo. `community_author_restriction` devuelve
  `restricted: false` y `community_strike_state_read` marca los tres casos como `status: revoked`, `sanctionInEffect: false`.
- Auditoría: 4 eventos `strike_revoked` en total, sobre 4 strikes distintos que coinciden con los 4 strikes revocados de la tabla:
  el de W5 (`eds`, 2026-10-10) y estos tres (`edwin1`). Hay 4 eventos `strike_applied`. No se revocó ningún otro strike: hay 4
  strikes en total, 4 revocados, 0 activos.

### 15.2 Recuperación del acceso
- El propietario comprobó visualmente que `edwin390` recupera el editor de **nueva publicación** sin cerrar sesión (la
  compuerta consulta la restricción vigente en cada apertura y ya no devuelve sanción).
- El propietario confirmó también visualmente que `edwin390` recupera el editor de **edición** de una publicación propia
  (sin aviso de sanción). **R5-F completó así la comprobación visual de recuperación del acceso en los dos editores.**
- Los avisos de sanciones revocadas no se muestran: el servidor solo devuelve restricciones vigentes.

### 15.3 Sin cambios inesperados
P1 `published` v3 (decisión `reports_not_valid`); P2, P3 y P4 `removed_pending_purge` v2 (decisiones `content_actioned`);
15 publicaciones, 53 reportes, 18 avisos y 0 publicaciones nuevas de `edwin390`; 156 assets (0 de `edwin390`, último
2026-10-10 22:00:35Z); R7 `enabled=false`, `min_age=4 h`, sin ejecuciones nuevas; roles `edwin1=admin`,
`9k_e5_72h_mod=moderator` y `eds=moderator` (temporal, 1 factor TOTP verificado, sin tocar).

### 15.4 Pendiente de R5-F
Retirada del rol de `eds`, comprobación final de roles y, más adelante, evaluación por SELECT de la purga automática de
P2–P4 (no validada).
