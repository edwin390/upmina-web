# 9K-R5-F · Auditoría visual de moderación y estado de strike (LOCAL · migración NO aplicada · NO desplegado)

## Qué cambia
1. **Auditoría legible e i18n (es/en/de).** El detalle de caso ya no pinta códigos crudos: cada evento
   muestra etiqueta, descripción breve, insignia de categoría, tipo de actor, fecha/hora en el idioma
   activo (`<time datetime>`) y transiciones de estado traducidas. Namespace nuevo `moderation`
   (`src/i18n/locales/{es,en,de}/moderation.json`, incluido en `messages.ts` y en el test de paridad).
2. **Strikes en la auditoría del caso (SQL).** Migración local
   `20261029120000_moderation_audit_strike_events.sql`: `community_moderation_cycle_read` incluye los
   eventos `strike_applied` / `strike_revoked` del MISMO caso y ciclo y un único dato extra:
   `strikeLevel` (1–3).
3. **Fallo de lectura del strike ≠ «sin sanción».** El backend marca `strikeUnavailable: true` cuando
   la RPC `community_strike_state_read` falla (error, excepción o forma inesperada); si la función no
   existe (BD sin strikes: `PGRST202`/`42883`) no hay bloque ni bandera, como antes. La UI muestra una
   sección «Sanción al autor» con alerta genérica y botón «Reintentar consulta», sin acciones de strike.

## Acciones reales (lista cerrada, `MODERATION_AUDIT_ACTIONS`)
| Acción | Actor | Categoría | Significado mostrado |
|---|---|---|---|
| `post_quarantined` | sistema | Automática | ocultada preventivamente al llegar al umbral de reportes |
| `post_purged` | sistema | Automática | eliminada definitivamente al terminar la retención |
| `content_actioned` | humano | Decisión | «Procede»: retirada y borrado definitivo a las 72 h |
| `case_rejected` | humano | Decisión | «No procede»: ciclo cerrado; si estaba oculta preventivamente, se republica |
| `post_restored` | humano | Restauración | publicación visible de nuevo |
| `post_hidden`, `report_status_changed` | humano | Moderación | flujo anterior de reportes (históricos) |
| `strike_applied` | humano | Sanción | sanción al autor (nivel indicado) |
| `strike_revoked` | humano | Sanción | revocación (rol desarrollo/administración); no restaura la publicación |

Un evento desconocido que llegue a la UI usa «Acción no reconocida» y nunca vuelca el código. Aun así
el parser mantiene la **lista cerrada**: una acción nueva del backend hace fallar la carga del caso
(fail-closed deliberado, test existente `moderation-case-parser-purged`), por lo que añadir una acción
exige actualizar contrato, parser y mensajes a la vez.

## Identidad del actor (Fase 2): limitación documentada
- El contrato solo entrega `actorKind` (`human` | `system`). La UI distingue «Sistema» de «Acción
  humana» y no muestra identidad ni rol.
- La única inferencia de rol que se muestra es la que impone la regla del sistema (revocar exige
  desarrollo/administración; aplicar admite moderación, desarrollo o administración) en la descripción
  del evento; no es un dato del actor.
- Mostrar quién actuó (o su rol) exigiría proyectar `actor_user_id`/rol en `community_moderation_cycle_read`
  (join con `admin_roles`), decidir qué roles pueden ver a qué actores y revisar privacidad. No se
  implementa; las pruebas fijan que la UI no renderiza ningún identificador aunque llegara en el objeto.

## Compatibilidad
- Backend nuevo + SQL antiguo: sin `strikeLevel` en la auditoría (el parser lo trata como `null`) y sin
  eventos de strike en la lista; el resto funciona.
- SQL nuevo + backend antiguo: el parser antiguo construye cada evento solo con sus claves conocidas
  (ignora `strikeLevel`) y su lista de acciones ya incluía `strike_*`, así que el caso carga y los
  eventos de strike aparecen sin nivel. Orden recomendado: migración y backend juntos.
- El panel se envuelve en `LocaleProvider` (el mismo de `/cosplay`, misma preferencia en
  `localStorage`); solo los textos nuevos están traducidos, el resto del panel sigue en español.

## Qué requiere migración o despliegue
- **Migración (NO aplicada):** `20261029120000_moderation_audit_strike_events.sql` (una sola función,
  `create or replace`; conserva owner y ACL; sin tablas ni permisos nuevos).
- **Backend (Vercel):** `moderation-case-handlers.ts`, `moderation-case-parser.ts`,
  `moderation-case-contract.ts` (+ los archivos de strikes aún sin desplegar en DEV).
- **Frontend:** `AdminModerationPage.tsx`, `ModerationAuditList.tsx`, `ModerationStrikeUnavailable.tsx`,
  mensajes `moderation`.
- Para ver todo esto en DEV hace falta desplegar el árbol completo (backend y frontend de DEV salieron
  de `6a2e441` + R2) y aplicar la migración.

## Validación en DEV (cuando se autorice)
1. Aplicar la migración (dry-run: debe listar solo `20261029120000…`) y desplegar.
2. Con un caso cerrado «Procede» ya existente (hay 7 decisiones `content_actioned` en DEV): abrirlo en
   Historial y comprobar etiquetas legibles y fechas en el idioma activo.
3. Aplicar un strike (con cuenta moderadora y MFA): debe aparecer «Strike aplicado · Strike N» en la
   auditoría de ese caso y no en otros casos del mismo autor.
4. Revocarlo con cuenta developer/admin distinta de quien lo aplicó: aparece «Strike revocado».
5. Estado no disponible: no se fuerza en DEV; está cubierto por tests (RPC con error, excepción y forma
   inválida). Rollback de la migración: nueva migración que restaure la definición de `20261022120000`.
