# 9K — Developer Panel V1

Estado: Developer Panel V1 (migración `20261101120000` y despliegue) **ya integrado en DEV** (Lotes 1 y 2). La
transición Admin → Developer por autotransferencia, la restauración y la espera de seguridad (migración
`20261102120000`) están **implementadas solo en local, sin aplicar en ningún entorno** y sin cuentas Developer ni
cambios de roles. Depende de MFA fase 1 y fase 2 (ya validadas en DEV) y no las altera.

## 1. Alcance

Exactamente dos funcionalidades, en `/admin/developer`:

1. **Limpiezas de MFA pendientes** (fase 1): supervisión de **solo lectura**.
2. **Recuperaciones excepcionales** (fase 2): aprobar o rechazar la recuperación de un Admin que es el
   **único administrador elegible**.

No se implementa ninguna otra herramienta Developer. No se toca la limpieza R7 de medios huérfanos ni REP-1.

## 2. Roles y permisos

| Rol       | Capacidades                                                    | `developer_panel` |
| --------- | -------------------------------------------------------------- | ----------------- |
| admin     | moderation, technical, social_admin, team_admin, cosplay_admin | **no**            |
| developer | moderation, technical, **developer_panel**                     | **sí**            |
| moderator | moderation                                                     | no                |

- **Independientes, sin jerarquía.** Developer no hereda nada de Admin (ni `team_admin`, ni `social_admin`,
  ni `cosplay_admin`); Admin no recibe `developer_panel`. La única tabla es `ROLE_CAPABILITIES`
  (`src/lib/admin-auth.ts`). `technical` no cambia.
- **Admin no concede, retira ni modifica Developer.** `change_admin_member_role` y `remove_admin_member`
  (y por tanto `admin_remove_member_with_mfa_reset`) lanzan `developer_protected` si el rol nuevo o el
  anterior es `developer`; la API de equipo solo acepta `admin | moderator` en el cuerpo y responde 409
  genérico a `developer_protected`; la interfaz de equipo no ofrece Developer ni controles sobre un
  Developer. Las invitaciones (`admin_invitations.role in ('admin','moderator')`) y el bootstrap
  tampoco pueden producir Developer.
- **Asignación solo por autotransferencia** (§6): un Admin solo puede transferir SU PROPIA cuenta; ni el backend, ni un Admin sobre otra cuenta, ni un Developer, ni el operador pueden asignar el rol (el alta por el operador se retiró).
- **Autorización de cada endpoint** (`requireCapability(req, "developer_panel", …)`): rol `developer` en
  `admin_roles` → capacidad → MFA reciente (30 min). Decidir (POST) exige además un **TOTP verificado
  hace ≤ 5 minutos** (`DEVELOPER_APPROVAL_TOTP_WINDOW_SECONDS = 300`), medido con el timestamp `amr` del
  JWT verificado; `aal2` solo prueba que la sesión pasó MFA alguna vez. La capacidad se comprueba antes
  que la recencia: un Admin recibe 403 genérico, nunca `step_up_required`.

## 3. Elegibilidad de «otro administrador»

`admin_mfa_recovery_peer_available(user)` (interna, sin `EXECUTE` para ningún rol de API): existe un admin
**distinto del solicitante**, con fila vigente en `admin_roles`, cuenta **no eliminada** (`deleted_at`),
**no bloqueada** (`banned_until` futuro) y con **TOTP verificado**. La ausencia temporal o la pérdida
declarada del dispositivo no vuelve inelegible a nadie: no se miran sesiones, solicitudes ni actividad.

Consecuencias:

- Hay otro admin elegible → solo otro Admin aprueba (flujo normal, sin cambios); Developer recibe
  `peer_available` y la solicitud desaparece de su lista.
- El solicitante es el único admin elegible → un Developer **distinto** puede aprobar o rechazar.
- Dos admins que perdieron ambos el dispositivo: mientras cada uno conserve un TOTP verificado, cada uno es
  elegible para aprobar al otro. En cuanto se ejecuta la primera recuperación y se borran sus factores, esa
  cuenta deja de ser elegible y la segunda pasa a ser «único elegible».
- La solicitud puede crearse si hay otro admin **o** un Developer (antes: solo otro admin).
  `admin_mfa_recovery_current.hasApprover` usa el mismo criterio.

## 4. Aprobación excepcional

`admin_mfa_recovery_approve_exceptional(recovery, actor, cancel_hash)` (solo `service_role`):

