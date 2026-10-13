# 9K — Recordatorio del aviso de aprobación MFA y recuperación de contraseña

Estado: **solo implementación local**. Nada de esto está aplicado ni desplegado en ningún entorno. Migración candidata:
`supabase/migrations/20261104120000_mfa_recovery_reminder.sql` (rollback en `supabase/rollbacks/`).

## 1. Recordatorio del aviso de aprobación («Reenviar aviso» con el aviso ya entregado)

El correo de aprobación original y su enlace de cancelación **no cambian**. Solo se guarda el hash del enlace, así que
no se puede reenviar el mismo enlace; rotarlo invalidaría el que ya llegó y, tras la entrega, reiniciaría la espera de
15 minutos (la espera es `greatest(approved_at, delivered_at del último aviso de tipo 'approved') + 15 min`).

Solución: un tipo de correo **independiente**, `reminder`.

- Base de datos: `admin_mfa_recovery_reminder_start(recovery, actor)` (solo `service_role`, `SECURITY DEFINER`,
  `search_path` fijo, lock de roles PRIMERO) decide y reserva el envío bajo el bloqueo de la fila de la solicitud:
  - el actor (del JWT verificado en el backend) debe ser Admin o Developer vigente y no el titular de la solicitud;
  - solo con la solicitud en `approved` y vigente cuyo aviso de aprobación YA está entregado (`readiness` = `waiting` o
    `ready`); nunca tras cancelación, ejecución, cierre o finalización, ni con cambio de correo o de rol;
  - máximo **3** recordatorios (los fallidos no cuentan para el máximo) y al menos **60 s** entre dos (cuentan todos los intentos);
  - inserta la fila de correo con clave `recovery:<id>:reminder:<n>`.
- **Auditoría del solicitante:** cada reserva registra en `admin_mfa_recovery_events` (la auditoría existente, sin tocar su
  restricción) un evento `mail_state` con `actor_user_id` = quien lo pidió y detalle `reminder:requested`. El envío y la
  entrega del proveedor siguen registrándose como `reminder:accepted|delivered|failed` (el webhook firmado).
- Backend (`remindApprovedNotice`, compartido por Admin y Developer): reutiliza `sendRecoveryMail` (adaptador de Resend,
  idempotencia, registro y verificación de entrega). Códigos: `too_soon` y `reminder_limit` → 429,
  `notice_not_delivered` y `not_pending` → 409, sin correo configurado → 503 **sin reservar** nada.
- No rota el enlace, no cambia el estado de la solicitud y no reinicia la espera: `ready_at`/`readiness` y las listas solo
  miran `kind = 'approved'`.
- El recordatorio (en inglés, ASCII) explica cómo cancelar desde la cuenta (página `/admin/mfa/recovery` → Cancelar) o con
  el enlace del correo original, y **no contiene ningún enlace de cancelación** ni datos de la cuenta.
- Interfaz: «Reenviar aviso» aparece en toda solicitud aprobada (en la de Developer, solo la excepcional). Con el aviso
  entregado envía un recordatorio y lo dice («Recordatorio enviado…»); sin entrega mantiene el reenvío normal.

### Carrera entre cancelación y envío — qué se garantiza y qué no

- **Se garantiza:** la comprobación del estado y la reserva ocurren en UNA transacción con la fila de la solicitud
  bloqueada. Una vez confirmada una cancelación, **no se puede reservar ningún recordatorio nuevo** (la solicitud deja de
  estar `approved`). Dos recordatorios simultáneos se serializan (el segundo ve `too_soon`). El estado de la solicitud
  es siempre el de la base de datos; ningún correo lo cambia.
- **No se garantiza:** un recordatorio ya reservado cuyo envío estaba en curso cuando se confirmó la cancelación (ventana
  de milisegundos entre la reserva y la llamada al proveedor) puede llegar a salir, y **un correo ya entregado al
  proveedor no se puede retirar**. Ese recordatorio es inocuo: no contiene ningún enlace, y el titular recibe además el
  aviso de cierre de la cancelación. La solicitud cancelada no puede ejecutarse.

## 2. «Olvidé mi contraseña»

