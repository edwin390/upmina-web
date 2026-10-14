# REP-1 + COPY-1 — Reportes de Community y derechos de autor

**Estado (local, sin commit):** REP-1 implementado y probado; migración de motivos ordinarios y rollback preparados y
probados en PGlite (NO aplicados); plantillas de notificación de copyright implementadas (módulo puro, sin conexión a nada);
corrección factual de `PrivacyPage`. El circuito de copyright (backend, tablas, evidencias, correo) está **solo diseñado**
(§3) y se detiene ahí. No se tocó DEV, Production, R7, R2, 9N, AUTH ni la protección de identidad.

## 1. REP-1 — estado local

| Pieza                                                          | Archivo                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Botón + diálogo de reporte (es/en/de, accesible)               | `src/components/community/CommunityReportButton.tsx`                                                                |
| Validación del formulario (motivo, 1000 caracteres, controles) | `src/lib/community-report.ts`                                                                                       |
| Integración en tarjeta del feed y detalle de publicación       | `CommunityFeedCard.tsx`, `PostDetailPage.tsx` (hermano de los enlaces)                                              |
| Cliente reutilizado, con la razón de `account_incomplete`      | `src/lib/moderation-client.ts`                                                                                      |
| Servidor: lista cerrada de motivos y rechazo de NUL/controles  | `src/lib/moderation-handlers.ts`                                                                                    |
| Cola de moderación: filtro, parser y etiquetas de los motivos  | `moderation-case-handlers.ts`, `moderation-case-parser.ts`, `AdminModerationPage.tsx`, `ModerationQueueFilters.tsx` |
| Textos                                                         | `src/i18n/locales/{es,en,de}/moderation.json` (`report.*`, `reasons.*`)                                             |

Reutilizado sin cambios: `moderation-report-create`, el wrapper de AUTH-2, agrupación por caso/ciclo, ocultamiento por
umbral (3 reporteros distintos), auditoría, strikes y roles.

**Orden de despliegue obligatorio:** la UI y el backend ya ofrecen/aceptan `violence`, `off_topic` y `ai_generated`. Mientras
la migración `20261106120000` no esté aplicada en un entorno, enviar uno de esos motivos allí devuelve un error genérico
(la RPC lo rechaza). **Migración primero, backend/UI después.**

## 2. Dos circuitos separados

| Circuito                              | Entrada                                                 | Efecto sobre la publicación                               |
| ------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| **Reporte comunitario ordinario**     | botón «Reportar» (8 motivos)                            | cuenta para el umbral y puede ocultarla preventivamente   |
| **Reclamación especial de copyright** | canal propio (§3), expediente propio, validación humana | **ninguno automático**; solo un moderador puede retirarla |

**Copyright no es un motivo ordinario** y nunca incrementa el contador que oculta publicaciones: el formulario ordinario no lo
ofrece (el diálogo remite a «Otro motivo» solo como solución interina y aclara que no es una reclamación formal), el CHECK de la
tabla y la RPC lo rechazan (`copyright` → `invalid_reason`; probado en SQL real y en el handler).

### 2.1 Motivos ordinarios incorporados y por qué

| Motivo         | ¿Necesario? | Encaja en el sistema ordinario                                                      |
| -------------- | ----------- | ----------------------------------------------------------------------------------- |
| `violence`     | sí          | misma clase que acoso/sexual; sin conflicto con ninguna regla                       |
| `off_topic`    | sí (pedido) | encaja, **con una advertencia de política** (ver abajo)                             |
| `ai_generated` | sí (pedido) | encaja, **con la misma advertencia**; generar con IA no está prohibido por sí mismo |

En el código vigente el motivo solo se valida y se almacena: el umbral, los ciclos, las decisiones y los strikes **no
distinguen por motivo** (verificado en la RPC vigente, en la lectura de la cola y en la agregación de auditoría). Por tanto
añadir motivos no rompe ninguna política. **Decisión tuya pendiente:** con el comportamiento actual, 3 reportes de
`off_topic` o `ai_generated` ocultan preventivamente una publicación igual que 3 de acoso. Si prefieres que esos dos motivos
**no** oculten y solo lleguen a la cola, hay que cambiar la regla de ocultamiento (el conteo del umbral) en una migración
distinta; no lo hice porque pediste no modificar las reglas de ocultamiento existentes.

