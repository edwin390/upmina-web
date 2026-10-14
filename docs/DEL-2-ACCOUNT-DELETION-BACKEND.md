# DEL-2 — Backend de eliminación irreversible de cuentas

Estado: **implementado y probado en local; NADA aplicado ni desplegado** (DEV, Production, R2, alias y Git remoto sin cambios). Se apoya en DEL-1
(`docs/DEL-1-ACCOUNT-DELETION.md`) y no rediseña sus decisiones D1–D16. La interfaz es DEL-3.

## 1. Endpoints (dispatcher `api/admin/[action].ts`, función serverless 12/12: sin función nueva)

| Acción                     | Método | Autenticación                                                              | Qué hace / responde                                                                                                                                                                                |
| -------------------------- | ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account-deletion-request` | POST   | Sesión (JWT verificado; el cuerpo debe ir vacío)                           | Genera 256 bits, guarda **solo el SHA-256**, envía el correo en inglés. `200 {ok, expiresInMinutes:30}`. 403 privilegiada · 429 límites · 409 ya en eliminación · 502 correo · 503 sin config      |
| `account-deletion-preview` | POST   | Sesión (**atiende cuentas bloqueadas**)                                    | `{token}` → `{state: valid\|expired\|invalid\|already_deleting}`. Solo lectura: **no consume ni borra**                                                                                            |
| `account-deletion-confirm` | POST   | Sesión (**atiende cuentas bloqueadas**)                                    | `{token, confirm:true}` → RPC atómica. `202 accepted` solo tras comprobar la barrera durable · `200 already_deleting` · 400 token inválido/consumido/otra cuenta · 410 caducado · 403 privilegiada |
| `account-deletion-run`     | POST   | Firma HMAC `UPMINA-ACCOUNT-DELETION-V1` (`ACCOUNT_DELETION_SHARED_SECRET`) | Interno (despertador de la BD). Cuerpo vacío, sin parámetros; ventana ±30 s. Devuelve solo recuentos                                                                                               |
| `account-deletion-alerts`  | GET    | `developer_panel` + MFA reciente                                           | `{alerts}` (sin user_id, correo ni tokens)                                                                                                                                                         |
| `account-deletion-retry`   | POST   | `developer_panel` + MFA reciente                                           | `{requestId}` → reprograma (no ejecuta) y despierta al ejecutor. 404 · 409 (`already_completed`, `retry_not_applicable`) · 403                                                                     |

Común: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, identidad solo del JWT, errores genéricos sin texto de la BD ni del proveedor.
Token: 32 bytes `base64url` (43 caracteres), caducidad **30 min**, en el **fragmento** del enlace (`/account/delete#t=…`): el GET de la página nunca lo envía al
servidor ni lo filtra por `Referer`. No hay cookies de sesión, así que no aplica CSRF clásico; la acción destructiva exige además `confirm:true` y sesión+token a la vez.
Límites anti-abuso del correo: 60 s entre solicitudes y 5 en 24 h por cuenta (en la RPC); el correo solo va a la dirección de la propia cuenta.
Si el correo falla (502) el token nunca salió del servidor: la solicitud queda pendiente y caduca sola (o la sustituye la siguiente); no existe estado a medias explotable.

## 2. Bloqueo de acceso: qué está cubierto y qué no

**Barrera central:** `requireAuthenticated` (`src/lib/admin-auth.ts`) consulta `account_deletion_gate` tras verificar el JWT, y la usan **todas** las rutas autenticadas
(Community, media, perfil, moderación, Copyright, equipo, social, Developer: todas pasan por `requireAuthenticated`, directamente o vía `requirePrivileged`/`requireCapability`).
Una cuenta bloqueada recibe el mismo `401 No autenticado` que un token inválido. **Fail-closed:** si el gate no responde o devuelve algo inesperado, el acceso se deniega (5xx). Solo
`account-deletion-preview/confirm` usan `allowDeletingAccount`. Coste: una RPC adicional por petición autenticada.