- `/login` enlaza a `/forgot-password` (texto con el sistema de traducciones, ES/EN/DE, namespace `auth`).
- `/forgot-password`: `supabase.auth.resetPasswordForEmail(email, { redirectTo: <origen>/reset-password })`. Sin proveedor
  nuevo ni tokens propios. **Sin enumeración:** misma respuesta para éxito, error del proveedor y excepción (incluida la
  espera por usuario de Supabase, que solo ocurre con cuentas reales); el texto no repite el correo; botón bloqueado 60 s.
- `/reset-password`: solo muestra el formulario si la sesión actual **es** la sesión de recuperación marcada.

### La marca de recuperación (`password-recovery.ts`)

- **Nace del evento real `PASSWORD_RECOVERY`** de supabase-js (enlace validado y consumido por Supabase), no de leer la URL.
  `supabase.ts` se suscribe al crear el cliente, antes de que se emita. No hace falta leer el fragmento (que supabase-js borra).
- **Está atada a esa sesión:** guarda `userId` y el `session_id` de la sesión de recuperación (leído del token solo para
  comparar). Una sesión ordinaria posterior, de otra cuenta, o la misma cuenta con otro inicio de sesión, tiene otro
  `session_id` y **no coincide**, aunque la marca siga ahí.
- **Caduca a los 15 minutos** y se limpia: al cerrar sesión (`SIGNED_OUT`), al cancelar, al completar, ante un enlace
  inválido, ante un `SIGNED_IN` de otra sesión/cuenta y cuando se detecta que ya no coincide.
- **Recarga legítima:** vive en el `sessionStorage` de la pestaña (misma sesión → sigue vigente hasta caducar). Otra
  pestaña no la hereda. Contenido: `userId`, `sessionId`, `expiresAt`; nunca tokens, firmas, contraseñas ni fragmentos.
- **No es autorización:** solo decide si se MUESTRA el formulario. Quien llame a la API directamente no pasa por ella;
  Supabase decide en `updateUser` (ver §3 y §5).

### Pasos de `/reset-password`

Cuenta con verificación en dos pasos (`nextLevel` aal2 > `currentLevel`): primero el código TOTP (`mfa.challenge` +
`mfa.verify`). Quien perdió el autenticador **no** puede restablecer desde aquí (existe la recuperación de MFA con
aprobación). Después, `updateUser({ password })` y, **al completar**, `signOut({ scope: 'global' })` (cierra todas las
sesiones, también la de recuperación) y vuelta a `/login` con un aviso. **«Cancelar» cierra solo la sesión local**
(`signOut({ scope: 'local' })`): no cierra las demás sesiones de la persona. La contraseña no se conserva. La página no
llama a ninguna API propia ni navega a `/admin`.

## 3. Garantías confirmadas y pendientes (Supabase Auth)

**Confirmado (documentación de Supabase y auth-js 2.116):**

- Los accesos por enlace de recuperación son `aal1` (amr `recovery`); las rutas privilegiadas de Upminaa exigen `aal2` y un
  TOTP reciente verificados por el servidor propio: un restablecimiento no concede acceso privilegiado por sí solo.
- La recuperación de MFA exige un inicio de sesión **reciente con contraseña** (`amr` `password`); un acceso por enlace de
  recuperación u OTP no cuenta.
- «Require reauthentication when changing password»: con el ajuste activo, cambiar la contraseña exige estar recientemente
  conectado (sesión de menos de 24 h) o un `nonce` por correo (`reauthenticate()`). Una sesión de recuperación es recién creada.
- «Require current password when changing password»: con el ajuste activo, `updateUser` exige `current_password`.
  **Si estuviera activo, este flujo de restablecimiento no funcionaría** (la pantalla no tiene la contraseña actual): debe
  estar desactivado en el proyecto que use esta función, o no usarla.
- La protección contra contraseñas filtradas y los requisitos de longitud/caracteres son ajustes de Auth (el asesor de
  seguridad de DEV avisa de que la protección contra filtradas está desactivada).
- `signOut()` sin opciones usa `scope: 'global'` (por eso «Cancelar» pasa `scope: 'local'` explícitamente).

**Pendiente de prueba real (DEV):** si `updateUser({ password })` exige `aal2` con una sesión de recuperación `aal1` de una
cuenta con MFA verificado. Ni la documentación consultada ni auth-js lo establecen. No se asume en ningún sentido: el paso TOTP
del cliente no es una garantía del servidor. Plan en §5.