### 2.2 Migración y rollback (preparados, NO aplicados)

- `supabase/migrations/20261102120000_community_report_reasons.sql`: (1) recrea el CHECK `community_post_reports_reason_check`
  con 8 motivos (`not valid` + `validate`, sin reescribir filas); (2) `create or replace` de
  `community_post_report_submit_core` partiendo de la definición **vigente** (20261012, renombrada por el wrapper de AUTH-2 en 20261025) cambiando solo la lista; (3) `create or replace` de `community_moderation_cases_read` (20261030) con el filtro
  ampliado. El wrapper público de AUTH-2 **no se toca**; el ACL se reafirma (core sin ejecución para nadie; lectura solo
  `service_role`). No toca R7, media, cron, strikes, roles, perfiles ni usuarios.
- `supabase/rollbacks/20261106120000_community_report_reasons.rollback.sql` (fuera de `supabase/migrations`, así `db push` no
  lo ve): se niega (`rollback_blocked_new_reasons_in_use`) si ya hay reportes con motivos nuevos; si no, restaura CHECK y las
  dos funciones a su definición previa exacta. Para usarlo hay que copiarlo a una **migración nueva**.
- Pruebas (`community-report-reasons-sql.test.ts`, 28 tests, PGlite con la cadena real incluido AUTH-2): los 8 motivos entran
  por el wrapper; `copyright` y variantes se rechazan; AUTH-2 sigue bloqueando cuentas sin verificar; el umbral sigue en 3
  reporteros distintos con cualquier mezcla de motivos y los duplicados no cuentan; autor no puede reportarse; el filtro de la
  cola acepta los nuevos y rechaza `copyright`; ACL; sin backfill; las funciones nuevas son **idénticas** a las vigentes salvo
  la lista (comparación textual contra los archivos originales); rollback funcional y con negativa.
- Existe además una RPC antigua `community_post_report_create` (20261007) que no se usa y conserva la lista vieja; no se
  modificó (el handler que la usaba está retirado, `individual_moderation_retired`).

## 3. COPY-1 — circuito independiente de copyright (DISEÑO; no implementado)

Se detiene aquí porque requiere backend nuevo, tablas, almacenamiento de evidencias e integración de correo.

### 3.1 Política aprobada → flujo

1. **Presentación:** el titular (con o sin cuenta) envía una reclamación por el canal de §3.3. Se crea un expediente `CPY-AAAA-NNNNNN`
   con acuse. **No** se crea ningún reporte ordinario, **no** se toca el caso/ciclo de moderación, **no** hay ocultamiento
   automático.
2. **Verificación humana:** un moderador (capacidad `moderation`, `aal2`) revisa si la reclamación tiene fundamento.
3. **Más información:** el moderador puede pedirla por correo al reclamante (estado `needs_info`); cada envío queda en el expediente.
4. **Decisión:** el moderador decide retirar o descartar. Solo él: **la IA de 9L no interviene** (el expediente no se ofrece
   a ningún clasificador).
5. **Primera infracción confirmada:** retirada + advertencia educativa, **sin strike**.
6. **Reincidencia confirmada:** retirada; cualquier sanción adicional la decide un moderador (nunca automática).
7. **Notificación al usuario:** generada automáticamente con las plantillas de §4 a partir de los campos confirmados.
8. **Impugnación/contranotificación:** solo el mecanismo que resulte legalmente exigible (§3.6); no se construye un sistema de
   apelaciones informal.

### 3.2 Estados

`received → in_review ⇄ needs_info → upheld | dismissed | withdrawn`. `upheld` y `dismissed` generan notificación; `withdrawn`
(retirada por el reclamante) no sanciona. Las transiciones son monótonas salvo `needs_info ⇄ in_review`, y cada una escribe un evento.

### 3.3 Canal público para titulares sin cuenta (propuesta)