| Vía                                                                             | Estado                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoints `/api/*` autenticados (incluye subidas y lecturas privadas)           | **Protegida** (gate en `requireAuthenticated`; probado con dobles)                                                                                                                                                                                                              |
| Escrituras en BD de la cuenta (posts, likes, reportes, archivos, perfil, roles) | **Protegida** (triggers de DEL-1, probados con SQL real)                                                                                                                                                                                                                        |
| Consultas directas a Supabase con el JWT (RLS)                                  | **Sin exposición privada que bloquear:** el único `GRANT` a `authenticated` en todo el esquema es `SELECT` sobre `profiles`, ya público para `anon` y borrado en la etapa `profile`. El resto de tablas y RPC solo las toca `service_role`. No se modificó ninguna política RLS |
| Realtime / Storage de Supabase                                                  | No se usan en el código                                                                                                                                                                                                                                                         |
| Nuevos inicios de sesión y renovación de tokens                                 | Etapa `auth_block`: `ban_duration` en Auth. **Pendiente de validación desplegada**                                                                                                                                                                                              |
| Sesiones ya emitidas frente a **GoTrue directo** (`/user`, `/token`)            | Etapa `auth_block` borra `auth.sessions` (cascada a refresh tokens). Se espera que GoTrue rechace el JWT cuyo `session_id` ya no existe, pero **no está verificado contra un Supabase real**: pendiente de prueba controlada                                                    |
| **JWT de acceso ya emitido** (hasta ~1 h)                                       | Inútil en nuestros endpoints (gate). Sigue siendo válido criptográficamente; no se puede revocar                                                                                                                                                                                |
| **URLs firmadas de R2 / cápsulas del Worker de entrega ya emitidas**            | **NO revocables**: viven hasta su caducidad. DEL-2 no emite nuevas (el endpoint que las firma exige sesión ⇒ gate). Límite real, a reflejar en la política de privacidad                                                                                                        |
| Cachés de CDN de Community                                                      | Las respuestas públicas ya usan `s-maxage=30, stale-while-revalidate=120` (≤ ~150 s). No se cambió                                                                                                                                                                              |

**No se declara el bloqueo «completo»** hasta validar en un entorno desplegado: sesiones/GoTrue directo, ban, y que no quede ninguna ruta que acepte el JWT sin `requireAuthenticated`
(auditoría estática realizada: las rutas públicas no usan `Authorization`).

## 3. Ejecutor (`src/lib/account-deletion-worker.ts`)

Reutiliza `claim → step_start → step_finish → release` de DEL-1 (no hay una segunda máquina de estados). Orden y trabajo externo:

1. `auth_block`: `auth.admin.updateUserById(ban_duration)` + RPC `account_deletion_revoke_sessions`. Identidad ya inexistente = bloqueada.
2. `copyright_claims`, 3. `community_content` (incluye D15), 4. `profile` (libera el username): RPC SQL de DEL-1.
3. `media_gc`: RPC `account_deletion_stage_media`; **solo termina con 0 archivos pendientes** (si no, `media_gc_pending`, reintento en 5 min). El GC físico es el existente (`/api/media/gc`).
4. `auth_delete`: `auth.admin.deleteUser(id, false)` (borrado duro). `404/user_not_found` = éxito (el estado y el lease ya verificaron la identidad). `last_admin_protected` ⇒ manual.

Concurrencia y recuperación: el lease lo decide la BD; perder el lease detiene al worker sin registrar nada; un worker caído se recupera al vencer el lease (la etapa `running` vuelve a
`pending`); sin tiempo (`budgetMs`) el worker hace `release` sin contar fallo. Los metadatos (`account_deletion_*`) no tienen FK a `auth.users`: sobreviven a `deleteUser`, y la barrera
sigue activa con la cuenta de Auth ya inexistente (probado). Errores del proveedor se reducen a códigos cerrados; nunca se registra texto del proveedor, ids ni tokens.

## 4. Developer

