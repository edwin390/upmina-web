# 9K · MFA fase 1 — reinicio del MFA al retirar privilegios y reenrolamiento obligatorio

**Estado:** implementado y validado en LOCAL (2026-10-11); desplegado y validado en DEV con `eds` (§10). NO aplicado en Production, sin commit.
La fase 2 (recuperación de un autenticador perdido) NO está implementada; ver §9.

## 1. Política
- El TOTP de esta aplicación se usa solo para operaciones administrativas (admin, developer, moderator). Único
  enrolamiento real: `useMfaVerification.enroll` desde `/admin/mfa` (`CosplayInlineMfa` solo verifica/usa el mismo
  hook). Los factores viven en Supabase Auth por cuenta, pero su propósito funcional aquí es administrativo.
- Al retirar el **último** rol privilegiado se invalidan TODOS los factores TOTP de la cuenta. Cambiar entre
  admin/developer/moderator NO reinicia nada (`change_admin_member_role` no pasa por este flujo).
- Si la persona vuelve a ser invitada, debe enrolar y verificar un autenticador NUEVO antes de activar.

## 2. Retirada del último rol (flujo)
1. `POST /api/admin/team-members-remove` (ADMIN + MFA reciente) llama a la RPC
   `admin_remove_member_with_mfa_reset`, que en UNA transacción: ejecuta `remove_admin_member` (sin modificarla; todas
   sus validaciones, la revocación de invitaciones y la auditoría `access_removed` siguen igual), toma la **instantánea
   de los ids de los factores TOTP** existentes en ese instante y crea la fila `admin_mfa_resets` (`pending`; o
   `completed` si no había factores).
2. El acceso se pierde en ese instante: cada petición privilegiada consulta `admin_roles` (el MFA no es lo que revoca).
3. Después de confirmar la transacción, el backend borra con la API de administración de Supabase Auth
   (`auth.admin.mfa.deleteFactor`) **exactamente los ids de la instantánea**, confirma con `listFactors` que ninguno
   sigue presente y registra el resultado (`admin_mfa_reset_record`). Éxito → `completed` + auditoría
   `mfa_reset_completed` (actor = el ADMIN que retiró el acceso).
4. `remove_admin_member` ya no es ejecutable directamente por `service_role`: ninguna retirada puede omitir la marca.

Respuesta: 200 con `mfa_reset: {status: "not_needed" | "completed" | "pending", ...}`. Un fallo del MFA NUNCA convierte
la retirada en error.

## 3. Fallos parciales, reintentos y carreras
| Situación | Resultado |
|---|---|
| Rol retirado y todos los factores borrados | `completed`, auditoría `mfa_reset_completed`. |
| Rol retirado y Supabase Auth falla | El usuario sigue SIN privilegios; la fila queda `pending` con `attempts` y la clase del error (sin mensajes ni secretos). El panel muestra un aviso explícito y la sección «Autenticadores pendientes de restablecer» con **Reintentar limpieza**. |
| Solicitud repetida | El miembro ya no existe → 404 `member_not_found`: no hay filas nuevas, no se borra nada. |
| El factor ya no existe (404 de Auth) | Se cuenta como resuelto; si no queda ningún id de la instantánea, `completed`. |
| Reintento tardío tras configurar un TOTP nuevo | La limpieza solo conoce los ids de la instantánea: el factor nuevo (otro id) nunca se borra ni bloquea. |
| Dos limpiezas simultáneas | Borrar un id ya borrado es un no-op y `admin_mfa_reset_record` es idempotente (no duplica la auditoría). |
| Falla el registro del resultado | `pending` con `record_failed`; el reintento es inocuo. |
Garantía de orden: el borrado de factores NUNCA precede a la retirada del rol; no existe un estado «con privilegios y sin MFA».

## 4. Reinvitación y reenrolamiento
`POST /api/admin/activate` ejecuta ahora `admin_mfa_activation_check(user, session_id)` ANTES de consumir la invitación
(falla cerrado ante cualquier error o forma inesperada):
- Sin antecedentes de retirada (primera invitación, invitaciones normales) → pasa; comportamiento sin cambios.
- Limpieza pendiente → el backend la reintenta ahí mismo (solo los ids de SU instantánea); si no se resuelve → 503
  `mfa_cleanup_pending` y la invitación NO se consume.
