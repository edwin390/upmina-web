# AUTH-1 · Registro, inicio de sesión y verificación de correo

Supabase Auth (con *Confirm email* activado) es la única autoridad de verificación; no hay bandera propia ni sesión
inventada. AUTH-2 exige además esa verificación para escribir en Community (la BD lee `auth.users.email_confirmed_at`).

## Flujo
- **/signup**: `signUp` solo con email + contraseña (sin `data`/roles) y `options.emailRedirectTo = <origen>/login`.
  Con `session: null` muestra «Revisa tu bandeja» (`EmailVerificationPending`, cooldown 60 s para reenviar). Un
  email ya registrado no se distingue (sin enumeración de cuentas).
- **/login**: credenciales correctas + email sin confirmar (`email_not_confirmed`) → mismo estado pendiente, con la
  contraseña descartada. Credenciales incorrectas → mensaje genérico (no activa el estado pendiente).
- **Reenvío**: `auth.resend({type:"signup"})` con single-flight, cooldown, mensajes seguros para 429 y errores, y
  `emailRedirectTo` igual que en el alta.
- **Sincronización**: `supabase-js` difunde la sesión entre pestañas; como respaldo acotado `EmailVerificationPending`
  llama a `refreshSession()` al recuperar foco/visibilidad (sin polling; listeners retirados al desmontar).
- **Retorno del enlace** (`src/lib/auth-link-error.ts`): el correo vuelve a `/login`.
  - Éxito (`#access_token=…&type=signup`): supabase-js crea la sesión y, sin `returnTo`, se continúa en `/account`
    (alta de username que exige AUTH-2); con `returnTo` seguro se respeta el destino.
  - Fallo (`#error=…&error_code=otp_expired|…`): aviso controlado `auth.linkError` (ES/EN/DE) sin texto del
    proveedor; el fragmento se retira de la URL (sin bucles) y se puede iniciar sesión para pedir otro correo.

## Notas
- Si `<origen>/login` no está en la lista de *Redirect URLs* de Supabase, éste usa su Site URL: el aviso de enlace
  caducado solo aparecerá si ese retorno cae en `/login`. Es configuración remota (no modificada aquí).
- Cuentas heredadas con sesión y email sin verificar: AUTH-2 las bloquea con `account_incomplete/email_unverified`;
  el aviso indica confirmar el correo, y el reenvío requiere el flujo de /login (sin funcionalidad nueva aquí).