1. toma `upmina_lock_admin_roles()` **antes** de cualquier `FOR UPDATE` (regla de 9B);
2. el actor debe ser `developer` (`actor_not_developer`); nadie aprueba la suya (`self_approval`);
3. revalida existencia, estado `pending_approval`, vigencia, correo y rol sin cambios (cierra la solicitud
   si caducó o cambió);
4. exige solicitante `admin` (`not_eligible`) y **ningún otro admin elegible en ese instante**
   (`peer_available`);
5. fija `approval_kind='exceptional'`, `approver_role='developer'`, `approved_by`, el hash del enlace de
   cancelación, y registra el evento `approved` con detalle `exceptional:developer` (un solo evento).

`admin_mfa_recovery_deny_exceptional` rechaza una solicitud elegible en `pending_approval` o **revierte la
aprobación excepcional** propia mientras no se ejecute (`closed_reason='denied_by_developer'`). Una
aprobación entre administradores no se puede revertir desde Developer.

Todo lo demás es el mecanismo de la fase 2, sin cambios: aviso de aprobación con enlace de cancelación,
`delivered` por webhook firmado, espera de 15 min desde la aprobación y la entrega, instantánea de ids
TOTP, borrado exacto, nuevo TOTP y cierre automático. **No existe ningún endpoint ni RPC genérico de borrado
de factores** en Developer (test estático sobre el módulo).

Correo: igual que el normal (mismo envío, token, clave de idempotencia, reenvío con rotación), con una frase
inglesa adicional: «This request was authorized by a platform Developer because no other administrator was
available to approve it.»

## 5. Endpoints (dispatcher `api/admin/[action].ts`; sin funciones serverless nuevas)

| Ruta                       | Método                                                          | Efecto                                                            |
| -------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `developer-mfa-cleanups`   | GET                                                             | Lista de limpiezas (solo lectura).                                |
| `developer-mfa-recoveries` | GET                                                             | Solicitudes elegibles + historial excepcional (30 días, máx. 50). |
| `developer-mfa-recoveries` | POST `{op: approve\|deny\|resend_notice, recovery_id, reason?}` | Decisión con TOTP ≤ 5 min.                                        |

El actor sale solo del JWT; el cuerpo nunca lo elige. Lecturas con `Cache-Control: no-store`. Las lecturas
no devuelven correos completos (máscara `m***@e***.com`), ids de factores, hashes ni tokens; el token de
cancelación solo viaja en el correo.

**Interfaz.** `/admin/developer` (lazy, `DeveloperPage`): sin sesión → login con `returnTo=/admin/developer`
(añadido a la allowlist, sin parámetros); no-Developer → denegado **sin MFA**; Developer sin MFA reciente →
`/admin/mfa?returnTo=/admin/developer`; anti-bucle `fromMfa`. Antes de aprobar, rechazar o reenviar, la
página pide el código del autenticador y lo verifica con Supabase (`challenge` + `verify`,
`src/lib/totp-reverify.ts`) para obtener un TOTP recién verificado; el código no se envía a nuestros
endpoints ni se guarda. (`/admin/mfa` no sirve para esto: con el MFA general vigente no pide el código.)

## 6. Transición Admin → Developer (autotransferencia) y restauración

Migración `20261102120000_developer_transition.sql` (**no aplicada**; rollback en `supabase/rollbacks/`).

**Autotransferencia** — panel Admin, sección siempre visible «Convertirme en Developer»
(`BecomeDeveloperSection`; `GET`/`POST /api/admin/team-developer-transfer`):

- La función `admin_transfer_self_to_developer(actor)` **no tiene parámetro de objetivo**: solo transfiere al propio
  actor, que sale del JWT. No existe ninguna función que asigne Developer a otra cuenta; `change_admin_member_role` y
  `remove_admin_member` siguen rechazando `developer` (`developer_protected`), la API de equipo solo admite
  `admin | moderator`, y la interfaz no ofrece Developer.
- Requisitos, todos bajo `upmina_lock_admin_roles()` (tomado PRIMERO) y revalidados en la transacción: el actor es
  admin; existe **otro admin elegible** (§3); **no hay ninguna recuperación de MFA activa de ningún admin**; el trigger
  de último admin sigue vigilando. Efecto: rol `developer`, invitaciones estándar pendientes del actor revocadas y una
  fila `self_transferred` en `admin_developer_audit` (actor = objetivo, `clock_timestamp()`).
