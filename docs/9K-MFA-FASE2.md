# 9K · MFA fase 2 — recuperación de un autenticador perdido (sin perder el rol)

**Estado:** implementado y validado en LOCAL (2026-10-11). NO aplicado en DEV ni Production, sin commit, **sin Resend
configurado**. No se declara completada hasta tener validación real (§9). Independiente de la fase 1
(`docs/9K-MFA-FASE1.md`), cuyo patrón reutiliza.

## 1. Qué resuelve
Un miembro (admin, developer o moderator) pierde su app autenticadora pero **conserva su rol**. Recorrido:
solicita → verifica su correo con un desafío propio → otro **admin** con MFA reciente aprueba → el aviso de aprobación
se **entrega** (confirmado por el proveedor) y pasa la espera de 15 min → el titular invalida su factor perdido →
configura uno nuevo → queda `completed`. El rol no se toca y no se consume ninguna invitación.

## 2. Hechos verificados de Supabase Auth (y sus límites)
- `/admin/mfa` enrola con `mfa.enroll/challenge/verify` y **no exige rol**; funciona en `aal1`.
- Las operaciones privilegiadas exigen JWT verificado → rol actual en `admin_roles` → capacidad → MFA reciente.
  Solo `admin` tiene `team_admin`: «solo un admin aprueba» ya sale de la matriz existente.
- `signInWithOtp/verifyOtp` por correo **no** sirve para esto: el OTP es por usuario (no por solicitud), comparte plantilla
  con el inicio de sesión y `amr=otp` no prueba un desafío concreto. **No se usa.**
- **Credenciales recientes (`passwordVerifiedAt`) — alcance exacto.** Es el `timestamp` de la entrada `password` del
  claim `amr` de un JWT verificado criptográficamente: acredita que *esa sesión* nació de un inicio de sesión con
  contraseña hace ≤ 10 min (`PASSWORD_RECENT_WINDOW_SECONDS`); solo cuenta el método `password` (un `otp`/enlace mágico no
  vale) y refrescar el token no lo renueva. **No es una reautenticación independiente**: no vuelve a pedir la contraseña
  en el momento de la operación, así que una sesión robada o un token filtrado de menos de 10 min lo cumple igual que la
  persona legítima. Por eso es solo una capa de reducción de ventana y **no sustituye** a los dos requisitos obligatorios:
  (1) el desafío del correo propio (control del buzón, un solo uso, ligado a la solicitud) y (2) la aprobación de OTRO admin
  con MFA reciente. Ninguno de los tres es suficiente por sí solo y la ejecución exige además el aviso entregado y la espera.
- **Confirmación de contraseña sin salir del flujo.** Si el servidor informa `recentLogin: false`, la página muestra «Contraseña actual» y las acciones que avanzan el proceso quedan bloqueadas. Se confirma con `supabase.auth.signInWithPassword` (correo de la propia sesión, desde el navegador): crea una sesión nueva `aal1` de la MISMA cuenta cuyo JWT trae `amr: password` con marca actual, que es lo que comprueba el servidor (`reauthenticate()` no sirve: solo emite un nonce para cambiar la contraseña). La contraseña no se envía a nuestros endpoints, no se guarda y se borra del estado antes de la llamada; no se pide TOTP. Tras confirmar se recarga el estado y, si el servidor aún no la reconoce, se avisa sin bucles. Aplica la misma salvedad: no es reautenticación independiente frente a una sesión robada.
- **No verificable desde aquí** (sin token de gestión): SMTP/plantillas de Supabase y notificaciones de seguridad de Auth.
  El diseño **no depende de ellas**: el desafío y los avisos salen por Resend.

