# DEL-1 — Eliminación definitiva de cuentas (base SQL)

Estado: **preparado, NO aplicado en ningún entorno** (DEV y Production sin cambios). Migración
`supabase/migrations/20261113120000_account_deletion_foundation.sql`, rollback
`supabase/rollbacks/20261113120000_account_deletion_foundation.rollback.sql`, pruebas
`src/lib/account-deletion-sql.test.ts` (PGlite, SQL real). Endpoints, correo, ejecutor e interfaz son DEL-2 / DEL-3.

## 1. Máquina de estados (`account_deletion_requests.status`)

```
pending_confirmation ──► expired | superseded            (terminales; token_hash = NULL)
pending_confirmation ──► access_blocked                  (confirmación: token consumido + barrera + etapas, UNA transacción)
access_blocked ──► cleanup_in_progress ──► completed     (terminal)
cleanup_in_progress ──► cleanup_retry_pending ──► cleanup_in_progress
cleanup_in_progress ──► cleanup_manual_required ──► cleanup_retry_pending   (solo reintento de un developer)
```

- «Confirmación aceptada» y «acceso bloqueado» son **el mismo instante** (`confirmed_at = access_blocked_at`): no existe un estado
  intermedio en el que el token esté consumido y la cuenta activa, ni una cuenta bloqueada sin trabajo durable (las 6 etapas se crean
  en la misma transacción).
- No hay transición hacia atrás ni hacia «activa»: lo garantiza un trigger (`account_deletion_requests_guard`), la tabla
  `account_deletion_blocks` es inmutable (sin UPDATE/DELETE/TRUNCATE) y no existe ninguna función de desbloqueo.
- Una cuenta con solicitud confirmada es única (índice parcial). Solo puede haber una solicitud `pending_confirmation` por cuenta;
  una nueva sustituye a la anterior (`superseded`, su enlace deja de funcionar). Límites: 60 s entre solicitudes y 5 en 24 h.

## 2. Barrera de acceso (D14)

`account_deletion_blocks` (una fila por cuenta, creada al confirmar). Se aplica **en la base de datos**, sin depender de cerrar sesión ni de
que el JWT caduque, con triggers `BEFORE INSERT/UPDATE` que lanzan `account_deletion_blocked`:

| Tabla                    | Evento                                                        | Columna                 |
| ------------------------ | ------------------------------------------------------------- | ----------------------- |
| `community_posts`        | INSERT; UPDATE de `text`                                      | `author_user_id`        |
| `community_post_media`   | INSERT/UPDATE                                                 | autor de la publicación |
| `community_post_likes`   | INSERT                                                        | `user_id`               |
| `community_post_reports` | INSERT                                                        | `reporter_user_id`      |
| `media_assets`           | INSERT                                                        | `created_by`            |
| `profiles`               | UPDATE                                                        | `user_id`               |
| `admin_roles`            | INSERT (no se concede ningún rol a una cuenta en eliminación) | `user_id`               |

No se bloquean `DELETE` (la limpieza y las cascadas deben pasar) ni los cambios de estado de moderación (ocultar, cuarentena, purga).

**Límites reales (documentados, no resueltos en DEL-1):**

1. Los endpoints siguen aceptando un JWT criptográficamente válido hasta su caducidad: **DEL-2 debe llamar a `account_deletion_gate(userId)` en
   `requireAuthenticated` y rechazar** (fail-closed: si el gate falla, se rechaza). Hasta entonces la barrera solo protege escrituras en BD.
2. Las lecturas privadas (URLs de medios firmadas ya emitidas, respuestas cacheadas) **no son revocables**: una URL firmada vive hasta su
   caducidad. DEL-2 debe cortar la emisión de nuevas URLs para cuentas bloqueadas y la etapa `auth_block` revoca sesiones y bloquea el login.
3. PGlite no prueba carreras reales entre conexiones: la serialización descansa en `pg_advisory_xact_lock` por cuenta, en
   `upmina_lock_admin_roles()` (primero, como exige el proyecto) y en `FOR UPDATE` / `FOR UPDATE SKIP LOCKED`.

## 3. Token y confirmación (D3, D4)

- DEL-2 genera 256 bits aleatorios, envía el token por correo y pasa a la RPC **solo su SHA-256 hex** (64 caracteres). Nunca se guarda
  el texto plano ni se escribe en eventos (el CHECK de `metadata` rechaza `token`, `token_hash`, `email`, `password`).