## 4. Correos en inglés

Todos los correos que envía la aplicación por Resend (desafío, aprobación, recordatorio, cierre, finalización) están en inglés
y solo ASCII (cubierto por test). Los correos de **Supabase Auth** (confirmación de registro y recuperación de contraseña)
usan las plantillas del panel de Supabase, **no este repositorio**: hay que comprobar que estén en inglés (la plantilla por
defecto lo está) y, si se editan, hacerlo en el panel con autorización.

## 5. Prueba controlada en DEV (diseñada, NO ejecutada)

Objetivo: determinar si Supabase permite `updateUser({ password })` desde una sesión de recuperación `aal1` **sin completar el
TOTP** en una cuenta ordinaria con MFA verificado, y qué efecto tienen «Secure password change» y «Require current password».

**Herramienta:** `scripts/dev-password-reset-aal-check.mjs` (lógica en `scripts/lib/`, con tests; nada la ejecuta salvo una
persona a mano). Solo imprime códigos HTTP, códigos de error de Auth y conclusiones; nunca tokens, enlaces, códigos TOTP,
contraseñas, correos ni ids. La contraseña de prueba es aleatoria y desechable (no se imprime ni se guarda) y la herramienta
no escribe nada en disco.

**Controles (todos ANTES de cualquier cambio; cualquier fallo aborta):**

1. Modo `no-totp` o `with-totp`, y `UPMINA_DEV_CHECK_CONFIRM=DEV_ONLY` exacto.
2. Supabase = exactamente el proyecto DEV (`rkqeqbqwdswhpzwqptac.supabase.co`, https) y aplicación = exactamente el alias DEV
   (`https://upmina-testing-backend.vercel.app`). Production u otro host: aborta sin pedir el enlace ni usar la red.
3. El enlace pegado debe traer `#access_token=…&type=recovery` y la sesión debe ser `aal1`.
4. **Rol: lo confirma el SERVIDOR.** `GET /api/admin/access` (verifica el JWT criptográficamente y consulta `admin_roles`) debe
   responder **200 con `role` exactamente `null`, `capabilities` vacío y `mfa.recent === false`**. 401, 403, 404, 5xx, error de
   red, cuerpo ausente o malformado, `role` ausente o un rol (admin, moderator, developer) son **abortar**. Lo que diga el
   cliente (claims del token) nunca prueba que la cuenta carezca de privilegios.
5. La cuenta debe tener al menos un TOTP **verificado** (se leen los factores con el mismo token; si no se pueden leer, aborta).

Solo entonces se hace el único cambio (`PUT /auth/v1/user` con la contraseña aleatoria; en `with-totp`, antes, el
challenge/verify del TOTP). Los errores de red nunca muestran detalles (podrían contener URLs o cabeceras).

**Requisitos previos (los hace la persona operadora; requieren autorización expresa):**

1. Una cuenta **de prueba ordinaria** (sin fila en `admin_roles`): se crea desde `/signup` con un correo propio y se confirma.
2. Un TOTP verificado en esa cuenta (la inscripción la hace la propia persona con su app autenticadora; sin código ni QR en el chat).
3. Migración y redirección: añadir `…/reset-password` a las redirecciones permitidas de Auth (DEV) y un Preview con este código.
4. Anotar (sin cambiarlos) los ajustes «Secure password change» y «Require current password».

**Comprobación independiente previa (solo lectura, la hace quien opera el repositorio, no la herramienta):** con SQL de solo
lectura sobre DEV, confirmar que la cuenta de prueba NO tiene fila en `admin_roles` y que tiene exactamente un TOTP verificado
(la cuenta A, sin MFA, no usa la herramienta). Es independiente del control del servidor de la herramienta: ambos deben coincidir.

**Cómo se obtiene la sesión de recuperación sin abrir el enlace en el navegador.** El enlace del correo es una URL de Supabase
(`…/auth/v1/verify?token=…&type=recovery&redirect_to=…`) que responde con una redirección HTTP cuyo `Location` lleva el
fragmento `#access_token=…`. La SPA borra ese fragmento en cuanto lo consume, así que **no** se abre en el navegador para esta
prueba: se pide la redirección **sin seguirla** y el `Location` va **solo al portapapeles**. Esto **consume el enlace**
(un solo uso) pero no envía ningún correo ni cambia ninguna contraseña. El token de acceso resultante dura ≈ 1 hora.

