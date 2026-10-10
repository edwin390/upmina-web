# 9K-R5-H · Contador de pendientes y resiliencia multimedia (LOCAL · migración NO aplicada · NO desplegado)

## 1. Comportamiento implementado

### Contador de casos pendientes

- Se muestra una sola vez, bajo el título «Moderación» (no se duplica en la navegación; el panel
  administrativo general exige otro rol y no se toca).
- Es un agregado del servidor (`GET /api/admin/moderation-cases?summary=pending` → `{ "pending": N }`),
  independiente de la página mostrada y de los filtros: no se deriva de los primeros 20 resultados.
- Estados distinguidos: **cargando** («Contando casos pendientes…», solo si aún no hay valor), **cero**
  («Sin casos pendientes»), **N** («1 caso pendiente» / «N casos pendientes») y **error** (alerta +
  «Reintentar»; nunca se muestra un cero ni un valor viejo cuando falla). Al actualizar se conserva el
  valor anterior hasta que llega el nuevo.
- Se consulta al entrar, con «Actualizar contexto» y tras una decisión (éxito o conflicto). No hay polling,
  ni consulta al paginar o filtrar.
- Misma autenticación que la cola: JWT + capacidad `moderation` + MFA reciente. La página no lo pide sin
  capacidad o sin MFA reciente; el servidor rechaza con 401/403 antes de tocar la base de datos.

### Multimedia en el detalle del caso (`ModerationMedia`)

- **Imagen:** contenedor con la proporción real (sin saltos de layout) y estado «Cargando contenido…»;
  `alt` accesible y numerado («Imagen de la publicación (1 de 2)»). Si falla: placeholder (`role=group`
  con `role=alert`), sin imagen rota, con «Reintentar carga» (vuelve a pedir el archivo con un elemento
  nuevo) y la pista de actualizar el caso si el acceso caducó.
- **Vídeo:** conserva `controls` y `preload="metadata"`. El contrato del caso NO trae poster, así que
  hasta los metadatos se muestra un fallback visual neutro («Vídeo sin vista previa»); luego, el propio
  vídeo. Distingue carga / disponible / error, con el mismo reintento.
- Un medio roto no bloquea nada más: texto, otros medios, reportes, auditoría y acciones siguen activos.
- Privacidad: los mensajes nunca incluyen URL ni nombre de archivo; no se escribe en consola; no hay
  enlaces al almacenamiento; la política de acceso a archivos no cambia (se usa la URL que ya entrega el
  servidor). No se modifican los reproductores de Community, Cosplay ni Twitch.
- El estado de cada medio se reinicia al cambiar de caso (clave por ciclo + medio).

## 2. Definición exacta de «caso pendiente»

Un **ciclo de moderación en `status = 'pending'` que es el ciclo vigente de su caso**
(`cycle_number = case.current_cycle`). Es exactamente el predicado de la cola «Activos»
(`community_moderation_cases_read`, scope `active`). Consecuencias:

- Se cuentan casos únicos: 3 reportes (o 50) sobre la misma publicación son 1 caso.
- Un caso con ciclos anteriores cerrados cuenta una sola vez (por su ciclo vigente).
- Tras una decisión el ciclo pasa a `closed` y deja de contar. El Historial (ciclos cerrados) no cuenta.

## 3. Archivos

**Nuevos:** `supabase/migrations/20261031120000_moderation_pending_count.sql`,
`src/pages/admin/ModerationPendingCounter.tsx`, `src/pages/admin/ModerationMedia.tsx`,
`src/lib/moderation-pending-count-sql.test.ts`, este documento.
**Modificados:** `src/lib/moderation-case-handlers.ts` (rama `summary=pending`),
`src/lib/moderation-client.ts` (`fetchModerationPendingCount`), `src/pages/admin/AdminModerationPage.tsx`,
`src/i18n/locales/{es,en,de}/moderation.json` (`pending.*`, `media.*`), tests:
`AdminModerationPage.test.tsx`, `moderation-handlers.test.ts`, `moderation-client.cases.test.ts`.
Los dobles de fetch del test de la página ahora responden también a `summary=pending`.

## 4. Migración (local, NO aplicada)

`20261031120000_moderation_pending_count.sql`: una función nueva `community_moderation_pending_count(uuid)`
(`security definer`, `search_path` fijo, mismo control de rol que la lectura de la cola, devuelve un
entero, ACL solo `service_role`). Sin tablas, sin cambios en funciones existentes. Usa el índice
`community_moderation_cycles_status_idx (status, case_id, cycle_number)`.
Sin la migración, el contador mostraría el error con reintento (RPC inexistente → 500) y el resto del
panel funciona igual. La parte multimedia no necesita migración.

## 5. Resultados de pruebas

Ver el informe de entrega (cifras exactas de la ejecución final).

## 6. Riesgos pendientes

- Sin poster de vídeo en el contrato: el fallback es genérico. Un poster real exigiría generar y servir
  miniaturas (fuera de alcance: toca R2/`media_assets`).
- «Reintentar» reutiliza la misma URL: si el acceso caducó, hay que actualizar el caso (se indica al usuario).
- El contador es una instantánea: no refleja casos que lleguen mientras el panel está abierto hasta la
  siguiente actualización (decisión deliberada: sin polling).
- El resto del panel sigue en español; solo los textos nuevos están traducidos.
- Backend y frontend siguen sin desplegarse en DEV (también R5-D/E/F/G).

## 7. Validación manual en DEV (cuando se autorice)

1. Aplicar `20261029`, `20261030` y `20261031` (dry-run previo) y desplegar el árbol completo.
2. Comparar el contador con el número de casos de «Activos» recorriendo todas las páginas.
3. Resolver un caso: el contador baja en 1 y la lista no parpadea.
4. Caso con imagen y con vídeo: ver el estado de carga y el contenido. Para simular un fallo, bloquear
   el dominio de almacenamiento en las herramientas del navegador: aparece el placeholder con
   «Reintentar carga»; al desbloquear y reintentar, el medio carga.
5. Comprobar que ni el mensaje ni la consola muestran la URL.