Formulario público (página `/copyright` o `/dmca` según decisión legal) → endpoint nuevo dentro de un dispatcher existente
(`api/content/[resource].ts` o el de admin; **no** una función serverless nueva por el límite del plan Hobby) → inserción con
`service_role`. Anti-abuso: verificación del correo del reclamante por enlace de un solo uso antes de que el expediente
entre en `in_review`, límite por IP y por correo, tamaño/tipo de adjuntos acotado, captcha si hace falta. Alternativa mínima:
buzón dedicado atendido por moderadores (sin formulario) hasta que exista el backend.

### 3.4 Datos (tablas nuevas, RLS forzada, sin policies — patrón `username_reservation_*`)

- `copyright_claims`: id, referencia, estado, datos del reclamante (nombre, organización, relación con la obra, correo
  verificado), obra (descripción, enlace/prueba), `post_id` (**sin FK**, como los reportes, para sobrevivir al borrado),
  URL enviada, declaraciones aceptadas (texto + versión), firma, `submitted_by_user_id` opcional, asignado, decisión,
  decidido por/cuándo.
- `copyright_claim_events`: append-only (cada cambio de estado, mensaje y decisión; actor, hora).
- `copyright_claim_evidence`: ruta **privada** en R2 (prefijo/bucket separado, nunca público), SHA-256, tamaño, tipo; acceso
  solo por URL firmada de corta vida para moderadores `aal2`.
- `copyright_removals`: reclamación, publicación, autor, resultado (`first`, `repeat`, `sanction`), tipo de plantilla,
  `notified_at`.
- Copia congelada del material reclamado (texto y referencia al media) al abrir el expediente: borrar la publicación no
  destruye la evidencia. `copyright_counter_notices` **solo si** la revisión legal lo exige (§3.6).

### 3.5 Integración con lo existente (a resolver en la fase de implementación)

- **Retirada:** reutilizar el estado de publicación `removed_pending_purge` y el ciclo de purga multimedia ya existentes
  (`community_media_purge_lifecycle`), mediante una RPC nueva `copyright_claim_decide` que **no** pase por la cola de reportes.
  Hay que verificar en detalle qué primitivas de `community_moderation_case_decide` se pueden compartir sin abrir un caso.
- **Sanciones:** `community_strike_apply` exige contexto de caso de moderación (`context_check`). Una sanción por copyright
  necesitaría un origen nuevo en strikes o aplicarse por otro mecanismo: **cambia el esquema de strikes → decisión previa**.
  La primera infracción confirmada no usa strike, así que el MVP puede salir sin tocarlo.
- **Contador de reincidencia:** «primera» vs «reincidencia» se calcula de `copyright_removals` confirmadas del autor;
  lo confirma el moderador antes de decidir (la plantilla recibe el tipo, no lo deduce).
- **Auditoría:** `moderation_audit_log` (vista restringida) con acciones nuevas `copyright_*`; los eventos detallados viven en la tabla propia.
- **Correo:** hace falta un proveedor transaccional (el SMTP de Supabase Auth es solo para autenticación). Decisión de
  infraestructura: proveedor, dominio remitente, plantillas, rebotes. Mientras tanto, la notificación puede mostrarse
  en la cuenta del usuario sin correo.

### 3.6 Qué necesita decisión legal / esquema / infraestructura

| Elemento                                                         | Decisión legal | Esquema | Infraestructura |
| ---------------------------------------------------------------- | :------------: | :-----: | :-------------: |
| Texto exacto del formulario y declaraciones del reclamante       |       ✔        |         |                 |
| Si hay contranotificación obligatoria, plazos y restauración     |       ✔        |         |                 |
| Retirada previa a la verificación (¿ocultar mientras se revisa?) |       ✔        |         |                 |
| Conservación de evidencias y datos personales del reclamante     |       ✔        |         |                 |
| Tablas del expediente, eventos, evidencias, retiradas            |                |    ✔    |                 |
| Origen de strike «copyright» (para reincidencias sancionables)   |       ✔        |    ✔    |                 |
| Canal público + anti-abuso + adjuntos privados                   |                |         |        ✔        |
| Proveedor de correo transaccional                                |                |         |        ✔        |
| Responsable operativo y plazos de atención                       |       ✔        |         |        ✔        |