**Ejecución (terminal PowerShell de la persona; nada de esto se pega en el chat; cada bloque se ejecuta por separado):**

1. Pedir el restablecimiento desde `/forgot-password` en el alias DEV con la cuenta de prueba (**envía un correo real**).
   En el correo, clic derecho sobre el botón → «Copiar dirección del enlace». No abrir el enlace.
2. Obtener la redirección sin seguirla y dejarla en el portapapeles. Comprueba el host de origen y el de destino y **solo imprime
   «OK» o un motivo, nunca el enlace**. Funciona en Windows PowerShell 5.1 y en PowerShell 7:

   El bloque va dentro de `& { … }` para que `return` aborte TODO el bloque también al pegarlo línea a línea en una terminal
   interactiva (sin el envoltorio, las líneas siguientes se ejecutarían igualmente) y para que las variables desaparezcan al
   terminar:

   ```powershell
   & {
     Add-Type -AssemblyName System.Net.Http
     $u = (Get-Clipboard | Out-String).Trim()
     if (-not $u.StartsWith("https://rkqeqbqwdswhpzwqptac.supabase.co/auth/v1/verify?")) {
       Write-Host "ABORTA: el portapapeles no es un enlace de verificacion de Supabase DEV"
       return
     }
     $handler = New-Object System.Net.Http.HttpClientHandler
     $handler.AllowAutoRedirect = $false
     $client = New-Object System.Net.Http.HttpClient($handler)
     $resp = $client.GetAsync($u).GetAwaiter().GetResult()
     $loc = if ($resp.Headers.Location) { $resp.Headers.Location.OriginalString } else { "" }
     $code = [int]$resp.StatusCode
     $good = ($code -ge 300 -and $code -lt 400) -and $loc.StartsWith("https://upmina-testing-backend.vercel.app/reset-password#") -and $loc.Contains("access_token=") -and $loc.Contains("type=recovery")
     if (-not $good) {
       Write-Host "ABORTA: la redireccion no es una sesion de recuperacion valida (HTTP $code). Pide un enlace nuevo"
       return
     }
     Set-Clipboard -Value $loc
     Write-Host "OK: redireccion obtenida (HTTP $code) y copiada al portapapeles"
   }
   ```

3. Definir las variables de la herramienta (la clave anon de DEV se copia del panel de Supabase; no se pega en el chat):

   ```powershell
   $env:VITE_SUPABASE_URL = "https://rkqeqbqwdswhpzwqptac.supabase.co"
   $env:VITE_SUPABASE_ANON_KEY = Read-Host "Clave anon de DEV"
   $env:UPMINA_DEV_CHECK_CONFIRM = "DEV_ONLY"
   ```

4. Prueba decisiva (sin completar el TOTP). En el aviso oculto, pegar el portapapeles (clic derecho o Ctrl+V):

   ```powershell
   node scripts/dev-password-reset-aal-check.mjs no-totp
   ```

5. Vaciar el portapapeles **y su historial** (Win+V → «Borrar todo»), porque contuvo un token válido ≈ 1 hora:

   ```powershell
   Set-Clipboard -Value " "
   ```

6. Interpretar solo la conclusión impresa:
   - `ALLOWED_AAL1` (código de salida 3): Supabase permite el cambio con `aal1` sin TOTP → hallazgo 1 **confirmado**; aplicar §6.
     **La contraseña de la cuenta ya cambió** a un valor aleatorio desconocido (cuenta desechable).
   - `REQUIRES_AAL2`: el servidor exige TOTP → hallazgo 1 **cerrado**.
   - `REQUIRES_REAUTH` / `REQUIRES_CURRENT_PASSWORD`: efecto de los ajustes de Auth sobre este flujo (ver §3).
   - Un aborto (código de salida 2) no ha cambiado nada: se corrige la causa y se pide un enlace nuevo.
7. Confirmación con TOTP: repetir los pasos 1, 2 y 3 con un enlace **nuevo** y ejecutar (pide el código TOTP oculto; **cambia la
   contraseña otra vez**):

   ```powershell
   node scripts/dev-password-reset-aal-check.mjs with-totp
   ```

   Después, vaciar de nuevo el portapapeles (paso 5) y limpiar las variables:

   ```powershell
   Remove-Item Env:VITE_SUPABASE_ANON_KEY, Env:UPMINA_DEV_CHECK_CONFIRM, Env:VITE_SUPABASE_URL -ErrorAction SilentlyContinue
   ```