- `account_deletion_preview(user, hash)`: **solo lectura** (`valid` / `expired` / `invalid` / `already_deleting`). Abrir el enlace no consume nada.
- `account_deletion_confirm(user, hash)`: `user` es el **id verificado por JWT** (sesión vigente). El token solo se acepta si pertenece a esa
  misma cuenta; otra cuenta recibe `invalid_token` sin consumirlo. Resultados (no excepciones, para que la caducidad persista):
  `confirmed`, `already_deleting` (repetición/doble pestaña/carrera serializada), `invalid_token`, `expired`, `privileged_account`, `user_not_found`.
- La confirmación final explícita (casilla/frase) es responsabilidad de la interfaz y del endpoint de DEL-2: la RPC solo se invoca tras ella.

## 4. Etapas y recuperación (D2, D7, D14)

Orden fijo (`account_deletion_steps`), cada una idempotente y registrada (`pending → running → done | failed`; una etapa `done` es inmutable):

| #   | Etapa               | Quién                                             | Qué hace                                                                                                                   |
| --- | ------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `auth_block`        | DEL-2 (externo)                                   | Bloquear login (ban) y revocar sesiones/refresh tokens de Supabase Auth                                                    |
| 2   | `copyright_claims`  | SQL `account_deletion_stage_copyright`            | Cierre técnico `author_deleted` de reclamaciones activas (ver §6)                                                          |
| 3   | `community_content` | SQL `account_deletion_stage_content`              | Cierra los casos pendientes (D15), marca `deleting` solo los archivos exclusivos, borra publicaciones y «me gusta» propios |
| 4   | `profile`           | SQL `account_deletion_stage_profile`              | Borra el perfil y **libera el username** (D16); falla cerrada si queda contenido público o hay `avatar_path`               |
| 5   | `media_gc`          | SQL `account_deletion_stage_media` + GC existente | Re-marca huérfanos y cuenta lo que el GC de R2 aún no borró (`pending > 0` ⇒ reintento `media_gc_pending`)                 |
| 6   | `auth_delete`       | DEL-2 (externo)                                   | `auth.admin.deleteUser` (cascada de lo que quede). Último paso                                                             |

Protocolo del ejecutor: `account_deletion_claim` (lease) → por etapa `account_deletion_step_start` → trabajo → `account_deletion_step_finish(ok|código)`.
`account_deletion_release` devuelve la solicitud a la cola sin contar fallo. Un worker caído se recupera cuando caduca su lease (la etapa
`running` vuelve a `pending`). Ningún fallo cambia la barrera: la cuenta nunca recupera acceso.

Reintentos automáticos: backoff `30 s · 2^(n-1)` (tope 6 h; el proveedor puede sugerir otro `retry_after`, acotado), **8 fallos consecutivos** ⇒
`cleanup_manual_required`. `last_admin_protected` y `avatar_not_supported` pasan a manual de inmediato. Códigos de error cerrados:
`r2_unavailable, auth_unavailable, db_error, media_gc_pending, last_admin_protected, avatar_not_supported, timeout, unexpected`.

## 5. Alertas y reintento para Developer

- La alerta es la propia solicitud con `alert_open = true` (desde el primer fallo hasta que **se completa**). Leerla no la resuelve; no existe
  función de «reconocer». Se añaden como `stalled` las bloqueadas sin reclamar (>15 min) o con lease vencido (>15 min).
- `account_deletion_alerts(actor)`: solo `developer` (rol verificado en servidor desde `admin_roles`). Devuelve id de solicitud, estado, etapa y
  código de error, fechas, intentos, próximo reintento, etapas pendientes, `accessBlocked`, `manualRequired`. **Sin user_id, sin correo, sin tokens.**
- `account_deletion_developer_retry(actor, requestId)`: solo `developer`; solo desde `cleanup_retry_pending` / `cleanup_manual_required`;
  **reprograma** (no ejecuta): etapas `failed → pending`, `next_retry_at = now()`; el ejecutor normal lo recoge. Auditado en `account_deletion_events`
  (`developer_retry`, actor humano). No toca la barrera, no recrea la cuenta, no modifica evidencias.

## 6. Integridad con Community y Copyright

- **Community:** no se tocan funciones ni reglas. Reportes, casos, ciclos, decisiones, strikes y `moderation_audit_log` no tienen FK a la cuenta y
  **quedan intactos** (con el UUID original: dato potencialmente identificable, acceso solo servidor; no es anonimización). Un strike activo no impide
  solicitar ni confirmar. La limpieza no usa la cascada de `auth.users` sobre `community_posts`: marca antes los archivos exclusivos como `deleting`
  (misma regla que `community_purge_due_posts`/`copyright_claim_purge`) para que el GC de R2 los recoja.
