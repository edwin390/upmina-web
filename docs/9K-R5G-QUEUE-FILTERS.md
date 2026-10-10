# 9K-R5-G · Filtros, paginación y continuidad de la cola de moderación (LOCAL · migración NO aplicada · NO desplegado)

## Qué cambia

1. **Filtros reales en backend** (Activos e Historial): motivo del reporte, solo ocultas preventivamente
   (`hidden_pending_review`), autor (prefijo del username) y rango de fechas (sobre la actividad del
   ciclo; «hasta» inclusivo). Se aplican ANTES de paginar y se combinan con AND.
2. **Paginación**: siguiente, anterior y volver al inicio. Sigue siendo por cursor `(actividad, id)`;
   no hay OFFSET. «Anterior» retrocede por el rastro de cursores ya usados (sin pedir nada nuevo al
   servidor que no sea una página con un cursor válido anterior).
3. **Continuidad**: recargar (filtros, página, «Actualizar contexto», tras una decisión) ya no sustituye
   la cola por «Cargando casos…»; se mantienen los resultados con un indicador «Actualizando…».

## Contrato

`GET /api/admin/moderation-cases?scope=&cursor=&reason=&hiddenOnly=1&author=&from=YYYY-MM-DD&to=YYYY-MM-DD`

- `reason` ∈ spam|harassment|hate_speech|sexual_content|other · `hiddenOnly` solo `1` ·
  `author` `^[a-z0-9_]{2,20}$` (se normaliza a minúsculas) · fechas reales `YYYY-MM-DD` (UTC), `from ≤ to`.
- Cada filtro debe ser una sola cadena (listas → 400). Con `cycleId` (detalle) los filtros no se admiten.
- Cualquier valor inválido → 400 genérico antes de llegar a la base de datos. Autenticación,
  capacidad `moderation` y MFA reciente no cambian.
- Solo viajan los filtros activos: sin filtros la llamada al RPC es idéntica a la anterior.

## SQL (migración local `20261030120000_moderation_queue_filters.sql`, NO aplicada)

- Sustituye `community_moderation_cases_read` (drop + create) por la misma función con 5 parámetros
  nuevos con `DEFAULT` (`p_reason`, `p_hidden_only`, `p_author`, `p_from`, `p_to`). Mismo owner,
  `security definer`, `search_path` fijo; ACL: solo `service_role`.
- Revalida los parámetros (`invalid_argument`). El autor se compara con `left(username, n) = p_author`
  (no `LIKE`: el `_` de los usernames sería un comodín). Parametrizado; sin SQL dinámico.
- Las llamadas antiguas (5 argumentos) siguen funcionando.

## Compatibilidad

- Backend nuevo + SQL antiguo: sin filtros todo funciona; con filtros el RPC falla (parámetros
  desconocidos) y la UI muestra el error de carga. Orden recomendado: migración y backend juntos.
- SQL nuevo + backend antiguo: sin cambios de comportamiento.
- Strikes (R5-D/E), auditoría (R5-F), MFA reciente, Activos/Historial e i18n no se tocan. Los textos
  nuevos están en `moderation.queue` (es/en/de); el resto del panel sigue en español.

## Comportamiento de la interfaz

- Motivo, ocultas y fechas se aplican al instante; el autor con debounce de 400 ms y solo con 2+
  caracteres válidos (1 carácter muestra una ayuda y no consulta). Rango invertido: aviso y sin consulta.
- Cambiar filtros o vista reinicia cursor y rastro. Cursor inválido/caducado (400): aviso claro y
  «Volver al inicio».
- Respuestas antiguas se descartan (contador de petición + abort). Si falla una actualización de la
  MISMA vista se conservan los resultados con aviso y reintento; si falla tras cambiar de consulta se
  muestra el error (nunca resultados de otra consulta como actuales).
- El caso expandido se conserva mientras siga en la nueva página; si desaparece, el panel se cierra.
- La vuelta desde MFA conserva filtros y rastro.

## Qué requiere migración o despliegue

Migración `20261030…` (no aplicada) + backend (`moderation-case-handlers.ts`) + frontend. Hay que
desplegar el árbol completo (DEV sigue en `6a2e441` + R2).

## Validación en DEV (cuando se autorice)

1. Aplicar la migración (dry-run: solo `20261030120000…`; antes, la `20261029…` si no se aplicó) y desplegar.
2. En Activos: filtrar por motivo, ocultas, autor y fechas, solos y combinados; limpiar filtros.
3. Con más de 20 casos (o `limit` reducido en un entorno de prueba): siguiente → anterior → inicio.
4. «Actualizar contexto» y una decisión: la lista no parpadea a «Cargando casos…».