8. Probar después, **en el navegador y con un correo distinto**, el flujo real de `/reset-password` (TOTP, cambio, cierre
   global, aviso en `/login`): un enlace ya consumido por el paso 2 no puede reutilizarse.
9. Retirar o dejar inerte la cuenta de prueba (con autorización).

Notas: el enlace puede estar ya consumido si el cliente de correo precarga los enlaces (la herramienta lo detecta como
«redirección no válida» y no cambia nada: se pide uno nuevo). Los comandos no contienen secretos, así que el historial de
PowerShell no guarda ninguno; la clave anon es pública pero aun así se pide con `Read-Host`.

## 6. Si Supabase PERMITE el cambio con `aal1`: alternativas de protección (propuestas, NO implementadas)

El riesgo: quien controle el buzón restablece la contraseña sin TOTP, entra con ella (acceso con contraseña reciente) y puede
iniciar la recuperación MFA de una cuenta privilegiada; solo lo frenaría la aprobación de otro Admin. Opciones, de menor a
mayor impacto (ninguna se aplica automáticamente; no se propone un bloqueo fijo de 24 horas):

1. **Aviso y trazabilidad:** activar en Auth el aviso «contraseña cambiada» (si el plan lo permite) y avisar a los Admins cuando
   se pide una recuperación MFA de una cuenta privilegiada poco después de un restablecimiento de contraseña.
2. **Marca en la recuperación MFA:** registrar en la solicitud si hubo un restablecimiento reciente (`auth.users.recovery_sent_at`)
   y mostrárselo al Admin que aprueba, sin bloquear.
3. **Espera o aprobación reforzada:** ampliar la espera o exigir un segundo aprobador solo cuando haya habido un restablecimiento
   reciente (ventana configurable, no fija).
4. **Bloqueo condicional:** rechazar las operaciones de recuperación MFA de cuentas privilegiadas con un restablecimiento
   reciente (ventana corta y configurable en base de datos), con mensaje claro.
5. **Impedir el restablecimiento de cuentas privilegiadas:** un hook de envío de Auth que no mande el correo de recuperación a
   cuentas con rol privilegiado (usa una función de Supabase, no un proveedor nuevo; cambia la experiencia de esas cuentas).
   Las opciones 2–4 se apoyan en el `amr`/auditoría existentes y requieren una migración candidata; decidir tras la prueba de §5.

## 7. Pasos que requieren autorización para DEV (no ejecutados)

1. Aplicar `20261104120000_mfa_recovery_reminder.sql` (prechecks, dry-run con solo esa migración, postchecks: función
   `(uuid, uuid)` solo `service_role`, restricción `kind` ampliada, ningún dato cambiado).
2. Añadir la URL `/reset-password` a las redirecciones permitidas de Supabase Auth (DEV).
3. Revisar en el panel de Supabase DEV: plantilla «Reset Password» en inglés, límites de envío, SMTP, y los ajustes «Secure
   password change» y «Require current password» (sin cambiarlos).
4. Desplegar un Preview con el código local.
5. Ejecutar la prueba de §5 con la cuenta de prueba ordinaria.
6. Probar el recordatorio con una solicitud aprobada y entregada (envía correos reales: autorización expresa).

## 8. «Olvidé mi contraseña» con comprobación del correo (lotes 3P-R y 3P-S — PREPARADO EN LOCAL, NO activo en ningún entorno)

**Decisión de producto (aceptada expresamente por el propietario):** el formulario REVELA si una cuenta está registrada, para
ofrecer «Crear cuenta con [correo]», pedir confirmar una cuenta pendiente o enviar la recuperación. Es enumeración de cuentas
deliberada: por eso la consulta lleva límites del servidor y la superficie restante sigue cerrada.

### Arquitectura (revisada en 3P-S)

- **Sin función serverless nueva.** El proyecto está en el límite de 12 del plan Hobby (7 entrypoints sueltos + 5 dispatchers).
  La acción vive en `api/profile.ts`: `POST /api/profile?action=password-recovery`
  (`src/lib/password-recovery-handlers.ts`, enrutada por `handleProfile`). Sin `action`, el router y los contratos de
  `/api/profile` no cambian.