- Backend: `team_admin` + TOTP verificado hace ≤ 5 min + `acknowledge: true` en el cuerpo (aceptación explícita de la
  pérdida de acceso); el cuerpo no puede elegir cuenta. La página verifica el TOTP con Supabase (`reverifyTotp`) antes
  del POST. Sin frase escrita de confirmación.
- Efecto inmediato: el rol se lee de `admin_roles` en cada petición, así que el siguiente request como Admin da 403; la
  interfaz descarta la caché de permisos y navega a `/admin/developer`.
- El botón se deshabilita con un motivo sencillo (sin otro Admin que pueda quedarse a cargo / recuperación en curso /
  no se pudo comprobar) y se confirma de nuevo en el servidor.

**Restauración** — gestión del equipo, fila de un Developer (`DeveloperRestoreControls`;
`POST /api/admin/team-developer-restore`): otro Admin lo devuelve a **Moderador o Admin** (nunca a Developer), con
confirmación, TOTP ≤ 5 min y auditoría `restored` (actor ≠ objetivo). La base rechaza si el objetivo no es Developer,
si tiene una recuperación activa o si, para volver a Admin, no tiene TOTP verificado. Un Developer no tiene ninguna
ruta para cambiar su propio rol ni el de nadie; el selector normal de roles no actúa sobre un Developer.

**Operador (solo emergencia y configuración):** `operator_grant_developer` se **retiró**. Se conserva
`operator_revoke_developer` (developer → moderator) y se añade `operator_set_developer_cooldown`
(`supabase/operator/developer-role.sql`, plantilla que ninguna herramienta ejecuta; sin `EXECUTE` para ningún rol de API).

**Si Developer pierde su autenticador:** pide la recuperación normal (fase 2) y la aprueba un Admin elegible; conserva
el rol. Si no hubiera ningún admin elegible, el propietario elimina el factor TOTP desde los controles de Supabase y la
persona enrola uno nuevo al iniciar sesión.

### Quitar acceso a un Developer (tercera migración, local, sin aplicar)

Migración `20261103120000_developer_removal.sql` (rollback en `supabase/rollbacks/`; se niega si ya hay retiradas).
`admin_remove_developer(actor, target)` — solo `service_role`, `SECURITY DEFINER`, `search_path` fijo:

- El actor sale del JWT (ruta `POST /api/admin/team-developer-remove`: `team_admin` + TOTP ≤ 5 min; el cuerpo solo
  nombra al objetivo) y se revalida en la base: ADMIN vigente bajo `upmina_lock_admin_roles()` (tomado PRIMERO).
  Nadie se retira a sí mismo.
- Retira la fila de `admin_roles` (los privilegios se revocan al instante: cada petición consulta `admin_roles`),
  revoca invitaciones estándar pendientes del objetivo y, **en la misma transacción**, registra la limpieza MFA con la
  infraestructura de la fase 1 (`admin_mfa_resets`: instantánea atómica de los ids TOTP existentes, la misma que escribe
  `admin_remove_member_with_mfa_reset` para Admin y Moderator; no hay un segundo sistema). `remove_admin_member` sigue
  rechazando `developer`; la lógica de retirada de Developer vive solo en `admin_remove_developer`. No borra la cuenta
  de auth, el perfil ni los contenidos.
- **Orden y fallos:** (1) la base confirma retirada + marca (o ninguna de las dos); (2) el backend ejecuta DESPUÉS
  `cleanupAfterRemoval` → `runMfaResetCleanup` (flujo existente): borra EXACTAMENTE los ids de la instantánea, 404 = ya
  resuelto, confirma con `listFactors` que ninguno sigue, y registra con `admin_mfa_reset_record` (auditoría
  `mfa_reset_completed`, actor = quien retiró). Un fallo del borrado, de la lectura o del registro deja la limpieza
  **pendiente** (clase de error sin detalles, `attempts`+1): la respuesta sigue siendo 200 «removed» con
  `mfa_reset: { status: "pending" }`, nunca devuelve privilegios y la interfaz nunca afirma que se retiró la verificación
  en dos pasos. Se reintenta desde «Autenticadores pendientes de restablecer» (`team-members-mfa-cleanup`) o al reinvitar.