- Con antecedentes → la **sesión** debe acreditar un factor nuevo, comprobado en la BASE DE DATOS (no en el cliente):
  `auth.sessions` en `aal2` cuyo `factor_id` es un TOTP `verified` del usuario, que NO está en ninguna instantánea y es
  posterior a la última retirada. Si no → 403 `mfa_reenroll_required`.
- Sin bloqueo circular: `/admin/mfa` no exige rol. La persona enrola y verifica el factor nuevo (la sesión pasa a
  aal2 con ese factor) y vuelve a activar. La UI renueva el token y revalida el acceso tras el 403.
- `aal2` por sí solo NO prueba el factor: una sesión aal2 obtenida con el factor antiguo se rechaza aunque el JWT
  siga diciendo aal2 y esté dentro de la ventana de recencia. `friendlyName` y los claims del cliente no se usan.

## 5. Sesiones
- Privilegios: revocados por `admin_roles` en cada petición; no dependen de cerrar sesiones.
- GoTrue degrada a aal1 las sesiones asociadas a un factor eliminado (comportamiento del servicio, **a verificar en DEV**);
  el JWT ya emitido puede seguir diciendo aal2 hasta renovarse. Por eso la activación no confía en el JWT sino en
  `auth.sessions`. No se cierran sesiones a la fuerza ni se muestra ningún mensaje que lo afirme.

## 6. Esquema (migración `20261031140000_admin_mfa_reset.sql`; rollback en `supabase/rollbacks/`)
- `admin_mfa_resets` (RLS forzada, sin acceso para ningún rol de API; append-only con trigger; una sola `pending` por
  usuario): usuario, rol anterior, quién retiró, instantánea `factor_ids`, estado, intentos, clase del último error.
- `admin_team_audit`: acción nueva `mfa_reset_completed` (aditivo; `actor <> target` se conserva).
- Funciones (solo `service_role`): `admin_remove_member_with_mfa_reset`, `admin_mfa_pending_reset`,
  `admin_mfa_reset_record`, `admin_mfa_cleanups_pending`, `admin_mfa_activation_check`.
- No se modifican `remove_admin_member`, `consume_admin_invitation` ni `change_admin_member_role`. Número elegido
  (`20261031…`) para poder aplicarse desde un worktree aislado sin las migraciones pendientes de identidad y REP-1.

## 7. Backend / frontend
- `api/admin/[action].ts`: acciones `team-members-mfa-cleanups` (GET, lista) y `team-members-mfa-cleanup` (POST, reintento),
  mismo dispatcher (sin funciones serverless nuevas), ADMIN + MFA reciente; el reintento solo recibe `user_id` y usa los ids
  guardados en BD.
- `admin-auth.ts`: `AuthenticatedIdentity.sessionId` (claim `session_id` del JWT verificado).
- UI: `TeamMembersSection` (resultado del MFA en el aviso), `MfaCleanupsSection` (pendientes + reintento),
  `AdminActivatePage` (403/503 nuevos). Placeholder «Próximamente: usuarios» eliminado; la clave manual TOTP se
  conserva con una nota: no es un código de recuperación.

## 8. Pruebas locales (sin Supabase remoto)
SQL real en PGlite (`admin-mfa-reset-migration.test.ts`), runner con Auth simulado (`admin-mfa-reset.test.ts`), handlers
(`admin-team-members.test.ts`, `admin-handlers.test.ts`) y UI. Los dobles de Supabase Auth NO prueban el servicio real.
**Necesita prueba real en DEV:** borrado de factores con la API de administración, degradación de sesiones, que
`auth.sessions.factor_id` se actualice al verificar el factor nuevo, y el recorrido completo con `eds` (plan abajo).