- **El servidor COMPRUEBA y LIMITA; el navegador ENVÍA.** El backend valida el correo, aplica los límites por capas, consulta la
  base y responde `confirmed | unconfirmed | unregistered | rate_limited | error`. Con `confirmed`, el navegador llama a
  `supabase.auth.resetPasswordForEmail` (anon key, flujo oficial: mismo SMTP, plantilla en inglés y límites de Auth). Ya no se
  envía correo desde el servidor (en 3P-R sí): ver «Límites de Supabase Auth» más abajo.
- `service_role` solo se usa para la RPC `auth_email_lookup`; nunca llega al cliente. La respuesta es solo `{status}`.
- **Sin cambios en el restablecimiento:** `/reset-password`, la marca de recuperación, el paso TOTP y el cierre global no se tocan
  (los usuarios sin MFA no ven TOTP; con TOTP verificado se pide el factor). Un test estructural
  (`password-recovery-isolation.test.ts`) comprueba que nada de esto menciona MFA, roles ni `/reset-password`.
- Un fallo técnico (RPC, configuración) **nunca** se interpreta como «correo inexistente».

### IP confiable

Evidencia (documentación de Vercel, «Request headers»): `x-forwarded-for` es la IP pública del cliente y Vercel la
**sobrescribe** («no reenvía IPs externas») para impedir el spoofing; `x-real-ip` y `x-vercel-forwarded-for` son idénticas, y la
última además no la pisa un proxy delante de Vercel. Un cliente puede enviar esas cabeceras, pero Vercel las reemplaza; fuera de
Vercel (tests, `vercel dev`) no hay garantía, así que la extracción es defensiva:

1. Precedencia `x-vercel-forwarded-for` → `x-real-ip` → `x-forwarded-for` (en esta última, el **último** elemento, el añadido por
   el salto más cercano, nunca el primero).
2. Cada valor se valida con `net.isIP`; lo que no sea exactamente una IP (listas, puertos, zonas `%`, hostnames, inyecciones,
   textos largos) se descarta y se prueba la siguiente cabecera; sin ninguna válida la IP es `unknown` (bucket propio con los
   mismos límites, nunca un permiso libre).
3. IPv6 se agrupa por **/64** (rotar dentro de un /64 es trivial), la red por /24 (IPv4) o /48 (IPv6) y la IPv4 mapeada
   (`::ffff:a.b.c.d`) cuenta como su IPv4.
4. **La IP nunca sale del módulo en claro:** a la base solo llegan `HMAC-SHA256` de la IP y de la red (clave derivada del
   secreto del servidor, sin variable nueva); ni se registra ni se devuelve al navegador.

Lo que NO se pudo confirmar: que `x-vercel-forwarded-for` también se sobrescriba (la documentación lo afirma explícitamente solo
para `x-forwarded-for`; las otras dos se describen como idénticas). La prueba DEV controlada (§9) lo comprueba en caja negra.

### Migración candidata (NO aplicada) y rollback — límites por capas

`supabase/migrations/20261105120000_password_recovery_lookup.sql` y
`supabase/rollbacks/20261105120000_password_recovery_lookup.rollback.sql`.
`auth_email_lookup(p_email, p_ip, p_net)`: SECURITY DEFINER, `search_path = pg_catalog, public`, solo `service_role`; normaliza
(btrim + lower), busca EXACTO en `auth.users` (sin cuentas borradas) y devuelve solo `confirmed | unconfirmed | none`. Un
ayudante interno `auth_lookup_hit_` (UPSERT atómico) sin EXECUTE para ningún rol de API.

| Capa               | Límite (ventana fija)                                                                     | Qué frena                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1. Volumen por IP  | 20 / 10 min y 100 / hora                                                                  | abuso desde una IP (una oficina tras NAT cabe holgadamente)                                      |
| 2. Volumen por red | 100 / 10 min por /24 (IPv4) o /48 (IPv6)                                                  | rotación de IPs dentro de un rango                                                               |
| 3. Fallos por IP   | 8 `none`/`unconfirmed` / 10 min; al superarlo se rechaza TODO desde esa IP (acierte o no) | **enumeración**: un escaneo desde una IP se frena tras 8 fallos y el rechazo no revela nada      |
| 4. Correo          | 5 / hora, **solo** consultas cuyo resultado es `confirmed`                                | protege la bandeja; consultar correos inexistentes o sin confirmar nunca gasta la cuota de nadie |