- **Cuenta que recupera acceso:** mientras la limpieza está pendiente, `admin_mfa_activation_check` bloquea la activación
  de una invitación (`mfa_cleanup_pending`); después exige un factor TOTP verificado, en aal2 y NUEVO (fuera de toda
  instantánea y posterior a la retirada). Un factor creado después de la retirada no está en la instantánea, así que
  ni la limpieza ni sus reintentos pueden borrarlo. Si el objetivo ya tuviera una limpieza pendiente, la retirada se rechaza
  (`mfa_cleanup_pending`) en lugar de duplicar instantáneas.
- Se rechaza (409, sin cambios) con: recuperación propia activa (`recovery_in_progress`); recuperación activa
  aprobada por él (`approval_in_progress`); y, si es el ÚLTIMO Developer, una solicitud de Admin pendiente sin otro
  Admin elegible (`recovery_depends_on_developer`). Sin dependencias se permite, también el último Developer: la
  respuesta lleva `lastDeveloper` y la interfaz advierte antes (confirmación) y después (aviso).
- Auditoría append-only: `admin_developer_audit` acción `removed` (actor ≠ objetivo, `developer` → sin rol,
  `new_role` NULL solo para esta acción) y `admin_team_audit` `access_removed`. La protección del último Admin no cambia.
- Sin vías nuevas para conceder Developer; el único camino sigue siendo la autotransferencia.
- Procedimiento DEV propuesto (no ejecutado): comprobar antes (solo lectura) recuperaciones activas y que
  `admin_developer_audit` no tiene `removed`; `db push --dry-run` mostrando solo esta migración; aplicar; verificar
  función, permisos (solo `service_role`), columna `new_role` nullable, restricción y que roles, factores,
  recuperaciones e invitaciones no cambiaron (la limpieza MFA solo se crea al retirar a un Developer real); desplegar Preview; validar la interfaz sin pulsar «Quitar acceso».

### Espera de seguridad antes de aprobar recuperaciones excepcionales

Un Developer **recién transferido** no puede aprobar recuperaciones excepcionales hasta que pase una espera.

- **Fuente de configuración: la base de datos** (`admin_developer_settings`, clave
  `exceptional_approval_cooldown_minutes`, 0–10080 min). Se descartó la variable de entorno
  `DEVELOPER_EXCEPTIONAL_APPROVAL_COOLDOWN_MINUTES` como fuente: SQL no puede leerla de forma fiable, el backend podría
  divergir de la base y el frontend nunca es autoridad. **Sin fila, el valor por defecto es conservador: 1440 min
  (24 h)**; la migración no fija 60 en ningún entorno, así que no se aplica solo a Production.
- **DEV:** 60 min, que se configura de forma explícita con `operator_set_developer_cooldown(60, nota)` (Lote de
  integración). Cada cambio queda en `admin_developer_settings_audit`.
- **Inicio de la espera:** la última fila `self_transferred` (o `granted` histórico) de la cuenta en la auditoría
  append-only. Recargar, abrir otra sesión o reintentar no lo reinicia. Restaurar y volver a transferirse crea un inicio
  **nuevo y posterior** (siempre cuenta el más reciente): no sirve para eludirla.
- **Dónde se exige:** dentro de `admin_mfa_recovery_approve_exceptional` (SQL, con `clock_timestamp()`; sin parámetros de
  tiempo) y de forma previa en el backend (`409 cooldown_active` con `ready_at` y `remaining_seconds`). Se cumple
  **exactamente** al llegar a `inicio + espera`. Rechazar y revertir no están sujetos a ella (solo restringen).
- **Interfaz:** el panel Developer informa del tiempo restante en lenguaje sencillo («dentro de 30 minutos (a las 11:00)»),
  deshabilita «Aprobar» durante la espera y confirma con el servidor al terminar.
- **Cambiar el valor después:** `operator_set_developer_cooldown(minutos, nota)`. Afecta también a los Developers
  existentes (se evalúa con el valor vigente sobre su última transferencia): bajarlo habilita antes a quien ya esperaba;
  subirlo vuelve a bloquear a quien ya podía. Un Developer heredado sin transferencia registrada no tiene espera.
- **Production:** no recibe ningún valor al aplicar la migración (24 h por defecto); hay que decidirlo y configurarlo de
  forma explícita cuando se integre allí.

## 7. Base de datos

Migración `20261101120000_developer_panel.sql` (posterior a `20261031150000`, **no aplicada**) y rollback
`supabase/rollbacks/20261101120000_developer_panel.rollback.sql` (se niega si hay aprobaciones excepcionales,
auditoría de Developer o roles Developer; restaura las funciones anteriores).