## 3. Estados y reglas (migración `20261031150000_admin_mfa_recovery.sql`)
`pending_email → pending_approval → approved → executing → factors_deleted → completed`; cierres `denied`, `cancelled`,
`expired`. `factors_deleted` ≠ `completed`: solo se completa cuando la sesión acredita un TOTP verificado **nuevo**.
- Una activa por cuenta (índice único parcial); 3 solicitudes/24 h; vigencia total 24 h.
- Desafío: 256 bits aleatorios generados en el backend; en la base **solo su SHA-256**. Ligado a solicitud + usuario + correo
  (hash del correo registrado; si cambia → la solicitud se cancela en cada paso). Un solo uso (se borra al acertar),
  15 min, 5 intentos (al 5.º falla → `cancelled`), 3 envíos máx. con 60 s de enfriamiento; reenviar invalida el anterior.
- Aprobación: otro `admin` (RPC lanza `actor_not_admin` si no lo es; `self_approval` si es el titular); solicitud vigente,
  correo verificado, correo y rol sin cambios. Rechazo con motivo obligatorio (≤ 200).
- Ejecución (`begin_execute`): exige aprobada, rol y correo iguales, **aviso de aprobación en `delivered`** y espera
  cumplida: 15 min desde la aprobación **y** desde la entrega confirmada. Toma la **instantánea de ids TOTP** y la guarda;
  reintentos reutilizan la misma instantánea. El backend borra **exactamente** esos ids con
  `auth.admin.mfa.deleteFactor` (404 = resuelto), confirma con `listFactors` y registra. Un factor nuevo (otro id) nunca se
  borra. Dos ejecuciones simultáneas son inocuas (advisory lock + borrado idempotente).
- Si el aviso falla o nunca llega la confirmación → la ejecución queda **bloqueada** (`notice_pending`/`notice_failed`) y
  un admin puede reenviarlo. No se inventa un estado de entrega y «entregado» ≠ «leído».
- `complete`: `auth.sessions` en `aal2` con `factor_id` de un TOTP verificado del titular, no presente en ninguna
  instantánea (fase 1 o 2) y creado después del borrado.
- Tablas con RLS forzada y sin acceso para ningún rol de la API; `admin_mfa_recovery_events` (auditoría, solo anexar) y
  `admin_mfa_recovery_mail` (estado de envío/entrega, sin contenido). Todas las RPC solo para `service_role`.

## 4. Correo (Resend) — interfaz y adaptadores
`src/lib/mfa-recovery-mail.ts`: `MailSender`; adaptador Resend (`Idempotency-Key`, timeout 8 s, errores reducidos a clase:
`rate_limited`, `provider_unavailable`, `rejected`, `timeout`, `invalid_response`, sin cuerpo ni dirección ni clave);
doble de pruebas en `mfa-recovery-mail-fake.ts`. Estados separados: *pendiente → aceptado → entregado | fallido*; solo el
webhook firmado produce `delivered` y nunca se degrada. Cuatro correos: `challenge` (hace también de aviso de solicitud),
`approved`, `closed` (denegada/cancelada/caducada) y `completed`. La clave de idempotencia es por evento
(`recovery:<id>:<tipo>[:<n.º de envío>]`) más el n.º de intento.
Webhook `POST /api/admin/mfa-recovery-webhook`: firma estilo Svix (`svix-id/timestamp/signature`, HMAC-SHA256, tolerancia 5 min,
comparación en tiempo constante). Sin firma válida → 401 y nada cambia (falla cerrado).
**Cuerpo original y Vercel.** El runtime de Vercel (`@vercel/node` 13.0.1, `helpers.ts`) lee el flujo completo para construir
`req.body` y después lo **repone** (`restoreBody`): los listeners `data`/`end` reciben los bytes originales, mientras que
`req.body` es el JSON ya analizado (puede no reproducir los bytes firmados). El handler lee primero el flujo (`readRawBody`,
sin tocar `req.body`); si no hay flujo utilizable usa el texto/Buffer; la reserialización del JSON es el último recurso y,
si no coincide, la firma falla (cerrado). No hace falta `bodyParser: false` ni cambiar las demás rutas: `req.body` sigue
llegando analizado para ellas (probado). Un evento que llega antes de registrar el id del envío devuelve 503 para que Resend
reintente; entregas repetidas o fuera de orden las resuelve la base (una entrega confirmada nunca se degrada; una entrega
tardía corrige un fallo previo; abrir/clic/enviado se ignoran). **Pendiente de validar con Resend real** que el flujo repuesto
entrega los mismos bytes en producción (la réplica local sigue el código del paquete instalado). Recomendación: usar un
subdominio y webhook dedicados a estos avisos, porque los eventos de otros correos de la misma cuenta devolverían 503.