**Se eliminó el límite global de 300/h** (riesgo 2 de 3P-R): cualquiera podía agotarlo para bloquear a todos. Ahora un atacante solo
puede bloquear **su propia IP/red** y, como mucho, la cuota de envíos de un correo concreto (5/h; igual que ya puede hacerlo con
el límite de 60 s por usuario de Auth). Un ataque distribuido con muchísimas IPs queda acotado por IP y red, pero no por un
techo global: la defensa de último recurso es del perímetro (reglas del Firewall de Vercel o «Attack Challenge Mode»,
configuración remota no realizada).
Los fallos por IP se serializan con `SELECT … FOR UPDATE` sobre su fila (orden fijo de contadores: sin interbloqueos).
Almacenamiento: `auth_lookup_limits` guarda solo digests SHA-256 salados y `auth_lookup_salt` la sal (generada en la base);
ambas con RLS + FORCE RLS, sin policies ni grants. Retención: cada llamada borra hasta 100 ventanas de más de 2 días.
Tests: `src/lib/password-recovery-lookup-migration.test.ts` (PGlite real, 29 tests; reproduce los privilegios por defecto de
Supabase para que los REVOKE importen). PGlite tiene una sola conexión: la atomicidad ante transacciones realmente paralelas
descansa en `INSERT … ON CONFLICT` y `FOR UPDATE` de PostgreSQL (se comprueba la sentencia).

### Límites de Supabase Auth (documentación; «Rate limits»)

- **Envío de correos:** límite por **proyecto** (en DEV, 30/h con SMTP propio). Lo agota cualquiera que provoque envíos
  (recuperación, confirmación…), por cualquier camino; mitigación: subirlo en Auth (configuración remota, no realizada).
- **Por IP:** `/signup`, `/recover`, `/resend`, `/magiclink`, `/otp` y `/user` comparten 30 peticiones / 5 min por IP.
  `/verify` 30 / 5 min por IP; `/token` 150 / 5 min; MFA challenge/verify 15 / min.
- **Por usuario:** `/recover` (y `/otp`, `/signup`) permiten una petición cada 60 s para el mismo usuario.
- **IP original desde un servidor:** por defecto Auth limita por la IP que le conecta (la de salida de Vercel). Solo se conserva la
  del cliente con la cabecera `Sb-Forwarded-For` **y una clave secreta** (`sb_secret_…`; la anon, la publishable y la
  `service_role` legacy no valen), con «IP Address Forwarding» activado en Auth (`security_sb_forwarded_for_enabled`).
- **Conclusión:** enviar desde el servidor haría que TODAS las recuperaciones compartieran el cupo de 30 / 5 min de la IP de
  salida de Vercel (agotable por un atacante), y la alternativa exige un secreto nuevo y un ajuste remoto. Se eligió **enviar
  desde el navegador**: cada persona usa su propia IP. Coste: el servidor no puede impedir que alguien llame a Auth
  directamente con la anon key (ya era así); para ese camino mandan los límites propios de Auth. El cambio no altera ninguna
  pantalla. Si algún día se quisiera enviar desde el servidor, la vía soportada es la clave secreta + `Sb-Forwarded-For` con la IP
  ya validada aquí, previa autorización.
- **No verificado en real:** el comportamiento exacto de estos límites en DEV (la documentación no distingue la IP efectiva de
  una función de Vercel). Ver la prueba de §9.

### Los estados (+ error)