- `admin_mfa_recoveries`: `approval_kind` (`peer` por defecto) y `approver_role`, con CHECK de coherencia e
  inmutabilidad tras aprobar (guard). Las solicitudes anteriores quedan `peer` con `approver_role` nulo
  (= admin, histórico); no se reescribe ninguna fila (el trigger de cierres terminales sigue intacto).
- Funciones nuevas (`SECURITY DEFINER`, `search_path` fijo, `EXECUTE` solo `service_role`, salvo las internas
  y las de operador, sin `EXECUTE` para nadie de API): `admin_mfa_recovery_peer_available`,
  `…_approve_exceptional`, `…_deny_exceptional`, `admin_mfa_recoveries_exceptional`,
  `admin_mfa_cleanups_for_developer`, `operator_grant_developer`, `operator_revoke_developer`.
- `create or replace` (mismas firmas, propietario y grants) con UN añadido cada una:
  `admin_mfa_recoveries_guard`, `admin_mfa_recovery_create`, `admin_mfa_recovery_current`,
  `change_admin_member_role`, `remove_admin_member`.
- `admin_developer_audit`: RLS + FORCE RLS, sin privilegios, append-only por trigger.
- Sin cambios en `admin_mfa_resets`, `runMfaResetCleanup` ni en los reintentos automáticos.

### Segunda migración (transición): `20261102120000_developer_transition.sql`

Incremental, sin modificar migraciones aplicadas; rollback revisado (se niega con transiciones o configuración ya
registradas). Contenido: `admin_developer_audit` + columna `actor_user_id` y acciones `self_transferred`/`restored`;
tablas `admin_developer_settings` y `admin_developer_settings_audit` (RLS forzada, sin privilegios, append-only);
funciones `admin_transfer_status`, `admin_transfer_self_to_developer`, `admin_restore_developer`,
`admin_developer_cooldown` (+ internas) y `operator_set_developer_cooldown`; se **elimina** `operator_grant_developer`;
`create or replace` de `admin_mfa_recovery_approve`, `_deny`, `_create` (toman el lock de roles primero) y de
`admin_mfa_recovery_approve_exceptional` (comprueba la espera). Mismas firmas, propietario y permisos.

## 8. Qué permanece en Admin hasta completar la transición

- La lista de limpiezas (`team-members-mfa-cleanups`, `MfaCleanupsSection`) **y el botón «Reintentar
  limpieza»** (`team-members-mfa-cleanup`): única acción que borra factores reales. Developer V1 no tiene
  reintento.
- La lista y las acciones de recuperación de Admin (`mfa-recovery-admin`, `MfaRecoveriesSection`), que
  siguen siendo el camino normal.
- Transición posterior (solo tras validar el panel Developer en DEV y con autorización expresa): decidir si
  el reintento pasa a Developer (V1.1: reutilizando `runMfaResetCleanup` tal cual, sobre una limpieza
  `pending` existente, con TOTP ≤ 5 min y límite de frecuencia) y, solo entonces, retirar la lista de Admin.

## 9. Mejoras de experiencia de la recuperación (incluidas en esta ronda)

- **Fragmento `#c=` con la página montada:** además de al montar, `AdminMfaRecoveryPage` escucha
  `hashchange`; el fragmento se retira de la URL **antes** de procesarlo (un segundo disparo ya no lo
  encuentra), el código se guarda solo en memoria y el estado se revalida una vez. Sin duplicados.
- **Código perdido tras recargar:** ayuda en la tarjeta de inicio de sesión y en el paso de verificación
  (reabrir el enlace del correo o pegar el enlace completo); nada se persiste en cookies, storage ni `returnTo`.
- **Corrección relacionada:** una cuenta sin solicitud («none») con un código pendiente ya **no** lo
  descarta: se avisa de que puede ser el enlace de otra cuenta y se ofrece «Cambiar de cuenta» conservándolo.

## 10. Riesgos y límites conocidos

- La elegibilidad se evalúa bajo el lock de roles, que serializa cambios de rol; un TOTP que un par enrole
  en el mismo milisegundo no está bajo ese lock. Efecto: como mucho una aprobación excepcional tardía,
  siempre con aviso al titular, enlace de cancelación y espera de 15 min.
- Un Admin que reenvía el aviso de una aprobación excepcional desde su panel enviaría el texto normal (sin la
  frase de Developer); el enlace y el token son los mismos. Solo lo puede hacer un admin inelegible.
