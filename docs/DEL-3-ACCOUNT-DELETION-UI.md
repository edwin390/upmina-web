# DEL-3 — Interfaz de eliminación de cuentas, panel Developer y etiquetas

Estado: **implementado y probado en local; sin commit, sin despliegue, sin cambios remotos.** Se apoya en DEL-1 y DEL-2 (ver `docs/DEL-1-ACCOUNT-DELETION.md` y
`docs/DEL-2-ACCOUNT-DELETION-BACKEND.md`). Las migraciones `20261113120000` y `20261114120000` ya están en Supabase DEV y no se vuelven a aplicar.
**Community NO está listo para Production** hasta completar y aprobar la validación integral en Preview (apartado 5).

## 1. Qué se implementó

| Pieza                      | Archivo                                                                                                                     | Notas                                                                                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entrada desde la cuenta    | `src/components/account/DeleteAccountLink.tsx` (en `AccountPage`)                                                           | Solo existe dentro de `/account` (exige sesión). Las cuentas con rol de equipo ven el enlace y la pantalla de destino les explica el procedimiento separado; **el servidor es la autoridad** (403 `privileged_account`)                                                 |
| Pantalla `/account/delete` | `src/pages/AccountDeletionPage.tsx`                                                                                         | 15 estados: inicial, solicitando, correo enviado, error de solicitud, token detectado, validando, válido, caducado, inválido (incluye «sesión de otra cuenta»), confirmando, bloqueada y en eliminación, error recuperable / resultado desconocido, cuenta privilegiada |
| Cliente HTTP               | `src/lib/account-deletion-client.ts`                                                                                        | Resultados cerrados, nunca lanza; el token solo viaja en el cuerpo de un POST                                                                                                                                                                                           |
| Token en memoria           | `src/lib/pending-deletion-token.ts`                                                                                         | Mismo diseño que `pending-appeal-token.ts`                                                                                                                                                                                                                              |
| Developer                  | `src/components/developer/DeveloperAccountDeletionsSection.tsx` (en `DeveloperPage`)                                        | Alertas y reintento sobre los endpoints existentes; sin RPC nuevas                                                                                                                                                                                                      |
| Etiquetas Community        | `AdminModerationPage.tsx` + `moderation.json` (`caseDetail.closureAuthorDeleted*`)                                          | `closure_kind = author_deleted` = «cierre administrativo»; no es decisión, sanción ni absolución                                                                                                                                                                        |
| Etiquetas Copyright        | `moderation.json` (`copyright.panel.status/events/actor`, añadidas en DEL-2)                                                | Estado `author_deleted` legible; filtros y contadores no fallan (`OPEN_CLAIM_STATUSES` no lo incluye: va al historial)                                                                                                                                                  |
| Traducciones               | `auth.json` → `accountDeletion` (ES/EN/DE) y `moderation.json`                                                              | Paridad verificada por `messages-parity.test.ts`. Los correos siguen en inglés                                                                                                                                                                                          |
| Privacidad                 | `src/pages/PrivacyPage.tsx`                                                                                                 | Ver apartado 3                                                                                                                                                                                                                                                          |
| Navegación                 | `App.tsx` (`/account/delete` antes del comodín `/:usernameParam`) y `safe-return-to.ts` (`/account/delete`, sin parámetros) | Una sola ruta, sin duplicados                                                                                                                                                                                                                                           |

## 2. Seguridad del flujo

- **Token (enlace `/account/delete#t=…`):** se lee del fragmento y se retira de la URL con `history.replaceState` (ruta y parámetros no sensibles se conservan); vive
  solo en una variable del módulo (30 min). Nunca `localStorage`, `sessionStorage`, cookies, URL, `returnTo`, analítica, logs ni DOM. Un token con forma inválida se trata
  como enlace inválido y no se envía. El módulo del cliente y el del token tienen una prueba estática que prohíbe almacenamiento persistente y `console`.
- **Sin efectos al abrir:** montar la página solo hace una vista previa de solo lectura (`account-deletion-preview`). La eliminación exige la casilla de
  reconocimiento y el botón «Eliminar mi cuenta de forma permanente» (probado: montar y validar nunca llaman a `confirm`). Doble envío bloqueado también con dos
  clics síncronos (guard con `ref`).
- **Resultado ambiguo:** red caída, timeout, 5xx, 2xx irreconocible o sesión rechazada durante la confirmación ⇒ pantalla «No pudimos confirmar el resultado»: no se afirma
  que se eliminó ni que no. «Comprobar de nuevo» usa la vista previa, que informa `already_deleting` si la barrera ya existe (el backend la atiende con `allowDeletingAccount`).
