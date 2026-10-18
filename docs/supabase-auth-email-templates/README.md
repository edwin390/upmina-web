# Plantillas de correo de Supabase Auth (identidad Upminaa Web)

Estado: **preparadas en el repositorio, NO aplicadas** en ningún proyecto de Supabase. Son HTML autónomo (tablas + CSS en línea,
sin JavaScript, sin imágenes ni fuentes remotas) con la misma presentación que `src/lib/mail-html.ts`: fondo `#0b0d13`, tarjeta
`#171f30`, borde `#28344c`, acento azul `#74b8f4` (hover/foco del botón: `#a8d4fa`), rosa `#ff4da6` solo en la cabecera, cabecera de texto `UPMINAA WEB`, pie «Automatic message…» y
la declaración de independencia respecto a Mina. Idioma: inglés. Fuente de verdad visual: `docs/DESIGN_SYSTEM.md`.

> El contenido de las plantillas actuales del Dashboard **no está en el repositorio**. Los textos de `confirm-signup.html` se han
> escrito a partir de los elementos descritos (título, bienvenida, botón, aviso de cuenta no creada, enlace alternativo, aviso
> automático, independencia); **compara con la plantilla vigente antes de pegar** y conserva cualquier frase que deba mantenerse.

## Correspondencia con el Dashboard

Dashboard → Authentication → Emails → Templates (el nombre exacto puede variar según la versión del panel).

| Archivo                 | Opción del Dashboard | Variables Supabase                                          | Estado                                                                                                                                                          |
| ----------------------- | -------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirm-signup.html`   | Confirm sign up      | `{{ .ConfirmationURL }}` (botón y enlace alternativo)       | **Lista para probar en DEV.** La app usa `signUp` con confirmación (`SignupPage`, `EmailVerificationPending`).                                                  |
| `reset-password.html`   | Reset password       | `{{ .ConfirmationURL }}`                                    | **Lista para probar en DEV.** La app usa `resetPasswordForEmail` con retorno a `/reset-password`.                                                               |
| `change-email.html`     | Change email address | `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}` | **PENDIENTE DE CONFIRMACIÓN:** la app no llama a un cambio de correo; confirmar si el Dashboard lo habilita.                                                    |
| `invite-user.html`      | Invite user          | `{{ .ConfirmationURL }}`                                    | **PENDIENTE DE CONFIRMACIÓN:** las invitaciones del equipo son propias de la app (no usan `inviteUserByEmail`); solo aplicar si se usa esa función de Supabase. |
| `magic-link.html`       | Magic link           | `{{ .ConfirmationURL }}`                                    | **PENDIENTE DE CONFIRMACIÓN:** la app no usa magic links.                                                                                                       |
| `reauthentication.html` | Reauthentication     | `{{ .Token }}` (código, **sin enlace**)                     | **PENDIENTE DE CONFIRMACIÓN:** depende de si el Dashboard exige reautenticación al cambiar la contraseña (`updateUser`).                                        |

Variables oficiales usadas: `{{ .ConfirmationURL }}` (enlace individual de acción), `{{ .Token }}` (código OTP de 6 dígitos),
`{{ .Email }}` y `{{ .NewEmail }}` (datos del destinatario). No se usan `{{ .SiteURL }}`, `{{ .RedirectTo }}` ni `{{ .TokenHash }}`;
no hay ninguna URL de autenticación fija. Un código OTP nunca se presenta como enlace ni al revés. Las variables van **sin
escapar ni traducir**: Supabase las sustituye al enviar.

El asunto de cada correo se configura aparte en el mismo panel (no está en estos archivos). Si lo cambias, mantén el prefijo
«Upminaa Web:» de los demás correos.

Supabase también ofrece plantillas de **notificaciones de seguridad** (cambio de contraseña, de correo, de teléfono, factor MFA
añadido o eliminado, identidad vinculada). **No se han preparado** porque no se ha comprobado cuáles están activas.

## Cómo aplicarlas (primero en DEV, proyecto `rkqeqbqwdswhpzwqptac`)

1. **Guardar la plantilla vigente**: copia el HTML actual de cada plantilla a un archivo local fuera del repositorio
   (p. ej. `confirm-signup.antes.html`) y anota el asunto. Es la vía de reversión.
2. Pega el contenido del archivo correspondiente en el editor de la plantilla y guarda. Verifica el tamaño de la vista previa.
3. No cambies Site URL ni Redirect URLs al mismo tiempo; revísalas aparte (ver abajo).

## Qué comprobar en DEV

- **Botón y enlace alternativo** (confirmación y recuperación): registra una cuenta de prueba de DEV con un correo propio y pide una
  recuperación; el botón y la dirección visible deben abrir el **mismo** enlace individual y terminar en `/login` o
  `/reset-password` del origen de DEV.
- **Código** (reautenticación): el código aparece en el recuadro, con 6 dígitos, y no hay botón.
- **Clientes**: Gmail web y móvil, Outlook (escritorio y web), Apple Mail. Hover (azul claro `#a8d4fa`, el segundo azul del botón de la web) y foco visible solo funcionan donde el cliente
  admite `<style>` en la cabecera; sin ello, el botón azul sigue siendo clicable y legible. Comprobar también con modo oscuro forzado.
- **Móvil**: el ancho se adapta (máx. 560 px) y los márgenes se reducen por debajo de 480 px.
- **Site URL y Redirect URLs** (Authentication → URL Configuration): `Site URL` = origen de DEV; la lista debe incluir `/login` y
  `/reset-password` de ese origen. Si `/reset-password` no está permitido, Supabase usa la Site URL (comportamiento seguro, pero el
  enlace no llevaría a la pantalla de restablecimiento). Production: `https://upminaa-web.com` con las mismas rutas.

## Qué no hacer sin autorización

- No pegar estas plantillas en **Production** (`dmtuvzfdaectvqczwfhx`) sin haberlas validado en DEV y sin una autorización expresa.
- No modificar Site URL, Redirect URLs, proveedor SMTP ni límites de envío al aplicar las plantillas.
- No enviar correos de prueba a direcciones de terceros ni usar cuentas reales de Production.
- No sustituir `{{ .ConfirmationURL }}` por una URL fija ni añadir tokens reales a estos archivos.

## Limitaciones de compatibilidad

Outlook de escritorio ignora `border-radius` y la cabecera `<style>` solo se aplica parcialmente; los botones se ven cuadrados.
Algunos clientes recolorean los fondos en modo oscuro. Las vistas previas visuales no se han hecho en clientes reales todavía.
