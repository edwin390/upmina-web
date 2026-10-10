# AUTH-2 · Cuenta completa para acciones de Community

**Regla canónica.** CUENTA COMPLETA = email verificado (`auth.users.email_confirmed_at`) + username (fila en
`profiles`). Solo una cuenta completa puede escribir en Community (crear/editar publicaciones, reordenar o quitar
medios, dar like, reportar) y reservar subidas. Borrar la propia publicación sigue permitido.

## Tres dominios distintos (no equivalentes)
| Dominio | Código HTTP | Origen | Qué bloquea |
|---|---|---|---|
| Cuenta incompleta (AUTH-2) | 403 `account_incomplete` + `reason` (`email_unverified` / `username_missing`) | `community_account_state` | publicar, editar, like, reportar, reservar subida, crear/cambiar username |
| Restricción de autor (strikes, R5) | 403 `author_restricted` | `community_author_restriction` | crear/editar/reordenar/quitar medios (escritores de publicación); NO likes ni reportes |
| Acciones de moderación sobre posts | — | casos/ciclos | ocultar/retirar contenido |
No existe un concepto de «suspensión de cuenta». Precedencia: si ambas condiciones se dan, gana `account_incomplete`
(el estado de cuenta se evalúa primero, en el guard de la BD y en el precheck de reserva).

## Autoridad
- **Base de datos** (`20261025120000_account_complete_authority.sql`, aplicada en DEV): `community_account_state`,
  `community_assert_account_complete`, guard `community_assert_author_may_write` (cuenta y luego restricción) usado por
  `post_save`, `post_save_atomic`, `post_reorder_media` y `post_detach_media`; wrappers de `set_like` y
  `report_submit` sobre núcleos `*_core` inaccesibles para los roles de API; triggers de `profiles` que exigen email
  verificado para crear/cambiar el username. Una llamada directa a la API/RPC no evade nada: solo `service_role`
  ejecuta los wrappers y no puede escribir likes/reportes directamente.
- **Servidor** (`account-state.ts`): lee el estado de la misma función de BD y traduce los errores `account_*` a
  403 `account_incomplete`; lectura fallida = fallo cerrado.
- **Reserva de subida** (`handleMediaReserve`): *precheck NO autoritativo* de cuenta completa y de restricción, para no
  crear reservas inútiles. No sustituye a la BD: si se omite o falla, la publicación sigue rechazada por los escritores.
  `complete` y `abort` solo exigen autenticación + propiedad de la fila (finalizar o liberar una reserva previa es
  mantenimiento técnico y no autoriza a publicar).
- **Frontend**: `AccountIncompleteNotice`, `VerifyEmailFirstMessage` y los textos `auth` (es/en/de) solo interpretan la
  respuesta del servidor; los botones deshabilitados no son una frontera de seguridad.

## Fuera de alcance (commits aparte)
Flujo de verificación de email AUTH-1 (Login/Signup, `auth-context`, `EmailVerificationPending`), Easter eggs 9N y
rediseño de UI.

## Pendiente
Desplegar el backend a DEV (la BD ya aplica la regla; el backend desplegado aún no la mapea) y validar con sesión real,
sin reservar medios hasta terminar la prueba remota de R7.
