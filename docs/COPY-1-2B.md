# COPY-1 · Fase 2B — retirada por copyright, apelación, restauración y eliminación manual

Estado: implementación LOCAL. Migración `20261110120000_copyright_removal_appeals.sql` (+ rollback en `supabase/rollbacks/`) **sin aplicar** en ningún entorno.
Requiere la 2A (`20261107120000`) y la corrección `20261108120000`.

## Flujo

1. **Retirar** (pestaña Copyright, solo reclamaciones «En revisión»): moderador con `moderation` + MFA reciente. El motivo lo escribe la persona y se envía al autor.
   Segunda confirmación con la publicación (texto, versión, medios), la referencia y el motivo. La RPC exige la versión de la reclamación y la **versión de la
   publicación que se vio**. Retirar = `community_posts.status = 'hidden'` (no se toca ningún archivo, no se usa `removed_pending_purge`).
2. **Aviso inicial** (correo en inglés, adaptador de Resend existente) con referencia, motivo y enlace `…/copyright/appeal#t=<token>` (token de 256 bits; solo se guarda su SHA-256).
   El plazo de apelación empieza al **confirmarse el envío**. Si falla: queda registrado (clase de error, intentos, historial y auditoría), el plazo no empieza y la
   eliminación definitiva está bloqueada; «Reintentar el aviso» reemite el token (el anterior deja de valer).
3. **Apelación** (`/copyright/appeal`, ES/EN/DE): sesión de la cuenta autora original + token. Solo texto y enlaces, declaración de veracidad. Una por reclamación
   (`unique`), operación atómica con la reclamación bloqueada. Una apelación pendiente bloquea siempre la eliminación.
4. **Resolver**: aceptar (justificación obligatoria) restaura la publicación **solo si sigue como la dejó la retirada** (oculta, mismo autor, misma versión); si no,
   `restore_unsafe` y la apelación sigue pendiente. Rechazar la mantiene oculta y el caso sigue activo. El aviso de resolución, si falla, queda pendiente de reenvío sin repetir la acción.
5. **Eliminación definitiva manual**: botón «Eliminar definitivamente» solo con plazo vencido + aviso inicial enviado + sin apelación pendiente + sin aviso de resolución pendiente, y
   confirmación explícita (referencia + nota). La RPC repite todas las condiciones bajo lock. Reutiliza la regla de la purga existente: solo los archivos usados
   exclusivamente por esa publicación pasan a `deleting` (el GC existente de R2 los recoge); los compartidos se conservan. **No hay cron ni eliminación por vencimiento.**
6. Historial: `restored` y `purged` pasan a «Cerradas»; `removed` y `appeal_pending` permanecen en «Abiertas». Todo queda en `copyright_claim_events` y en `moderation_audit_log`.

## Plazo de apelación

`appealWindowMinutes()` (servidor): 1 h **solo** si `VERCEL_ENV` es `preview` o `development` **y** `COPYRIGHT_TEST_WINDOW_MINUTES` vale exactamente `60`; en cualquier otro caso 24 h.
Producción ignora la variable. El cliente no puede elegir el plazo y la RPC solo acepta 60 o 1440.
**Para que DEV use 1 h, la persona operadora debe definir `COPYRIGHT_TEST_WINDOW_MINUTES=60` en el proyecto `upmina-web-testing` (Preview).** Sin ella, DEV usa 24 h.

## Límites y riesgos conocidos

- Una decisión ordinaria de Community (`content_actioned`) sobre una publicación ya oculta por copyright seguiría su propio flujo de 72 h; 2B no modifica el circuito ordinario.
- La retirada exige que el caso esté «En revisión» y la publicación «publicada»; el reclamante no puede «retirar» una reclamación ya retirada (solo anotaciones).
- La eliminación de archivos en R2 es asíncrona (GC existente): el detalle muestra cuántos archivos marcados siguen pendientes.
- Los textos de los correos y de la declaración de la apelación (v1) están pendientes de revisión jurídica.