`account-deletion-alerts` lee `account_deletion_alerts` (la RPC reverifica `developer`); `account-deletion-retry` llama a `account_deletion_developer_retry` (reprograma etapas fallidas,
auditoría con actor humano, barrera intacta) y despierta al **mismo** ejecutor. Admin, Moderator y usuarios reciben 403 (la capacidad `developer_panel` es exclusiva del rol). La alerta
permanece hasta `completed`. Interfaz y botón: DEL-3.

## 5. Migración adicional y programación

`supabase/migrations/20261114120000_account_deletion_runtime.sql` (+ rollback): `account_deletion_revoke_sessions` (service_role), `account_deletion_backlog` y `account_deletion_tick`
(solo `postgres`). El tick expira solicitudes vencidas y, **solo si hay trabajo**, hace UN `POST` firmado a `/api/admin/account-deletion-run`. **La programación NO está en la migración**
(aplicarla no activa el flujo). Antes de habilitar el flujo real, un operador debe, por entorno:

1. Aplicar `20261113120000` y `20261114120000` (en este orden) **antes** de desplegar el código nuevo: con el código nuevo y sin la migración, `requireAuthenticated` deniega a todos (fail-closed).
2. Variables del backend: `ACCOUNT_DELETION_SHARED_SECRET` (≥ 32 caracteres) y, si el origen del enlace debe diferir, `ACCOUNT_DELETION_APP_URL` (https, sin ruta); correo: las `MFA_RECOVERY_*` ya existentes.
3. Vault: `account_deletion_shared_secret` (mismo valor) y `account_deletion_endpoint_url` (`https://<host>/api/admin/account-deletion-run`).
4. Programar: `select cron.schedule('account-deletion-tick', '* * * * *', $$select public.account_deletion_tick();$$);` (cada minuto: expiración de tokens, reclamación, reintentos con backoff,
   leases vencidos y estancados). Sin este job, los reintentos solo ocurren al confirmar o al pulsar el reintento de Developer.
5. Mientras `account_deletion_alerts` lo muestre, vigilar `stalled` (sin reclamar > 15 min).

## 6. Compatibilidad Community / Copyright / username

- Copyright: `copyright-contract.ts` acepta el estado `author_deleted`, el evento `author_deleted` y el actor `system` (el panel ya no rechaza esas filas); etiquetas mínimas ES/EN/DE añadidas
  para que el tipado compile (el texto definitivo es de DEL-3). `author_deleted` queda fuera de «casos abiertos» (va al historial).
- Community: `closureKind` acepta `author_deleted` (DEL-1). Strikes, casos y auditoría se conservan; sin notificaciones de sanción.
- Username: se libera en la etapa `profile` solo tras retirar lo público; la cuenta bloqueada no puede recrear su perfil; el historial se une por UUID (DEL-1 §10).

## 7. Validación y límites

Probado en local: 26 pruebas con dobles (contrato de endpoints, ejecutor, correo, firma), 45 de SQL real (PGlite) que incluyen el **ejecutor TypeScript real contra las RPC reales** (con
Auth y R2 como dobles), 5 de la barrera en `requireAuthenticated`. **No validado (requiere entorno controlado):** concurrencia real entre conexiones, `ban_duration` y revocación de sesiones
de Supabase Auth reales, `deleteUser` real y sus FK en DEV, entrega real del correo, GC real de R2, `pg_cron/pg_net/Vault`, y que GoTrue rechace JWT de sesiones eliminadas.

## 8. Validación controlada en Supabase DEV (2026-10-14)

Proyecto `upmina-9g-test` (ref `rkqeqb…`, el vinculado en `supabase/.temp`; el otro proyecto de la cuenta no se tocó). Migraciones `20261113120000` y `20261114120000` **aplicadas en DEV**, en
orden, tras `--dry-run` (solo esas dos pendientes) y un ensayo completo dentro de `BEGIN … ROLLBACK` sobre los datos reales.