## 4. Plantillas de notificación (implementadas, deterministas)

`src/lib/copyright-notices.ts` (`renderCopyrightNotice`) + `copyright-notices.test.ts` (31 tests). Es un módulo **puro**: no
decide, no envía y no está conectado a ningún backend. Recibe solo campos **confirmados del expediente** y lanza
`CopyrightNoticeInputError` si falta o es inválido alguno (nunca rellena ni inventa): referencia `CPY-…`, fecha de la decisión
(UTC, AAAA-MM-DD), obra identificada por el moderador, y —solo con sanción— la medida decidida. Sin saltos de línea ni
controles (inyección de cabeceras de correo), longitudes acotadas, sin marcadores sin resolver.

| Plantilla (`kind`)      | Contenido                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `first_removal`         | retirada confirmada + **advertencia educativa, sin sanción** + la recomendación literal aprobada |
| `repeat_removal`        | retirada + «ya habías recibido una retirada confirmada» + **sin sanción adicional**              |
| `removal_with_sanction` | retirada + la medida **decidida por un moderador** tal como consta en el expediente              |
| `claim_dismissed`       | reclamación revisada y **no retirada**, sin acciones ni medidas                                  |

Recomendación de la primera retirada (literal, es): «Por favor, evita volver a utilizar o publicar el contenido por el que
recibiste esta reclamación, salvo que tengas la autorización correspondiente o exista una base legal que permita su uso».
Versiones en/de equivalentes (pendientes de revisión jurídica de redacción). La mención a la contranotificación se añade
**solo si** el operador aporta `counterNoticeInstructions` (no se promete un canal inexistente; nunca en `claim_dismissed`).
No se menciona al reclamante, ni leyes, ni IA.

## 4.1 Corrección de `PrivacyPage`

`src/pages/PrivacyPage.tsx` afirmaba que el sitio no ofrece cuentas ni inicio de sesión (§2 y §5) y que no usa el
almacenamiento local. Corregido solo con hechos verificables en el código: cuentas opcionales (correo confirmado y contraseña
para iniciar sesión), username y nombre visible públicos, publicaciones y likes, reportes vinculados a la cuenta y no
visibles para otros usuarios, registro de acciones de moderación, almacenamiento local para el idioma y la sesión, Supabase
(base de datos y autenticación) y Cloudflare R2 (medios) como terceros. **No** se inventó nada pendiente: el texto dice que
conservación, responsable y ejercicio de derechos «are being defined» y que el borrado de cuenta aún no existe.

**Requiere revisión jurídica (marcado en el código con `LEGAL-REVIEW`):** responsable del tratamiento, bases legales, plazos
de conservación, derechos y cómo ejercerlos, transferencias internacionales, y si procede mencionar a Vercel/Google Fonts de
forma distinta. Sigue sin corregirse (fuera de alcance): la página está solo en inglés.

## 5. Borradores de políticas (sujetos a revisión legal; no sustituyen asesoría ni afirman cumplimiento de ninguna ley)

Los textos usan marcadores `[ ]` donde falta un dato real (responsable, correo, plazos, jurisdicción).

### 5.1 Terms — reemplazo propuesto de §7 «Content you share on the Community»

> You may upload photos, videos and text that you created yourself, or that you have permission to share (for example,
> because the rights holder allowed it or because the law allows that use). You must not upload content that infringes
> someone else's copyright, trademark, privacy or other rights; sexual content involving minors; content that harasses,
> discriminates against or threatens people; or content that impersonates UpMinaa or this Site's team.
>
> You keep the rights you already have in your content. By posting, you give [operator] a non-exclusive licence to host,
> display and distribute it on the Site for as long as it is published, and to make the technical copies needed to run the
> Site. [Scope and duration of the licence: to be confirmed.]
>
> Posts that may be AI-generated, edited or taken from someone else must be identified as such [rule to be confirmed].
>
> Anyone with an account can report a post from the post itself. The moderation team may hide a post while it is reviewed,
> and may remove it, restrict an account or take other measures described in the Community rules.