## 4b. Enlace de cancelación del correo de aprobación
El correo `approved` lleva «Si NO fuiste tú, cancela…» con `https://<app>/admin/mfa/recovery/cancel#t=<token>`.
- Token de 256 bits generado en el backend; en la base solo su SHA-256 (`cancel_hash`, índice único), ligado a UNA
  solicitud, un solo uso (se borra al usarse o al cerrarse la solicitud) y válido mientras la solicitud pueda ejecutarse
  (hasta `expires_at`). Se emite al aprobar; reenviar el aviso lo ROTA (el anterior deja de valer) salvo que el último aviso
  ya esté entregado (entonces no se reenvía). Solo cuenta el último aviso para habilitar la ejecución.
- Sin sesión ni TOTP, y solo puede cancelar: no aprueba, no ejecuta, no cambia roles ni toca factores.
- El token viaja en el **fragmento** (no llega al servidor ni a los logs). **GET no cancela:** abrir el enlace carga la
  pantalla pública, que hace un `POST {op:"check"}` (solo lectura) y muestra un botón; la cancelación real es un
  `POST {op:"cancel"}` explícito (un escáner de enlaces no ejecuta el JavaScript ni pulsa botones). `GET` a la API → 405.
- Respuesta única (404) para enlace inválido, usado, caducado o de una solicitud cerrada: no revela nada. Se avisa del
  cierre al titular (mejor esfuerzo).
- Carreras: la cancelación y `begin_execute` comparten el candado de la cuenta (se serializan). Si la cancelación llega
  DESPUÉS de `begin_execute`, el ejecutor consulta `admin_mfa_recovery_execution_allowed` antes de CADA borrado y se
  detiene sin registrar éxito; `record_execution` rechaza una solicitud cerrada. Residual: el instante entre esa consulta y
  la llamada a Auth, y los factores ya borrados antes de cancelar no se restauran.
- Auditoría: evento `cancelled` con detalle `cancelled_by_link` y actor nulo; el token nunca se registra.

## 5. Endpoints (mismo dispatcher `api/admin/[action].ts`, sin funciones nuevas)
- `mfa-recovery` (titular, cualquier rol, `aal1` basta): GET estado; POST `request|resend|verify|cancel|execute|complete`.
  El `user_id`, la solicitud y la sesión salen del JWT verificado y de la base; el body nunca los elige.
  `request/resend/verify/execute` exigen credenciales recientes (403 `recent_login_required`). Sin configuración de correo → 503 y
  no se crea nada.
- `mfa-recovery-admin` (ADMIN + MFA reciente): GET lista (sin correo ni secretos); POST `approve|deny|cancel|resend_notice`.
- `mfa-recovery-cancel` (pública, solo POST `{op: check|cancel, token}`).
- `mfa-recovery-webhook` (firma).
UI: `/admin/mfa/recovery` (enlace «Perdí mi autenticador» en el paso de código de `/admin/mfa`) y la sección «Recuperación de
autenticadores» del panel (ADMIN), con estado vacío explícito.

## 6. Único administrador
No hay recuperación automática. Si no existe otro `admin`, `create` responde `no_approver` y la interfaz explica que se
requiere recuperación excepcional. **Procedimiento excepcional (propietario, a documentar/validar antes de usarlo):** (1) el
propietario comprueba la identidad fuera de banda; (2) desde el panel de Supabase (Authentication → Users → factores del
usuario) elimina el factor TOTP perdido o usa la API de administración; (3) la persona inicia sesión y enrola uno nuevo en
`/admin/mfa`; (4) se anota en la auditoría operativa. No se reutiliza el bootstrap (`admin:bootstrap-invitation`), no se
crean ni se editan filas de `admin_roles`, y no se debilita el MFA de otros.

