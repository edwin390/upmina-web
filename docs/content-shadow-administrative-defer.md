# Shadow: adquisición, intentos efectivos y aplazamiento administrativo

Ampliación local posterior a F4-B, migración
`20261124120000_community_shadow_administrative_defer.sql`. No implementa cuota,
cooldown global, proveedor, scheduler ni cambios en Community.

## Contrato y compatibilidad

- `community_shadow_acquire(p_limit integer DEFAULT 2, p_lease_seconds integer DEFAULT 60)`:
  devuelve `SETOF community_shadow_jobs`. Reclama mediante `FOR UPDATE SKIP LOCKED`,
  entrega token/lease y **no** incrementa `attempts`. Límites existentes: 1–10 trabajos,
  lease de 10–300 segundos. El ejecutor F4-B conserva su límite de dos trabajos.
- `community_shadow_attempt_start(p_job_id uuid, p_claim_token uuid) RETURNS text`:
  autoriza procesamiento una sola vez por token vigente; incrementa `attempts`.
  Repetir con ese token devuelve `already_started` sin incrementarlo otra vez.
  Otros resultados: `started`, `attempts_exhausted`, `not_found`, `stale_claim`,
  `obsolete`, `busy`.
- `community_shadow_defer(p_job_id uuid, p_claim_token uuid, p_resume_at timestamptz,
p_reason text) RETURNS text`: programa el próximo acceso y libera token/lease.
  Razones permitidas: `quota_exhausted`, `cooldown_active`. Resultados: `deferred`,
  `expired`, `attempts_exhausted`, `not_found`, `stale_claim`, `obsolete`, `busy`.
- `community_shadow_claim(integer DEFAULT 2, integer DEFAULT 60)` mantiene su
  identidad y comportamiento F4-B: adquisición **e inicio** atómicos, incrementando
  el contador. No hay una antigua ruta de finalización sin contar un intento.
- `community_shadow_finish(uuid, uuid, text, jsonb DEFAULT '[]', text DEFAULT NULL,
integer DEFAULT NULL)` conserva firma, validaciones y reintentos del proveedor;
  añade `attempt_not_started` para un token adquirido sin inicio autorizado.

No se cambia el estado enumerado. La espera administrativa utiliza `retry_wait`
y `administrative_defer_reason`; el reintento de proveedor conserva su contrato
de 10/20–3.600 segundos. El protocolo nuevo todavía no está conectado al ejecutor.

## Semántica y prueba de monotonía

`attempts` cuenta autorizaciones efectivas de procesamiento de un trabajo, no
adquisiciones, solicitudes individuales ni entregas confirmadas al proveedor.
Un trabajo puede tener texto y varias imágenes: la cuota futura deberá reservar
cada solicitud por separado. Un fallo tras autorizar el inicio consume ese intento.

Las únicas escrituras nuevas del contador son `attempts + 1` en inicio y en claim
legacy, bajo bloqueo de fila y con límite previo `< 3`. Adquirir, aplazar, finalizar
y mantener no lo disminuyen. Ninguna RPC acepta un contador del cliente. El marcador
privado `attempt_claim_token` vincula el inicio al token vigente y hace idempotente
su repetición. Un trigger lo invalida cuando cambia el token o termina `processing`,
incluidas las transiciones de mantenimiento/cancelación existentes.

Aplazar antes de inicio consume cero intentos. Aplazar después de inicio conserva
íntegramente los intentos ya consumidos; no devuelve unidades. Con tres intentos,
aplazar termina como `failed / attempts_exhausted`. Un lease perdido después de
inicio tampoco devuelve intentos. Los claims antiguos en curso se migran marcando
su autorización existente sin alterar sus contadores.

## Fechas y caducidad

Se acepta un instante finito estrictamente futuro, hasta 25 horas desde el reloj
de PostgreSQL. `timestamptz` representa el instante; usar ISO 8601 con `Z` desde
servidor. No se aceptan fechas pasadas, infinitas, nulas o fuera del límite.
El tipo PostgreSQL rechaza fechas malformadas antes de entrar a la función.

Se persiste exactamente `next_attempt_at`. Ninguna adquisición nueva ni legacy
puede adelantarse. Si el plazo alcanza o supera `snapshot_expires_at` o
`retain_until`, el trabajo pasa a `expired`, se borra el texto y se libera el lease.
Nunca se extienden las 24 horas de snapshot ni la retención. Por eso una próxima
ventana UTC puede ser válida como fecha y aun así requerir expiración segura.
Los aplazamientos repetidos siguen limitados por la caducidad original.

## Aislamiento y concurrencia

Inicio, aplazamiento y finalización exigen token/lease válidos, snapshot vigente,
fingerprint y versión actuales, y objetivo existente. Bloquean primero la publicación
y luego el trabajo con `NOWAIT`; la contención devuelve `busy`. Las adquisiciones
usan `SKIP LOCKED`. No se mantienen transacciones durante I/O externo.

Las RPC públicas son `SECURITY DEFINER`, owner `postgres`, `search_path =
pg_catalog, public`, con `EXECUTE` exclusivamente para `service_role`. Helpers
privados sin acceso de clientes. No se conceden permisos de tabla o columna;
RLS forzada permanece activa. No se añade ruta HTTP de aplazamiento.

El token impide persistencia tardía, no cancela I/O ya iniciado ni garantiza entrega
exactamente una vez. No es un límite global de ejecutores. Una identidad
`service_role` comprometida sigue siendo un límite de confianza del sistema.

## Protocolo futuro y límites de alcance

El futuro consumidor adquirirá, consultará la autoridad persistente de presupuesto
y aplazará antes de autorizar procesamiento si no puede continuar. Esta RPC valida
el plazo y la posesión, **no acredita** que exista cuota agotada o un cooldown real.
El origen autorizado de ese plazo y las reservas por componente quedan pendientes
de F4-C1. No hay tablas de presupuesto ni cliente OpenAI en esta corrección.

F4-B sigue usando claim legacy y transporte fake sin cambios de ejecución. No debe
reemplazarse claim por acquire sin incorporar explícitamente el paso de inicio.
No hay activación remota, variables nuevas ni scheduler.

## Verificación local

Ejecutar `UPMINA_SHADOW_DEFER_TESTS=1 node scripts/test-content-shadow-postgres.mjs`
(en PowerShell: `$env:UPMINA_SHADOW_DEFER_TESTS='1'` antes del comando).
Usa PostgreSQL 18.2 instalado, clúster exclusivo loopback, base de UUID y fixtures
sintéticas. No usa credenciales ni bases remotas. El harness elimina su base y
clúster incluso ante error y conserva un informe temporal fuera del repositorio.

Las pruebas incluyen rollback de migración e in-flight legacy, fechas, contador,
tokens, expiración, cancelación, eliminación, privilegios y Community intacta.
Dos conexiones independientes mantienen transacciones solapadas verificadas en
`pg_stat_activity`: una adquisición omite la fila bloqueada; inicio/aplazamiento
en contención devuelve `busy`, y al liberar la fila no se duplica el incremento.
La compatibilidad del ejecutor fake se verifica con las pruebas PostgreSQL F4-B
reutilizadas sobre la nueva migración. Los avances largos del reloj se representan
ajustando exclusivamente fixtures privadas del clúster de prueba; no equivalen a
esperar horas reales.