- **Copyright:** nuevo estado `author_deleted` (cierre técnico). Solo se amplían listas cerradas (`status`, `kind` de evento, actor `system`) y se
  reformula `copyright_claims_removal_check` para tolerar `author_deleted` con o sin retirada previa. Se cierran `received, in_review, needs_info,
removed, appeal_pending`; `dismissed, withdrawn, restored, purged` no se tocan. Se invalida el enlace de apelación y el aviso pendiente; se conservan
  reclamante, snapshot, retirada y strikes. **No se resuelve la apelación pendiente** (no se inventa una decisión) y no se usa `copyright_claim_purge`.
  Tras `author_deleted` la reclamación ya no admite revisión, restauración ni purga. La etapa de contenido falla (`copyright_stage_incomplete`) si
  quedara una publicación con protección activa.
- **Roles (D10):** `account_deletion_request`/`confirm` rechazan cuentas con fila en `admin_roles` (`privileged_account_requires_procedure`). El
  procedimiento separado (degradar el rol por el flujo existente de equipo, con `last_admin_protected` intacto, y entonces el flujo ordinario) **no se
  implementa aquí**. Si una cuenta recibiera un rol después, `auth_delete` fallaría con `last_admin_protected` ⇒ manual.
- **Retención:** `account_deletion_retention_catalog` clasifica 13 conjuntos de datos en 5 clases. **Ningún plazo está aprobado** (`pending_legal_review`);
  la revisión legal de `docs/REP-1-COPY-1.md` sigue pendiente y no se da por resuelta.

## 7. Bloqueos y decisiones abiertas

1. **Casos de moderación pendientes (D12/D15): resuelto en DEL-1** (ver §9).
2. **Contactos de apelación** (`copyright_appeals.contact_name/contact_email`): quedan retenidos (evidencia restringida); la anonimización posterior
   depende de la política de retención.
3. **Apelación pendiente** de una reclamación `author_deleted`: queda `pending` (no se resuelve en nombre de nadie); DEL-3 debe mostrarla como cerrada.
4. **Tipos TypeScript de Copyright:** `copyright-contract.ts`/parsers y la UI de reclamaciones no conocen `author_deleted` ni el actor `system`; **DEL-2 debe
   actualizarlos antes de aplicar la migración en un entorno con tráfico**, o el panel rechazaría esas filas.
5. **Avatar:** hoy ningún flujo escribe `avatar_path`; si apareciera, la etapa `profile` falla cerrada.

## 8. Contratos posteriores

**DEL-2:** endpoints (en el dispatcher existente, sin función serverless nueva) para solicitar, previsualizar y confirmar; correo en inglés con enlace;
rate limit del endpoint; `requireAuthenticated` + `account_deletion_gate`; generación/hash del token; ejecutor (cron o `waitUntil`) con `claim/step_*`,
integración Auth (ban, revocar, `deleteUser`) y R2 (GC existente); `account_deletion_expire_pending` periódico; endpoint Developer (alertas y reintento);
actualización de tipos/parsers de Copyright; correo de cierre opcional; procedimiento de cuentas privilegiadas.
**DEL-3:** UI ES/EN/DE (zona de peligro en la cuenta, pantalla del enlace, confirmación final, estado), panel Developer (alertas, botón de reintento),
smoke y validación final, actualización de `PrivacyPage` y de la política (pendiente de revisión legal).

## 9. D15 — Cierre administrativo de casos de Community (implementado en DEL-1)

- **Representación:** `community_moderation_cycles.closure_kind` admite `author_deleted` (junto a `legacy` y `decision`). Es un **motivo de cierre**, no una
  decisión: no se crea fila en `community_moderation_decisions`, ni strike, ni aviso a la autora, ni cuenta como «procede / no procede». El caso pasa a
  `closed` (`closed_at`, `activity_at`, `version + 1`). El contexto diferido existente solo exige decisión cuando `closure_kind = 'decision'`, así que no
  hubo que tocar triggers ni RPC de moderación. Los reportes no se modifican (no se «resuelven» en nombre de nadie).
- **Dónde:** dentro de `account_deletion_stage_content`, en la **misma transacción** que el borrado de la publicación (orden de bloqueo
  publicación → caso, como el resto de Community). Así nunca existe una publicación en cuarentena con ciclo cerrado ni una referencia pública inválida, y
  un fallo (probado con un trigger que aborta el borrado) deshace caso, ciclo, evento y publicación; el reintento lo completa sin duplicados.