## 7. Pruebas locales (sin Supabase/Resend reales)
SQL real (PGlite, 42): solicitud, rol/correo no confirmado, único admin, límites, desafío (reuso, intentos, caducidad,
reenvío, ligado al usuario), cambio de correo/rol, aprobación (autoaprobación, moderator/developer, doble, caducada),
rechazo, cancelación, aviso (aceptado ≠ entregado, fallo, espera desde entrega, no degradar, abrir/clic ignorados),
instantánea, reintento, factor nuevo protegido, `completed` solo con factor nuevo en `aal2`, permisos y rollback.
Backend (48 + 28): handlers con el adaptador Resend real contra `fetch` simulado, webhook firmado, borrado exacto, fallos
parciales, sin secretos en respuestas. UI (15 + 10). Mutaciones comprobadas (3): contar «aceptado» como entregado,
permitir autoaprobación y no destruir el desafío rompen tests.

## 8. Qué NO está probado y requiere configuración/pruebas reales
Resend (cuenta, dominio/subdominio verificado + DNS SPF/DKIM, clave con permiso de envío, `RESEND_WEBHOOK_SECRET` y webhook a
`/api/admin/mfa-recovery-webhook` con eventos `email.delivered/bounced/failed/suppressed`), recepción real del correo,
firma real del webhook (§4), borrado real de factores por la API, degradación de sesiones, `auth.sessions.factor_id` del factor
nuevo (ya observado en fase 1), y el recorrido completo con `eds`.
Variables (DEV, solo servidor): `MFA_RECOVERY_RESEND_API_KEY`, `MFA_RECOVERY_MAIL_FROM`, `MFA_RECOVERY_APP_URL`, `RESEND_WEBHOOK_SECRET`.
Privacidad: Resend actuaría como encargado de tratamiento de correos transaccionales a miembros del equipo (no a usuarios
públicos); revisar la política de privacidad antes de producción.

## 9. Prueba con `eds` (NO ejecutada)
Prerrequisitos: migración en DEV, Preview con el código nuevo, variables y webhook de Resend, `eds` moderator con TOTP
verificado y `edwin1` admin. Secuencia: (1) `eds` inicia sesión con contraseña (aal1) y pulsa «Perdí mi autenticador» →
solicitar; (2) recibe el correo y abre el enlace con la sesión → pendiente de aprobación; (3) `edwin1` (sesión aparte, MFA reciente)
aprueba; (4) SELECT: aviso `delivered`; esperar 15 min; (5) `eds` invalida (`factors_deleted`; si su sesión cae, inicia sesión de
nuevo); (6) `eds` enrola y verifica un TOTP nuevo en `/admin/mfa`; (7) «Ya lo configuré» → `completed`; (8) SELECT de rol
(intacto), factores, solicitud, eventos y correos. Variante negativa: intentar ejecutar antes de la espera o con el aviso no
entregado debe fallar.

## 10. Decisiones / límites de seguridad
1. Cancelación desde el correo: **implementada** (§4b).
2. El admin que aprueba debe confirmar la identidad **fuera de banda** (la aplicación no lo puede comprobar).
3. `passwordVerifiedAt` no es una reautenticación independiente (§2); el desafío del correo y la aprobación de otro admin con
   MFA reciente siguen siendo obligatorios. Revisión de bypass: no se encontró ninguno concreto (ver pruebas de cancelación,
   aviso entregado, espera, instantánea y rotación del token).