### 5.2 Terms — nueva sección «Reporting and copyright claims»

> **Community reports.** A report is an alert from a user; it is not a legal claim. Reports are reviewed by the
> moderation team, and the reporter's identity is not shown to other users.
>
> **Copyright claims.** If you are a rights holder, or authorised to act for one, and believe a post infringes your rights,
> contact [copyright contact]. Include: who you are and your relationship to the work; a description of the work; where the
> material is on the Site; a statement that you are the rights holder or are authorised to act for them [wording to be
> confirmed under the applicable law]; and how to reach you. [Formal claim channel, response time and counter-notice
> procedure: to be defined.]
>
> **What happens to removed content.** Removed or hidden content stops being public. We may keep a restricted copy and the
> related records for [period] to handle claims, appeals and legal obligations. The author is told that the content was
> removed and why, and may [reply or appeal — procedure to be defined]. Content may be restored if the claim is withdrawn or
> rejected.
>
> Knowingly false claims may lead to [consequences to be defined].

### 5.3 Community rules (página nueva o sección, texto corto para mostrar junto al editor)

> - Post only what is yours or what you have permission to share.
> - Be kind: no harassment, discrimination, threats or sexual content.
> - Stay on topic: this is a community about UpMinaa. Do not pretend to be her or the team.
> - Say when something was made with AI.
> - Found a problem? Use «Report» on the post. Rights holders: see «Reporting and copyright claims» in the Terms.

### 5.4 Privacy — propuesta ampliada (la corrección factual mínima ya está en `PrivacyPage`, §4.1)

> **Accounts and profiles.** If you create an account we process your email address (to sign in and verify it), your
> username, and the profile information you choose to add. Your username and display name are public.
>
> **Content you post.** Posts, photos and videos are public. We also store technical data needed to run the service (for
> example upload records and moderation history).
>
> **Reports and claims.** When you report a post we store your report and its explanation, linked to your account, for
> moderation. Your identity is visible only to authorised moderators. Rights holders' claims and supporting documents are
> stored with restricted access and kept for [period].
>
> **Service providers.** [Supabase (database and authentication), Cloudflare R2 (media), Vercel (hosting) — region and
> transfer details to be confirmed.]
>
> **Your choices.** [How to access, correct or delete your data and account: to be defined; account deletion is not
> available yet.]
>
> **Controller and contact.** [Responsible person/entity and contact: to be confirmed.]

Pendientes para estos textos: responsable del tratamiento, correo de contacto específico, jurisdicción y régimen aplicable,
plazos de conservación, traducción a es/de tras la revisión legal, y la corrección de §5 de Privacy aunque el resto espere.

## 6. Riesgos, bloqueos y qué falta para probarlo en DEV (después de R7)

- Ocultamiento de `off_topic`/`ai_generated`: decisión de política pendiente (§2.1).
- Todo lo que escribe en DEV espera a R7 (11 de octubre) y a tu autorización; no se hizo ninguna prueba remota.
- Copyright sigue entrando a moderación como «Otro motivo» (interino) hasta que exista el circuito de §3.
- Riesgo preexistente: el umbral de 3 reportes permite que un grupo coordinado oculte publicaciones ajenas; sin cambios.
- Orden de despliegue: migración antes que backend/UI (§1).
- Las traducciones en/de de las plantillas y de los textos legales necesitan revisión jurídica.

**Para probar en DEV tras R7 (todo con tu autorización expresa):** (1) `db push --dry-run`: debe listar solo
`20261116120000` (si sigue pendiente) y `20261106120000`; (2) `db push`; (3) SELECT: CHECK con 8 motivos, ACL del core y de
`community_moderation_cases_read`; (4) Preview del backend/UI + alias solo con tu OK; (5) con cuenta de prueba tuya: reportar
una publicación de otra cuenta de prueba con cada motivo nuevo, comprobar la cola de moderación y el filtro, y que 2 reportes
no ocultan y el 3.º sí; (6) rollback listo: copiar el script a una migración nueva solo si fuera necesario.