- **Alcance:** casos `pending` cuyo `target_author_user_id` es la cuenta **o** cuya publicación es suya (incluye casos cuya publicación ya fue borrada por
  la autora). Un caso ya `closed` (decisión humana, `legacy` u otro cierre) **no se toca ni se reabre**. Repetir la etapa no cierra nada más (`casesClosed: 0`).
- **Auditoría:** un evento `case_closed` por caso en `account_deletion_events` (actor `system`, `metadata = {caseId, closureKind}`; sin datos personales).
  **No se amplió `moderation_audit_log`**: sus CHECK (acciones; actor `system` solo para `post_quarantined/post_purged`) y los lectores TypeScript del
  historial no admiten acciones nuevas sin ampliar su contrato; decisión consciente para no tocar Community más de lo necesario. El ciclo conserva
  `closed_at` y `closure_kind`, y `moderation_audit_log` conserva todo el historial previo. Reflejarlo también ahí sería una migración aparte.
- **Colas y estadísticas:** la cola «Activos» y `community_moderation_pending_count` filtran por ciclo `pending`, así que el caso sale solo. Los cierres no
  aparecen como decisiones (no hay fila de decisión). TypeScript: `closureKind` acepta `"author_deleted"` en `moderation-case-contract.ts` y
  `moderation-case-parser.ts` (probado leyendo la RPC real con el parser).
- **Distinto de Copyright:** `author_deleted` en Copyright es un **estado de reclamación**; en Community es un **motivo de cierre de ciclo**. Se cierran por
  vías y tablas distintas (etapas 2 y 3), sin compartir filas ni eventos; probado que conviven.
- **Pendiente para DEL-2:** invocar la etapa (ya existe), registrar `casesClosed`, y mostrar el motivo de cierre en la UI de moderación (etiqueta ES/EN/DE).

## 10. D16 — Datos personales, username y no herencia (DEL-1)

**Inventario inspeccionado (FK a `auth.users` y tablas con datos de la cuenta):**

| Dato                                                             | Dónde                                                                             | Tratamiento                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Correo, credenciales, identidades, MFA                           | `auth.*` (Supabase Auth)                                                          | Se borran en `auth_delete` (DEL-2, `deleteUser`); el correo solo se lee al solicitar            |
| Perfil: `username`, `display_name`, `bio`, `avatar_path`         | `public.profiles` (única fuente del username, `unique`)                           | `profile` borra la fila                                                                         |
| Publicaciones, medios, «me gusta»                                | `community_posts`, `community_post_media`, `community_post_likes`, `media_assets` | `community_content` + GC de R2; huérfanos no vinculados se re-marcan en `media_gc`              |
| Comentarios, preferencias, notificaciones del usuario            | **No existen tablas** en el esquema actual                                        | Nada que borrar; si se añaden, deben entrar en una etapa y en el catálogo                       |
| Roles / invitaciones / OAuth social                              | `admin_roles`, `admin_invitations`, `social_oauth_flows`                          | Solo cuentas privilegiadas (flujo separado, D10); FKs `SET NULL`/`CASCADE` ya existentes        |
| Reportes enviados, casos, ciclos, decisiones, strikes, auditoría | Sin FK a la cuenta                                                                | **Se conservan** con el UUID original (evidencia restringida, retención `pending_legal_review`) |
| Reclamaciones Copyright, eventos, avisos, apelaciones            | `copyright_*`                                                                     | **Se conservan** (evidencia mínima); el contacto de apelación queda pendiente de anonimizar     |
| Solicitud, etapas y eventos de eliminación                       | `account_deletion_*`                                                              | Se conservan (UUID, sin correo ni token)                                                        |

`profiles` **no** contiene todo: la tabla separa lo que se borra de lo que se conserva por finalidad justificada.

**Liberación del username (sin segunda fuente de verdad, sin cuarentena ni reserva):**

1. El username vive solo en `profiles.username` (único, minúsculas). Mientras exista la fila nadie más puede tomarlo (el índice único sirve de exclusión
   mutua frente a registros simultáneos).
2. Orden obligatorio: `copyright_claims` → `community_content` (casos cerrados, publicaciones y «me gusta» fuera) → **`profile`** → `media_gc` → `auth_delete`.
   La etapa `profile` se **niega** (`content_stage_incomplete`) si queda algo público: el username nunca se libera antes de retirar las asociaciones.
