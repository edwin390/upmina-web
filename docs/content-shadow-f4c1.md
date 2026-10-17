# F4-C1 — presupuesto persistente y cooldown global (solo transporte fake)

## Autoridad SQL

La migración `20261125120000_community_shadow_budget.sql` se aplica después de la
ampliación administrativa `20261124120000`. No cambia migraciones anteriores.
El scope es fijo: `dev:omni-moderation-latest`. No se recibe entorno, modelo o límite
desde HTTP ni se concede acceso directo a tablas.

- `community_shadow_budget_control`: fila única, cooldown global y suspensión de seguridad.
- `community_shadow_budget_days`: contador persistente por fecha UTC, CHECK 0–100.
- `community_shadow_budget_reservations`: N unidades por trabajo/token, UNIQUE que
  evita doble cargo al repetir una reserva tras un resultado de commit desconocido.
  FK al trabajo con CASCADE; borrar el ticket **no** devuelve unidades al contador.

RPC `service_role` exclusivamente, `SECURITY DEFINER`, propietario `postgres`,
`search_path = pg_catalog, public`. RLS habilitada y forzada en las tres tablas;
sin permisos directos para PUBLIC, anon, authenticated ni service_role.

## Reserva y reloj

`community_shadow_budget_reserve(uuid, uuid, integer) RETURNS jsonb` valida el
snapshot vigente, token, lease y ausencia de inicio previo. Calcula N a partir
del texto no vacío y las imágenes del snapshot, y exige que coincida con el N
derivado por el ejecutor: 1–11 componentes. Vídeo y audio no consumen unidades.

Bloquea publicación, trabajo y fila de control, en ese orden. Bajo ese último
bloqueo obtiene la fecha UTC del reloj PostgreSQL y reserva todas las unidades
o ninguna. Una reserva no es una entrega confirmada al proveedor y no se reembolsa
por timeout, cancelación, pérdida del lease, reinicio o fallo de lectura.

La unidad 101 se rechaza con `quota_exhausted` y el siguiente inicio de día UTC.
No se resetean contadores: cada fecha tiene una fila independiente. Una reserva
confirmada antes de medianoche pertenece a ese día, aunque el procesamiento cruce
medianoche. La garantía se refiere a **reservas**, no al día de entrega del mensaje.

## Cooldown

`community_shadow_budget_cooldown(bigint) RETURNS jsonb` registra segundos positivos
de espera en la misma fila de control que serializa reservas. Usa el máximo entre
el plazo vigente y el nuevo, calculado después de obtener el bloqueo. Ninguna RPC
acorta el plazo ni cambia el límite. Devuelve el plazo efectivo.

Retry-After se interpreta como segundos o fecha HTTP mediante el parser existente.
Ante un rate limit sin plazo válido se usa una espera conservadora de 60 segundos.
Una espera válida más larga se conserva; no se reduce al límite de reintento de
3.600 segundos del trabajo. Más de siete días activa una suspensión persistente
sin reanudación automática, en vez de acortar la instrucción. Su recuperación
requiere intervención autorizada posterior; no se añade una RPC de desbloqueo.

`community_shadow_budget_check(uuid, uuid, uuid)` revalida objetivo, token, lease,
inicio y ticket antes de cada envío. Consulta el cooldown compartido bajo el mismo
bloqueo. Una reserva anterior no puede revocarse retroactivamente. Tampoco puede
cancelarse un envío ya autorizado/en curso justo antes de un cooldown concurrente.
No se promete un límite de velocidad del proveedor ni entrega exactamente una vez.

## Ejecutor y configuración

El modo por defecto sigue siendo F4-B simulado, con presupuesto fake y sin reservas
SQL. Solo el valor exacto `CONTENT_SHADOW_BUDGET_MODE=persistent_dev` selecciona
el protocolo nuevo en el endpoint existente. No se han creado variables remotas.
El transporte sigue siendo exclusivamente `FakeModerationTransport`; no hay
cliente OpenAI ni API key, incluso con el presupuesto persistente seleccionado.

Secuencia: acquire → validar snapshot/componentes → reservar N → start → comprobar
cooldown por componente → evaluar secuencialmente → finish. Máximo dos trabajos
por lote y concurrencia uno dentro del lote. El presupuesto es global; ese límite
de concurrencia no es un mutex global entre instancias.

Una denegación usa únicamente razón y plazo devueltos por SQL para llamar a defer.
Si el plazo supera la caducidad, utiliza esa caducidad para la transición `expired`;
no extiende retención. No inicia ni consume intentos por una denegación administrativa.
Un fallo SQL impide enviar componentes; una respuesta ambigua no devuelve reservas.

Si aparece cooldown tras procesar algún componente, se detienen los siguientes y se
finaliza con cobertura parcial o fallo, sin afirmar evaluación completa y sin reintento
automático de ese trabajo por cooldown. No hay infraestructura de recuperación por
componente: los reintentos técnicos ordinarios pueden repetir evaluaciones anteriores
y reservar N de nuevo. Es una política conservadora que consume cuota sin devolverla.
Los trabajos sin componentes evaluables solo finalizan cobertura unsupported/not_applicable
mediante autorización de procesamiento; no reservan ni envían solicitudes de proveedor.

JWT, developer_panel, MFA reciente, flag `CONTENT_SHADOW_RUN_ENABLED=true`, validación
cerrada de método/body, aislamiento DEV y `private, no-store` permanecen activos.
HTTP solo acepta el límite de lote y devuelve contadores; no recibe N, fechas,
razones, scope o límites, ni devuelve contenido, scores o tokens.

## Pruebas y operación local

- Vitest focalizado: `content-shadow-budget.test.ts` y `content-shadow-executor.test.ts`.
- PostgreSQL: `$env:UPMINA_SHADOW_BUDGET_TESTS='1'` seguido de
  `node scripts/test-content-shadow-postgres.mjs`.

El harness crea y elimina su propio clúster PostgreSQL 18.2 loopback y una base de
UUID. Usa imágenes/transporte falsos y ninguna credencial remota. Las fixtures que
simulan cambio de día modifican únicamente esa base efímera; no cambian el reloj
del sistema ni afirman haber esperado hasta medianoche real. Las carreras se comprueban
con conexiones independientes, transacciones solapadas y espera de bloqueo observada.

No hay scheduler, activación remota ni cambios en Community, auditoría humana o GC.
Los tickets desaparecen con el borrado normal de sus trabajos; los contadores diarios
sin contenido personal se conservan. Las garantías presuponen reloj PostgreSQL fiable
y que el futuro transporte real permanezca sujeto obligatoriamente a esta autoridad.