- **Tras 202 / `already_deleting`:** se limpia la sesión **local** (`signOut({scope:"local"})`, sin red) y el token; la pantalla final se renderiza desde estado propio, sin
  consultas autenticadas ni redirecciones (probado: sin bucle, sin llamadas posteriores). No hay botón de cancelar ni de restaurar. No hay endpoint de progreso.
- **Sesión no correspondiente:** el backend no distingue «token de otra cuenta» de «inválido» (a propósito): la pantalla da el mismo aviso y ofrece cerrar sesión.
- **Cuenta privilegiada:** aviso temprano con `/api/admin/access` (solo informativo) + rechazo del servidor en solicitud y confirmación. No hay forma de saltarlo desde el frontend.

## 3. PrivacyPage (revisión jurídica pendiente)

Esta rama contenía una versión antigua que afirmaba que el sitio «no ofrece cuentas». Se cambió **solo** lo necesario para no contradecir el producto real:
sección 2 (cuentas opcionales de Community; la sesión se guarda en el almacenamiento local del navegador) y sección 5 (cuentas de Community y eliminación de cuenta: cómo
solicitarla, confirmación por correo de 30 minutos y un solo uso, irreversibilidad, bloqueo, limpieza posterior, liberación del username, conservación restringida, límites
de copias de seguridad, cachés y enlaces firmados, cuentas de equipo). El texto dice expresamente que **los plazos de conservación aún no están definidos**.

**Pendiente de revisión jurídica (no resuelto, no declarado):** responsable del tratamiento y contacto de privacidad; base y plazos de conservación de reportes, casos,
sanciones, reclamaciones de copyright y auditoría; tratamiento del UUID conservado (dato potencialmente identificable, no anonimización); retención de la solicitud de eliminación;
alcance real de las copias de seguridad de Supabase/Cloudflare; derechos de acceso/portabilidad y cómo ejercerlos; coherencia con `docs/REP-1-COPY-1.md`; el borrador corregido que existe en `main`
(commit `1c19037`) debe reconciliarse con esta rama antes de integrar.

## 4. Pruebas locales (sin red, sin correo, sin borrado)

`AccountDeletionPage.test.tsx` (36), `account-deletion-client.test.ts`, `DeveloperAccountDeletionsSection.test.tsx`, `DeleteAccountLink.test.tsx`, más los ajustes de
`AdminModerationPage.test.tsx` (etiqueta `author_deleted`), `DeveloperPage.test.tsx` (tres secciones) y `safe-return-to.test.ts`. Cubren los 28 puntos solicitados con dobles.
**No validado en local (requiere Preview):** los endpoints reales con el frontend, el correo real, la sesión real de Supabase tras `signOut` local, el worker y R2.

## 5. Checklist de validación integral en Preview (a ejecutar tras autorización; NADA de esto se ha hecho)

**5.1 Código y entorno**

1. Preview de `upmina-web-testing` desde el worktree `C:\Dev\upmina-web-r5f` (`vercel deploy --target preview -e KEY=VAL`, solo variables por despliegue; no tocar variables compartidas ni el alias estable).
   Debe incluir DEL-1/2/3 (`api/admin/[action].ts`, `account-deletion-*`, `admin-auth.ts` con el gate, la pantalla y el panel). Comprobar `ls api` = 12 funciones.
