# DEL-4 — Aviso final de eliminación completada

Estado: **implementado en local, sin aplicar**. La migración `supabase/migrations/20261127120000_account_deletion_completion_notices.sql`
NO se ha aplicado en DEV ni en Production, y nada de esto está desplegado.

## Piezas

| Pieza                                                  | Archivo                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Mensaje ES/EN/DE (HTML + texto, sin enlaces ni tokens) | `src/lib/account-deletion-completed-mail.ts`                                                                   |
| Tabla, 4 funciones y despertador                       | `supabase/migrations/20261127120000_account_deletion_completion_notices.sql`                                   |
| Captura al reclamar + envío tras el lote               | `src/lib/account-deletion-worker.ts` (`captureCompletionNotice`, `runCompletionNotices`)                       |
| Pruebas                                                | `account-deletion-notices.test.ts`, `account-deletion-completed-mail.test.ts`, `account-deletion-link.test.ts` |

## Flujo

1. **Captura.** Al inicio de cada trabajo (antes de las 6 etapas, por tanto antes de `auth_delete`), el worker llama a
   `account_deletion_notice_capture`, que copia el correo y el idioma desde `auth.users` si la solicitud está reclamada por ese worker y no
   completada. Es idempotente (`on conflict do nothing`). Si falla o no hay correo, simplemente no habrá aviso: la limpieza no cambia.
2. **Limpieza.** Sin cambios (mismas 6 etapas, mismas RPC, mismas alertas y reintentos). Ninguna etapa lee la tabla de avisos.
3. **Envío.** Al final de cada lote el worker llama a `purge` y `claim`. `claim` solo devuelve avisos cuya solicitud esté `completed` con
   `completed_at`, con lease de 10 min. El worker envía con `Idempotency-Key = account-deletion-completed-<request_id>` y llama a `finish`.
4. **Resultado.** Éxito ⇒ `status='sent'` y el correo se **borra en la misma sentencia**. Fallo ⇒ reintento a 5 min, 15 min, 1 h, 4 h; máximo 5
   intentos; `rejected`/`not_configured` abandonan de inmediato. Abandonado ⇒ correo borrado. Un fallo de correo nunca toca la solicitud ni la cuenta.
5. **Despertador.** `account_deletion_backlog()` (la única función de DEL-2 que se redefine) suma los avisos vencidos, para que un reintento
   despierte al ejecutor sin esperar a otra eliminación. La condición de limpieza es idéntica.

## Seguridad y privacidad

- Tabla con RLS **forzada**, sin policies, sin privilegios de tabla para nadie (ni `service_role`); solo cuatro funciones `SECURITY DEFINER`
  con `search_path` fijo y `EXECUTE` únicamente para `service_role`. Ningún cliente puede leer correos ni consultar otras solicitudes.
- Restricciones de tabla: el correo existe **solo** en `pending`/`sending`; `sent` exige `sent_at`; `sending` exige lease.
- Sin tokens de confirmación almacenados. Solo se guarda correo e idioma; el mensaje no contiene datos de la cuenta.
- **Retención máxima del correo: 14 días** desde la captura (`purge_by`), y en la práctica menos: se borra al enviar, al abandonar (5 intentos,
  rechazo, sin credenciales) o al pasar 23 h desde el primer intento. Tras ello queda solo la fila sin dirección (estado, intentos, fechas, código de error).
  Debe añadirse al catálogo de retención antes de aplicar a Production.

## Idempotencia: garantía real

- La reclamación es atómica (`FOR UPDATE SKIP LOCKED` + lease); dos workers no pueden enviar el mismo aviso a la vez.
- **Caso «el proveedor aceptó el correo pero el worker falló antes de registrar el éxito»:** el lease caduca, otro intento reutiliza la **misma**
  clave de idempotencia y Resend devuelve el resultado original sin reenviar (la clave vale 24 h según el proveedor). Por eso no se permite ningún
  reintento pasadas 23 h del primero: el aviso se abandona antes que arriesgar un duplicado.
- Resultado: **como máximo un correo por solicitud** dentro de la ventana de idempotencia del proveedor. **No es «exactamente una vez»:** si el
  proveedor aceptó y el aviso se abandona, el correo pudo entregarse sin quedar registrado; y si el proveedor dejara de respetar su clave de
  idempotencia, un reintento podría duplicar (riesgo residual aceptado, no verificable sin pruebas contra el proveedor real).
- Solicitudes históricas: las ya completadas no tienen fila, no reciben aviso y nada las bloquea. Las que estén en curso al aplicar la migración
  se capturan en su siguiente trabajo (si aún existe la identidad).

## Rollback

Está al principio del archivo SQL: borrar las 4 funciones y la tabla, y restaurar `account_deletion_backlog()` con la definición de
`20261114120000_account_deletion_runtime.sql`. Solo se pierden datos de avisos.

## Configuración DEV necesaria (no aplicada)

Variables del proyecto Vercel `upmina-web-testing` (el despliegue DEV es un Preview con alias estable, así que deben existir en el entorno
**Preview** y requieren un redespliegue; no se pueden cambiar en un despliegue ya hecho):

- `ACCOUNT_DELETION_APP_URL=https://upmina-web-testing.vercel.app` (https, sin barra final ni ruta).
- Revisar `MFA_RECOVERY_APP_URL` y `COPYRIGHT_APPEAL_APP_URL`: si valen el alias antiguo, los correos de MFA y de apelación seguirán apuntando allí.
- `MFA_RECOVERY_RESEND_API_KEY` y `MFA_RECOVERY_MAIL_FROM` ya deben existir; sin ellas los avisos se abandonan como `not_configured` y no se envían.
- **Vault de Supabase DEV:** `account_deletion_endpoint_url` decide qué despliegue ejecuta el worker. Si apuntara al alias antiguo, el worker
  seguiría ejecutando el build anterior (sin DEL-4). No verificado; confirmar que apunta a `https://upmina-web-testing.vercel.app/api/admin/account-deletion-run`.
- No tocar las referencias al alias antiguo en scripts de DEV ni en `MEDIA_CHECK_URL` del Worker.

## Pruebas

- SQL real con PGlite (`UPMINA_TEST_PGLITE_MODULE`), en `account-deletion-sql.test.ts` (bloque «DEL-4 · aviso final»): restricciones y FK, RLS forzada y
  privilegios por rol, `SECURITY DEFINER` + `search_path`, captura, reclamación, lease, reintentos y backoff, agotamiento, ventana de 23 h,
  retención de 14 días y purga, condición `completed`, `account_deletion_backlog()` frente a la definición anterior, solicitudes históricas, ejecutor
  real extremo a extremo (sin enviar antes de completar, una sola vez, misma clave en el reintento) y rollback.
- **No cubierto:** concurrencia real entre conexiones simultáneas (PGlite tiene una sola conexión; `FOR UPDATE SKIP LOCKED` se valida por
  su semántica y por las pruebas de lease, no con dos sesiones en paralelo) y el comportamiento real de Resend (la cabecera `Idempotency-Key` es la
  documentada por el proveedor y la que ya usa el remitente; no se probó contra la API real, por la restricción de no enviar correos reales).
- Rollback: `supabase/rollbacks/20261127120000_account_deletion_completion_notices.rollback.sql` (probado en PGlite).