| Estado                   | Backend                | Pantalla                                                                                                                                                                                              |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registrado y confirmado  | `confirmed` (no envía) | el **navegador** envía la recuperación oficial; confirmación + aviso de Spam + cooldown de 60 s; si Auth limita el envío: aviso y cuenta atrás de 60 s; otro fallo: error                             |
| No registrado            | `unregistered`         | «No encontramos una cuenta con este correo» + «Puedes crear una cuenta nueva con este correo» + «Crear cuenta con [correo]» (`/signup`, correo por ESTADO del router, nunca por la URL; sin cooldown) |
| Registrado sin confirmar | `unconfirmed`          | pantalla «todavía no está confirmado» de Login con reenvío por el flujo oficial (`auth.resend`), cooldown y sin duplicados                                                                            |
| Límite                   | 429 `rate_limited`     | aviso + cuenta atrás con `retryAfterSeconds`                                                                                                                                                          |
| Fallo técnico            | 502 / 503 `error`      | «No pudimos procesar la solicitud»; **nunca** «no encontramos una cuenta»                                                                                                                             |

«Crear cuenta» no se muestra de forma permanente: solo tras una respuesta confirmada de correo inexistente, y desaparece al editar el
correo. Solo `confirmed` dispara el envío (un test lo garantiza para el resto de estados y errores).

### Integración controlada (apagada por defecto)

`VITE_PASSWORD_RECOVERY_LOOKUP=1` (variable de build; `.env.example` la documenta comentada). Apagada, `/forgot-password` conserva
EXACTAMENTE el flujo neutro anterior. Esta versión ya **no necesita** `MFA_RECOVERY_APP_URL` ni la anon key en el servidor.

## 9. Prueba DEV controlada y activación (NO realizadas; cada paso requiere autorización expresa)

1. Aplicar `20261105120000_password_recovery_lookup.sql` (dry-run con solo esa migración; hash y postchecks: funciones y sus
   privilegios, tablas privadas, sal con una fila).
2. Desplegar un Preview con `VITE_PASSWORD_RECOVERY_LOOKUP=1` en el build.
3. **Anti-spoofing de cabeceras en caja negra** (sin endpoint de diagnóstico): desde una sola máquina, 21 consultas de correos
   confirmados distintos con una cabecera `X-Forwarded-For` / `X-Real-IP` / `X-Vercel-Forwarded-For` falseada distinta en cada
   una. Si la 21.ª devuelve 429 (límite de 20 por IP), Vercel ignora/sobrescribe lo falseado; si no, las cabeceras son
   manipulables y NO debe activarse. Repetirlo con cada cabecera por separado.
4. Estados reales con las cuentas de prueba (registrada confirmada con correo real, inexistente, sin confirmar con reenvío) y
   límites (9 fallos desde una IP → rechazo; 6 consultas confirmadas del mismo correo).
5. Comprobar en `/recover` desde el navegador que el límite por IP de Auth se reparte por persona (varias IPs).
6. Reversión: apagar la variable (vuelve el flujo neutro); el rollback SQL elimina funciones y tablas.

## 10. Los dos tests que fallaban en la suite completa (lote 3P-S): ninguno es una regresión

- `workers/media-delivery/src/handler.test.ts` — «tampered capability is rejected»: **fallo intermitente por diseño del test**.
  Sustituye los dos últimos caracteres base64url de una firma Ed25519 (64 bytes = 86 caracteres) por `AA`, lo que equivale a poner a 0
  el último byte de la firma. Ese byte es la parte alta del escalar S, que casi siempre es muy pequeña (0–15): en ≈ **6 %** de las
  firmas la «firma manipulada» es idéntica a la original y se acepta (medido: 1197 de 20 000 = 5,99 %; 5 de 25 ejecuciones aisladas
  y 4 de 25 en una copia limpia del commit anterior). El verificador es correcto. Arreglo propuesto (test, no funcionalidad): alterar
  un bit del PRIMER byte de la firma en vez de los últimos caracteres. **No se tocó** (fuera de alcance; lote independiente).
- `src/lib/media-abandoned-reservations.test.ts` — «con el reloj real nada es elegible: las 24 h no han pasado»: **depende del reloj
  real**. El test fija un «ahora simulado» (`2026-10-12T12:00:00Z`) y crea una reserva 25 h antes; con la política de 24 h esa
  reserva pasa a ser elegible con el reloj real a partir de `2026-10-12T11:00:00Z`, así que desde esa hora el test falla siempre.
  **Determinista y caduco**, no intermitente. Arreglo propuesto: construir las fechas relativas al reloj real (o no usar el reloj
  real en ese caso). **No se tocó** (media/R7; lote independiente).
- Ambos fallan también en una copia limpia del commit `HEAD` (anterior a todo el trabajo sin confirmar): preexistentes.