2. Variables por despliegue: `ACCOUNT_DELETION_SHARED_SECRET` (≥ 32 caracteres, nuevo), `ACCOUNT_DELETION_APP_URL` (**el origen https exacto de esa Preview**; hay que desplegar, leer la URL y
   redesplegar con ella, o fijar antes un alias propio de la Preview), `COPYRIGHT_TEST_WINDOW_MINUTES=60` solo si se prueba Copyright. Ya existen en DEV: `VITE_SUPABASE_URL/ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `MFA_RECOVERY_RESEND_API_KEY`, `MFA_RECOVERY_MAIL_FROM`, `MFA_RECOVERY_APP_URL`, variables de R2 y `MEDIA_GC_SHARED_SECRET`. Nunca imprimirlas.
3. Migraciones ya aplicadas en DEV: `20261113120000` y `20261114120000` (historial remoto coincide con el local). No volver a aplicarlas.
4. La Preview tiene Deployment Protection de Vercel: `pg_net` no puede pasarla. **No se programa el cron.** El ejecutor se despierta (a) al confirmar (best-effort, 6 s) y (b) al pulsar el reintento de
   Developer; para tandas posteriores se invoca `account-deletion-run` a mano con una petición firmada (HMAC `UPMINA-ACCOUNT-DELETION-V1`, cabeceras `x-deletion-timestamp/-signature`) y el bypass de protección de Vercel
   en una cabecera, desde un script local que lea el secreto sin imprimirlo. Alternativa: cargar los dos secretos de Vault y llamar `select public.account_deletion_tick();` una vez por tanda (solo si la URL es accesible).
   Verificar antes cuál de las dos funciona; **no** programar `cron.schedule('account-deletion-tick', …)` hasta tener una validación aprobada.

**5.2 Antes de la eliminación (cuenta sintética `del3-validation-*@…`, sin roles, creada con la API de administración; correo de pruebas controlado)**

1. Con la cuenta, subir **desde el alias** (el CORS de R2 solo admite ese origen) un archivo sintético a una publicación propia; crear un caso pendiente con dos reportes de cuentas sintéticas; (opcional) una reclamación de Copyright activa sobre esa publicación.
2. `/account` muestra la entrada; `/account/delete` anónima solo pide iniciar sesión; con un rol de equipo (cuenta de equipo existente, sin cambiarle el rol) muestra el procedimiento separado y el servidor devuelve 403 al solicitar.
3. Solicitar el correo: llega UN correo en inglés con enlace `…/account/delete#t=…`; abrirlo **no** elimina (comprobar que la BD no tiene bloqueo); la URL pierde el fragmento; `localStorage/sessionStorage` sin token.
4. Token de otra cuenta (iniciar sesión con otra cuenta sintética): mismo aviso que inválido, sin consumirlo. Esperar la caducidad en una solicitud aparte (o ajustar con la solicitud previa) para ver «caducado».

**5.3 Eliminación (requiere autorización específica: deja un registro permanente)**

1. Confirmar con la casilla y el botón. Esperado: 202 → pantalla «bloqueada y se está eliminando»; sesión local limpia; sin redirecciones.
2. Con el JWT anterior (guardado por el script, sin imprimirlo): endpoints de Upmina → 401; GoTrue `/user` → 403 (`user_banned` / `session_not_found`); PostgREST solo `profiles`.
3. Invocar el ejecutor (5.1.4) y seguir las etapas hasta `completed`; con el GC existente (cron `community-media-purge-tick`, ya activo) los archivos pasan de `deleting` a desaparecidos; verificar `media_gc_pending` mientras tanto.

**5.4 Estado final a comprobar (solo lectura)**

- Auth: `auth.users` sin la cuenta; sin sesiones. Perfil: sin fila; **username libre** (registrar otra cuenta sintética con el mismo username: UUID distinto, sin strikes/casos/roles/publicaciones/archivos).
- Community: publicaciones y «me gusta» fuera; caso pendiente `closed` con `closure_kind = author_deleted`, sin decisión nueva ni strike nuevo; cola «Activos» y contador sin ese caso; historial con la etiqueta «Cierre administrativo…».
- Copyright: reclamación activa en `author_deleted` con evento `author_deleted` (actor `system`), enlace de apelación invalidado, snapshot intacto; panel sin errores.
- R2: objetos exclusivos borrados; compartidos conservados; sin objetos huérfanos de la cuenta.
- Auditoría: `account_deletion_events` con `requested, confirmed, cleanup_claimed, stage_*, case_closed, completed`; sin tokens ni correos; `moderation_audit_log` y strikes previos idénticos.
- Alertas: provocar un fallo controlado (p. ej. secreto/URL incorrecta en una segunda cuenta sintética) y comprobar `account-deletion-alerts` con un Developer; **en DEV no hay Developer**: o se prueba con dobles (hecho) o se crea uno con autorización expresa
  (no se elevan roles reales sin ella). Reintento manual: solo reprograma; la alerta persiste hasta `completed`.

**5.5 Retirada tras la prueba**

1. No programar ni dejar cron; eliminar los secretos de Vault `account_deletion_*` si se cargaron.
2. Eliminar la Preview (`vercel remove <deployment>`), conservando el alias estable y los despliegues existentes.
3. Borrar las cuentas sintéticas **que no pasaron por la eliminación** con la API de administración. La cuenta eliminada deja, por diseño, registros inmutables (`account_deletion_*`, UUID): documentarlo; no se pueden borrar.
4. Anotar resultados y riesgos residuales en `docs/DEL-2-ACCOUNT-DELETION-BACKEND.md` §8.

## 6. Pendiente antes de Production

Validación integral aprobada; revisión jurídica del texto de privacidad y de los plazos de retención; programar el cron `account-deletion-tick` con los secretos de Vault **solo** tras esa aprobación; aplicar migraciones en Production
**antes** del código (el gate es fail-closed); reconciliar `PrivacyPage` con `main`; decidir el procedimiento separado para cuentas con rol de equipo (D10).