Plan DEV (NO ejecutado; cada escritura requiere autorización): (1) estado inicial de `eds` (rol, factor); (2) `edwin1`
retira su acceso; (3) SELECT: sin rol, instantánea, factor borrado, `admin_mfa_resets` y auditoría; (4) reinvitar como
moderator; (5) intentar activar con la sesión antigua → 403 `mfa_reenroll_required`; (6) enrolar autenticador nuevo y
verificarlo; (7) activar → 200; (8) verificar roles, permisos y auditoría; (9) retirar de nuevo el acceso al terminar.

## 9. Pendiente — FASE 2 (no implementada)
Recuperación de un autenticador perdido: solicitud, verificación real y reciente del correo, comprobaciones adicionales,
aprobación de otro administrador con MFA reciente (sin autoaprobación), invalidación del factor perdido, nuevo
enrolamiento, auditoría, notificación de seguridad, límites de abuso/caducidad y procedimiento excepcional para el único
administrador. La verificación del correo por sí sola NO podrá restablecer el MFA privilegiado; no se reutiliza AUTH-3.

## 10. Validación real en DEV (2026-10-11)
Despliegue: migración `20261031140000` aplicada en DEV (Supabase `rkqeqbqwdswhpzwqptac`) y Preview
`dpl_6fuyMXTCBfdVNj9DyPsRPdLcjoYY` detrás de `upmina-testing-backend.vercel.app` (anterior: `dpl_DooePqs24j7NHNQ6F7wpUeofb3B7`).
Recorrido con `eds` (retirada y reinvitación hechas por el usuario desde la interfaz; yo solo hice SELECT).
Leyenda: **[SELECT]** confirmado por consulta a la base; **[VISUAL]** observado por el usuario, no verificable por consulta.

**Retirada (20:52:22 UTC)**
- [SELECT] `eds` sin fila en `admin_roles`; `admin_mfa_resets`: 1 fila `completed`, `role_removed`, rol anterior `moderator`, 1 intento,
  sin error, solicitada por `edwin1`, completada 0,27 s después, instantánea con 1 factor (`c9906eb7-…`), `factors_deleted = 1`.
- [SELECT] El factor `c9906eb7-…` ya no existe en `auth.mfa_factors`. Auditoría `access_removed` y `mfa_reset_completed` (actor `edwin1`).
- [SELECT] Tras la retirada, la sesión de `eds` figuraba en `aal1` con `factor_id` nulo (consistente con que GoTrue degrada la sesión
  del factor borrado; no hay captura previa para compararla).
- [VISUAL] La interfaz mostró éxito. 0 limpiezas pendientes.

**Reinvitación y nuevo autenticador**
- [VISUAL] Se pidió configurar MFA, se mostró el enrolamiento (QR / clave manual) y se llegó a «Activar acceso».
- [SELECT] Invitación nueva (moderator) creada 20:56:24, consumida 20:57:50 por `eds`. Rol `moderator` recuperado desde 20:57:50.
- [SELECT] Factor nuevo `3e217c4f-…`: TOTP `verified`, creado 20:56:46, posterior a la retirada. El antiguo sigue eliminado.
- [SELECT] La misma sesión (creada 20:51:56, anterior a la retirada) figura ahora `aal2` con `factor_id = 3e217c4f-…`, que es un TOTP
  verificado de `eds`: confirma que `auth.sessions.factor_id` se actualiza al verificar el factor nuevo.
- [SELECT] `admin_mfa_activation_check` para esa sesión → `{allowed: true, reason: new_factor_verified}`.
- Auditoría: `admin_team_audit` solo registra cambios de rol, retiradas y `mfa_reset_completed`; el ciclo de la invitación
  (creación/consumo) consta en `admin_invitations`, no en `admin_team_audit`.
- [SELECT] 0 limpiezas pendientes; `edwin1` admin y `9k_e5_72h_mod` moderator con sus factores originales intactos.
  Invitaciones: 6 (5 consumidas, 1 revocada; la nueva es la única añadida).

**No probado en esta ejecución:** el 403 `mfa_reenroll_required` con el factor antiguo (el factor ya estaba borrado, por lo que
la sesión no podía acreditarlo; queda cubierto por los tests de PGlite), el fallo de Auth con limpieza `pending`, y la retirada
final de `eds` (pendiente de autorización).