## 11. Mejoras de experiencia (correos en inglés, continuidad con el login, cierre al volver al panel)
- **Correos en inglés.** Los cuatro correos de la recuperación (verificación, aprobación con enlace de cancelación, cierre y
  finalización) están en inglés y solo ASCII (un test lo impide si se cuela español). Enlaces, tokens, claves de idempotencia y
  lógica de envío no cambian. No se tocó ningún otro sistema de correo.
- **Continuidad tras iniciar sesión.** `/admin/mfa/recovery` es un destino de retorno permitido (`safe-return-to`, sin parámetros:
  el código nunca viaja en `returnTo`, ni en query/fragmento del login). Sin sesión (nunca iniciada, caducada o expirada a mitad
  del flujo, 401) la página muestra «Iniciar sesión» → `/login?returnTo=/admin/mfa/recovery` y vuelve sola. El código del enlace
  del correo se retira de la URL y se conserva SOLO EN MEMORIA (`pending-recovery-code.ts`, 15 min, igual criterio que las
  invitaciones: nunca en storage/cookies). Cross-dispositivo y cross-pestaña: la solicitud vive en el servidor, así que tras
  iniciar sesión en cualquier dispositivo se recupera su estado; si el código en memoria se perdió (otra pestaña, otro
  dispositivo, refresco), se puede reabrir el enlace del correo o PEGAR el enlace completo (o el código) en el campo, que extrae
  el código. «Cambiar de cuenta» es explícito (cierra sesión y vuelve al login conservando el código para la cuenta correcta); el
  código de otra cuenta lo rechaza el servidor. Se mantienen contraseña reciente, MFA, titularidad y permisos (todo en el
  backend). Si la solicitud ya no está en `pending_email` (cancelada, caducada, aprobada…) se muestra su estado y el código
  pendiente se descarta.
- **Cierre al volver al panel.** `GET /api/admin/access` (que las pantallas privilegiadas y `/admin/mfa` consultan tras verificar
  el TOTP) reutiliza `finishRecovery` cuando la sesión VERIFICADA es de un miembro con MFA reciente: una sola RPC idempotente
  (`admin_mfa_recovery_complete`) que no hace nada sin recuperación pendiente o sin evidencia. Mejor esfuerzo: no cambia la
  respuesta de `/access`, no se ejecuta para USER ni sin MFA reciente, y no hay polling global. La revocación de la fase 1 no
  se toca. Sin migraciones nuevas.
- **Riesgos.** `/access` hace una consulta más para miembros con MFA reciente (índice por usuario; coste despreciable); un fallo se
  ignora. El código en memoria no sobrevive a un refresco (por diseño). Abrir el enlace en otro dispositivo requiere iniciar
  sesión allí o pegar el enlace en la sesión original.

## 12. Developer Panel V1 (aprobación excepcional) y mejoras de experiencia

Ver `docs/9K-DEVELOPER-PANEL-V1.md`. Resumen de lo que cambia respecto a esta fase:

- Si el solicitante es un Admin y es el **único administrador elegible** (otro admin distinto, vigente, no
  bloqueado ni eliminado y con TOTP verificado), un **Developer** distinto puede aprobar o rechazar con un TOTP
  de ≤ 5 minutos. Si existe otro admin elegible, solo otro Admin aprueba (flujo de este documento, sin cambios).
- La solicitud puede crearse si hay otro admin **o** un Developer; `hasApprover` usa el mismo criterio. Con
  Developer, el texto del §«único administrador» de esta fase deja de ser una vía exclusivamente manual.
- La aprobación excepcional deja `approval_kind='exceptional'` / `approver_role='developer'` y el evento
  `approved` con detalle `exceptional:developer`; el aviso lo indica en inglés. Todo lo demás (aviso entregado,
  espera, instantánea, borrado exacto, nuevo TOTP, cierre automático) es el mismo mecanismo.
- `#c=` con la página montada (evento `hashchange`) y ayuda por código perdido tras recargar: implementados.
  Una cuenta sin solicitud con un código pendiente conserva el código y ofrece «Cambiar de cuenta».