**Defecto encontrado y corregido antes de aplicar:** el primer intento falló y se revirtió por completo (migración atómica; 0 objetos creados): `copyright_claim_events_kind_check` se
redefinía sin `strike_applied`, `strike_notified` y `strike_notification_failed`, que existen en DEV. PGlite no lo detectó porque parte de una base vacía. Corregido en la migración y en el
rollback, con una prueba estática que exige que las listas coincidan con `CLAIM_EVENT_KINDS` / `CLAIM_STATUSES`. Lección: toda migración que redefine un CHECK debe ensayarse contra datos reales (ensayo en transacción).

Resultados reales (cuenta sintética `del2-validation-*@upmina-test.invalid`, sin roles ni datos; creada con la API de administración sin enviar correo; eliminada al final):

| Superficie                                                                                     | Antes del bloqueo | Tras ban              | Tras borrar sesiones                             | Estado                                                                     |
| ---------------------------------------------------------------------------------------------- | ----------------- | --------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| GoTrue `/user` con el access token anterior                                                    | 200               | **403 `user_banned`** | **403 `session_not_found`**                      | Verificado                                                                 |
| GoTrue `PUT /user` (modificar cuenta)                                                          | —                 | —                     | **403 `session_not_found`**                      | Verificado                                                                 |
| Refresh token anterior (no usado antes)                                                        | 200 (control)     | **400 `user_banned`** | **400 `refresh_token_not_found`**                | Verificado                                                                 |
| Nuevo login con contraseña                                                                     | 200               | **400 `user_banned`** | 400 `user_banned` (con desbaneo de control: 200) | Verificado                                                                 |
| PostgREST, `profiles` (público)                                                                | 200               | 200                   | 200                                              | **Riesgo aceptado**: el JWT sigue válido, pero solo ve lo que ya ve `anon` |
| PostgREST/RLS, 6 tablas privadas (posts, roles, bloqueos, reclamaciones, strikes, medios)      | 403 `42501`       | 403                   | 403                                              | Verificado: sin concesión a `authenticated`                                |
| PostgREST RPC (`account_deletion_gate`, `account_deletion_request`, `community_account_state`) | 403 `42501`       | 403                   | 403                                              | Verificado                                                                 |
| `account_deletion_gate` (service_role)                                                         | `blocked:false`   | —                     | —                                                | Verificado                                                                 |
| Endpoints propios de Upmina                                                                    | —                 | —                     | —                                                | **No probado** (no hay despliegue de DEV con DEL-2)                        |

Barrera, ejecutada con las RPC reales dentro de una transacción **revertida** (0 filas persistidas): `request → preview → confirm` ⇒ `confirmed`, gate `blocked:true`; repetir ⇒ `already_deleting`;
escrituras de la cuenta bloqueada (post, perfil, rol, archivo, reporte) ⇒ `account_deletion_blocked`; borrar la barrera ⇒ `account_deletion_record_permanent`; volver a pendiente ⇒
`account_deletion_invalid_transition`; `claim → step_start → revoke_sessions` ⇒ `sessionsRevoked: 1` con una sesión real; las cuatro etapas SQL se ejecutan sobre el esquema real; admin y
moderator reciben `actor_not_developer` en alertas y reintento; el `tick` sin secretos de Vault devuelve `runner_not_configured` (no llama a nadie). Una cuenta activa conserva todas sus escrituras
(perfil, publicación, edición, me gusta). Idempotencia de Auth observada: `DELETE` de usuario inexistente ⇒ `404 user_not_found`; `ban` de usuario inexistente ⇒ `404 user_not_found` (ambos
clasificados como «no existe» por el ejecutor).

Conclusión de seguridad: **el JWT de acceso anterior deja de ser aceptado por GoTrue** (con ban o con la sesión borrada), no se puede renovar ni iniciar sesión; lo único que sigue aceptando es PostgREST,
donde solo concede lecturas públicas. La protección de los endpoints propios descansa en `account_deletion_gate` (probado con dobles y SQL real, **no en un despliegue**).
Sin cambios en datos existentes (usuarios 15, perfiles 10, publicaciones 13, roles 3, strikes 5, reclamaciones 8, casos 86, decisiones 36), sin jobs nuevos (solo `community-media-purge-tick`).