- Un Developer comprometido podría aprobar al único admin: mitigado por TOTP ≤ 5 min, aviso entregado,
  enlace de cancelación sin sesión, espera de 15 min y auditoría diferenciada.
- La cuenta Developer no tiene recuperación excepcional propia (la aprueba un Admin).
- Si el último Developer pierde el rol, el único admin vuelve a no tener camino automático (`no_approver`).
- Un Developer recién transferido espera antes de aprobar (por defecto 24 h sin configurar; 60 min en DEV por
  configuración explícita). La espera no limita rechazar ni revertir.
- Si no queda ningún Admin elegible, solo la revocación de emergencia del operador devuelve a un Developer a Moderador.
- Durante la ventana entre la invitación como Admin y la autotransferencia la cuenta tiene las capacidades de Admin.

## 11. Pruebas

Transición y espera (esta ronda): PGlite `developer-transition-migration.test.ts` (31: autotransferencia con todos sus
requisitos, recuperaciones activas propias y ajenas, último admin, lock antes de `FOR UPDATE`, restauración, Developer
sin rutas para cambiar su rol, espera antes/exacta/después de 60 min, no reinicio, restauración + nueva transferencia,
cambio de la configuración, permisos, rollback), handlers `developer-transition-handlers.test.ts` y la espera en
`developer-panel-handlers.test.ts`, y los componentes `BecomeDeveloperSection`, `DeveloperRestoreControls` (vía
`TeamMembersSection`) y el aviso de espera de `DeveloperRecoveriesSection`.

- PGlite (`developer-panel-migration.test.ts`, 36): independencia de roles, protección de Developer en
  cambio/retirada/invitación/bootstrap, permisos `EXECUTE`, operador (requisitos, auditoría, append-only),
  elegibilidad (TOTP, bloqueado, eliminado, solicitud propia), aprobación/rechazo (autoaprobación, solicitante no
  admin, caducada/cancelada/cambiada, idempotencia, lock antes de `FOR UPDATE`), compatibilidad con
  solicitudes existentes, reutilización de la fase 2 (aviso entregado, espera, instantánea), listas sin datos
  sensibles, `hasApprover`, rollback, plantilla del operador.
- Handlers (`developer-panel-handlers.test.ts`, 31), autenticación (`admin-auth.test.ts`: matriz y ventana
  de TOTP), equipo (`admin-team-members.test.ts`, `TeamMembersSection.test.tsx`), correo
  (`mfa-recovery-mail.test.ts`), `totp-reverify.test.ts`, componentes y página de Developer, y las dos
  mejoras de la recuperación (`AdminMfaRecoveryPage.test.tsx`).

## 12. Integración y validación posterior en DEV (requiere autorización específica, lote a lote)

Estado: Lotes 1 y 2 de Developer Panel V1 ya hechos (migración `20261101120000` y Preview). Lo de esta ronda
(transición + espera) está **solo en local**.

1. **Migración `20261102120000` en DEV:** comprobar antes (solo lectura) que no hay recuperaciones activas, que
   `admin_developer_audit` y `admin_roles` no tienen Developers y que las funciones reemplazadas coinciden con las
   locales; aplicar; verificar columnas, funciones, permisos (`operator_set_developer_cooldown`,
   `operator_revoke_developer` sin `EXECUTE` para API; `operator_grant_developer` ya no existe) y que nada cambió.
2. **Configurar la espera de DEV (operador, explícito):** `operator_set_developer_cooldown(60, 'DEV 60 min')`.
3. **Preview + alias** (`upmina-web-testing`) desde `upmina-web-r5f`; rollback = deployment anterior + `rollback.sql`.
4. **Cuenta de prueba `edwin390`, sin el script operador:** `edwin1` (único admin, TOTP verificado) crea una invitación
   **de Admin**; `edwin390` la consume y enrola su TOTP; `edwin390` usa «Convertirme en Developer» con TOTP reciente
   (queda `edwin1` como Admin elegible). No se tocan `eds` ni `edwin1`.
5. **Validación:** acceso a `/admin/developer`, Admin sin acceso, 403 del antiguo panel, mensaje de espera restante,
   restauración por `edwin1` (a Moderador) y nueva transferencia con espera reiniciada, auditoría. La aprobación
   excepcional de punta a punta solo con autorización expresa.
6. Retirada de la visibilidad de Admin de las limpiezas: **no** en esta ronda.