3. Borrar la fila libera el nombre. Si la etapa falla (p. ej. `avatar_path`), el username sigue reservado, la cuenta sigue bloqueada y la etapa queda
   pendiente y alertada. La cuenta bloqueada **no puede recrear su perfil** (trigger `BEFORE INSERT` en `profiles`), así que no recupera el nombre liberado.
4. Un nuevo registro obtiene otro `auth.users.id`: **no hereda** strikes, reportes, casos, reclamaciones, publicaciones, archivos, permisos, bloqueo ni
   auditoría (probado). Todo el historial se une por UUID; el username solo se lee en vivo desde `profiles` en las vistas de moderación (cero copias; una
   prueba estática recorre todas las migraciones buscando joins por username). Tras borrar el perfil, el historial muestra autor sin nombre.
5. Fuera de la base de datos: los enlaces antiguos a una publicación dejan de resolver (no hay tombstone); cachés de CDN o del navegador pueden seguir
   mostrando contenido o nombre antiguo hasta caducar. **DEL-2 debe emitir `Cache-Control` corto o `no-store` en las respuestas públicas de Community.**
   No se reserva el nombre para evitarlo.

**Límites operativos para la política de privacidad (sin afirmar cumplimiento legal):** copias de seguridad del proveedor (Supabase, Cloudflare) fuera
de nuestro control inmediato; URLs firmadas ya emitidas válidas hasta su caducidad; evidencia conservada (reportes, casos, strikes, reclamaciones,
auditoría) bajo acceso restringido con plazos por definir; la revisión legal sigue pendiente.

## 11. Orden de operaciones que DEL-2 debe respetar

1. `request` (endpoint autenticado + gate) → correo con enlace (token de 256 bits, solo el hash en BD, 30 min).
2. Pantalla del enlace → `preview` (solo lectura) → confirmación explícita → `confirm` con **token + id de la sesión verificada**. Aquí queda bloqueada la cuenta.
3. Responder «eliminación aceptada» **solo si `confirm` devolvió `confirmed` o `already_deleting`** (fail-closed ante cualquier otro resultado).
4. Ejecutor (cron o `waitUntil`; mismo código para reintentos automáticos y manuales): `claim` → por etapa `step_start` → trabajo → `step_finish`.
   `auth_block` (ban + revocar sesiones + impedir login) → `copyright_claims` → `community_content` (incluye el cierre D15) → `profile` (username) →
   `media_gc` (reintenta mientras el GC borra) → `auth_delete`.
5. **Supervivencia de metadatos:** `account_deletion_*` no tiene FK a `auth.users`, así que sobrevive a `deleteUser`. `auth_delete` es la última etapa; si falla,
   la cuenta sigue bloqueada (ban + barrera) y la solicitud en reintento y alerta. Si `deleteUser` tuvo éxito pero `step_finish` falló, el reintento debe
   tratar «usuario inexistente» como éxito de la etapa (idempotente).
6. Todos los endpoints protegidos, la lectura de media y las URLs privadas deben consultar `account_deletion_gate`; hasta que lo hagan **no se debe afirmar**
   que los JWT emitidos están neutralizados para lecturas (los triggers de DEL-1 solo cubren escrituras). Las URLs firmadas ya emitidas no son revocables.
7. Reintentos: automáticos con el backoff del §4; manuales por developer con `account_deletion_developer_retry` (reprograma; el ejecutor ejecuta).
8. Actualizar parsers, tipos y UI de Copyright (`author_deleted`, actor `system`) **antes** de aplicar la migración con tráfico.

## 12. Contrato DEL-3

UI de solicitud y confirmación en ES/EN/DE con advertencia explícita de **irreversibilidad** (sin cancelación ni restauración tras confirmar); texto exacto
sobre qué se borra, qué se conserva y por qué (evidencia restringida, plazos por definir) y los límites de copias de seguridad y URLs firmadas; estado de
limpieza **sin botón de cancelar**; panel Developer con alertas (sin identidades) y acción de reintento autorizada solo a developer; errores mostrados con
códigos seguros (nunca payloads del proveedor); etiqueta del cierre `author_deleted` en la moderación de Community y Copyright; actualización de
`PrivacyPage` (hoy desactualizada) tras revisión legal; smoke final con cuentas de prueba.

> **Estado:** el contrato DEL-2 de este documento está implementado en local; ver `docs/DEL-2-ACCOUNT-DELETION-BACKEND.md`.
