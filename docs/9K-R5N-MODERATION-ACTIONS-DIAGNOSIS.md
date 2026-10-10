# 9K-R5-N · Diagnóstico de acciones ausentes en moderación DEV (2026-10-10)

Solo diagnóstico + correcciones LOCALES de presentación. Sin deploy, sin cambios de SQL, permisos ni reglas de
negocio, sin escrituras remotas (solo SELECT en DEV, sin datos personales). Las correcciones están en el árbol
principal y **NO** se han copiado al paquete `C:\Dev\upmina-web-r5-deploy` ni desplegado.

## 1. Tabla de condiciones (del código real)

| Acción                                                                                                                  | Aparece cuando                                                                                                                                                                                                                                                                 | Quién / MFA                                                              | Fuente                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **«No procede»**                                                                                                        | Pestaña **Activos**, caso `actionable()`: caso y ciclo `pending`, ciclo vigente, sin decisión ni `closureKind`, y si la publicación está oculta preventivamente, por ESTE ciclo; además el snapshot debe ser válido para el contrato de decisión                               | `moderation` + MFA reciente (`requireCapability`)                        | `AdminModerationPage.actionable`, `ModerationDecisionActions`           |
| **«Procede»**                                                                                                           | Lo anterior **y la publicación existe** (`post !== null`, estado `published`/`hidden_pending_review`/`hidden`, versión incrementable). Con `post === null` el contrato lo rechaza (`originalPostState === null && content_actioned`) y el SQL también: no hay nada que retirar | ídem                                                                     | `groupedDecisionInputFromCase` + `parseGroupedDecisionInput`            |
| **«Aplicar Strike N»**                                                                                                  | Pestaña **Historial**, el ciclo es el «Procede» (R5-N), bloque `strike.eligible` con nivel previsto y sin strike previo                                                                                                                                                        | `moderation` + MFA reciente (no se exige developer/admin)                | `ModerationStrikePanel`                                                 |
| No hay botón pero sí **motivo**                                                                                         | `author_unavailable` (el autor no tiene perfil/cuenta), `self_strike_forbidden` (es tu contenido)                                                                                                                                                                              | —                                                                        | SQL `community_strike_state_read` (R5-B)                                |
| Sin sección de strike                                                                                                   | caso sin «Procede» (`decision_not_content_actioned`) o aún no cerrado                                                                                                                                                                                                          | —                                                                        | panel devuelve `null`                                                   |
| **«Revocar strike»**                                                                                                    | Strike existente, **no revocado**, y `canRevoke` del servidor: `revoked_at is null` ∧ rol **developer/admin** ∧ `applied_by <> actor`                                                                                                                                          | developer/admin + MFA reciente; **nunca quien lo aplicó** (dos personas) | SQL `v_can_revoke`; mismo control en HTTP y en la función de revocación |
| Strike «activo»                                                                                                         | `revoked_at is null`; la restricción está «vigente» si además `permanent` o `ends_at > now()` (por eso la auditoría puede mostrar un strike cuya sanción ya terminó)                                                                                                           | —                                                                        | SQL                                                                     |
| Fallo al leer el estado de strike                                                                                       | el backend marca `strikeUnavailable`: alerta + «Reintentar»; **nunca** botones ni «sin strike»                                                                                                                                                                                 | —                                                                        | R5-F                                                                    |
| MFA vencido: el panel completo deja de cargarse (compuerta `canLoadPanel`) y redirige a MFA; no deja botones obsoletos. |

## 2. Diagnóstico por síntoma (con SELECT en DEV)

**A · Pendiente con solo «No procede» → condición de estado, comportamiento INTENCIONAL (con un defecto de explicación).**
De 48 casos pendientes en DEV, **47 no tienen fila de publicación** (borrada/purgada) y 1 está `published`. Sin
publicación no hay contenido que retirar, así que «Procede» no existe (contrato y SQL). Defecto de presentación: la
interfaz no lo explicaba.

**B · «Procede» en Historial sin botón de strike → condición de estado, INTENCIONAL (+ un bug latente de ciclos).**
De las 8 decisiones «Procede» de DEV, **7 tienen `profile_exists=false`** (incluida la de hoy 03:32Z): el autor ya no
tiene perfil → el SQL responde `author_unavailable` y la UI muestra la frase «la cuenta del autor ya no está
disponible» **en lugar** del botón. No es un error ni de permisos. Bug latente demostrado en el modelo de datos
(caso real `42b875cd`: ciclo 1 «No procede», ciclo 2 «Procede»): el bloque de strike se calcula por CASO (última
decisión «Procede» del caso), así que el ciclo «No procede» mostraba acciones de strike que pertenecen a OTRO ciclo.

**C · Strike 1 registrado sin botón de revocar → INTENCIONAL (regla de dos personas / rol), sin explicación.**
En DEV hay 1 strike activo (decisión `e943c56f`): aplicado por un **admin**, decidido por un moderador. `canRevoke`
exige developer/admin y que quien revoca **no sea quien aplicó**. Si lo miras con el mismo usuario que lo aplicó,
o como moderador, no hay botón por diseño. Auditoría y estado vigente pueden diferir legítimamente: la auditoría es
histórica (eventos); el estado es la fila del strike (revocado / vigencia). Defecto de presentación: la sección no
decía por qué faltaba el botón.

**Otros descartes:** cambiar Activos/Historial no arrastra acciones (las de decisión solo en Activos, las de strike
solo en Historial); «Actualizar contexto» relee del servidor; perder el MFA redirige. Hallazgo propio: desde R5-G
`openCase` conservaba el detalle anterior mientras llegaba el nuevo, y tras aplicar/revocar podía quedar visible un
botón obsoleto durante la recarga (ventana corta; el backend lo habría rechazado con `strike_already_issued`).

## 3. Correcciones locales (solo presentación; ningún permiso, regla ni SQL cambia)

| Archivo                                         | Cambio                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/admin/ModerationDecisionActions.tsx` | Aviso cuando la publicación no existe: «solo puede cerrarse como No procede»                                                                                                                                                                                   |
| `src/pages/admin/ModerationStrikePanel.tsx`     | Prop `role` (solo para explicar): strike activo sin `canRevoke` → «Solo desarrollo o administración pueden revocar» (moderador) o «lo aplicaste tú: otra persona … debe revocarlo» (developer/admin)                                                           |
| `src/pages/admin/AdminModerationPage.tsx`       | (1) `strikeBelongsToCycle`: el panel de strike solo se muestra si el ciclo abierto es el «Procede» y `decisionId` coincide; (2) tras aplicar/revocar/estado cambiado/reintento, `openCase(id, true)` descarta el detalle anterior (no queda un botón obsoleto) |
| `AdminModerationPage.test.tsx`                  | 18 tests nuevos «R5-N»                                                                                                                                                                                                                                         |

## 4. Tests y resultados

18 tests nuevos (A: sin publicación / con publicación / ciclo cerrado sin decisiones; B: autor no disponible,
auto-strike, ciclo «No procede», decisión de otro ciclo, control positivo; C: moderador, developer y admin que
aplicó, otra persona con `canRevoke`, ya revocado, nunca aplicar de nuevo con strike emitido; y auditoría vs estado
vigente, error de lectura ≠ «sin strike», detalle obsoleto tras aplicar, Activos vs Historial). Mutaciones
comprobadas: quitar `strikeBelongsToCycle` hace fallar 2 tests; quitar el `fresh` hace fallar el de «detalle
obsoleto». No aplicar dos veces / no revocar dos veces / no repetir una decisión: ya cubiertos con SQL real en
`community-strikes-foundation.test.ts` (`strike_already_issued`, `strike_already_revoked`),
`moderation-strike-api.test.ts` (doble envío = 1 strike) y `moderation-grouped-decision.test.ts` (decisión sobre
ciclo cerrado = obsoleta).
Validación: `tsc`, ESLint (0 warnings), Prettier, build OK; **suite completa 239 archivos / 7155 tests** (3 workers,
sin errores de worker ni omitidos).

## 5. Qué falta para validar en DEV

1. Sincronizar los 3 archivos de `src/pages/admin` + el test al paquete `C:\Dev\upmina-web-r5-deploy` y
   desplegar de nuevo (requiere autorización; es solo frontend).
2. Con sesión real: en Historial, el caso de hoy (autor sin perfil) debe mostrar la frase de «cuenta no
   disponible»; el caso 42b875cd (ciclo 1 «No procede») ya no debe mostrar acciones de strike; el strike activo
   debe mostrar el aviso de revocación según tu rol/usuario; un pendiente sin publicación debe explicar por qué
   solo hay «No procede».
3. Para probar el ciclo completo aplicar → revocar hace falta **otra cuenta developer/admin distinta** de quien
   aplica (regla de dos personas), con un autor que **tenga perfil**.

---

# R5-N.1 — Despliegue de las correcciones de interfaz en DEV (2026-10-10 ≈ 04:00Z)

|                                   | Identificador                                                         | URL                                                          |
| --------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Anterior (rollback del alias)** | `dpl_…` de `…cnnnjbp1u…` (R5-L/M: `dpl_4PaKcPDMeHdwaYJb8cr5A6FDfa1e`) | `https://upmina-web-testing-cnnnjbp1u-edwin-9cad.vercel.app` |
| **Nuevo (Preview, sin `--prod`)** | `dpl_3sJLkHxs3T9n3y9pFNqd4dtG1qLK`                                    | `https://upmina-web-testing-prwzbctve-edwin-9cad.vercel.app` |
| **Alias DEV**                     | `upmina-testing-backend.vercel.app` → nuevo                           |                                                              |

- **Traslado:** solo `AdminModerationPage.tsx`, `ModerationDecisionActions.tsx`, `ModerationStrikePanel.tsx` y
  `AdminModerationPage.test.tsx`; antes de copiar se verificó con `diff` que la única diferencia con el árbol
  principal eran los hunks R5-N (el test: bloque añadido de 227 líneas, 0 líneas eliminadas). Paquete enlazado a
  `upmina-web-testing` (`prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP`).
- **Validación del paquete:** `tsc`, ESLint (0 warnings), Prettier y build OK; 45 archivos / 1513 tests de moderación,
  strikes, handlers de Community y componentes de Community (3 workers) OK, sin workers perdidos. Diff frente al
  paquete DEV desplegado: 18 modificados + 39 añadidos, sin AUTH-2, 9N, R2, `media_*`, cron ni cambios SQL (la única
  coincidencia con «R7» es el _archivo_ de la migración 28 ya aplicada, solo para alinear el historial).
- **Humo del Preview y del alias (idénticos):** SPA y rutas públicas 200 (`/`, `/community`, `/cosplay`, `/login`,
  `/admin/moderation`, `community-feed`, `cosplay-list`); `moderation-cases` (cola, `summary=pending`, detalle),
  `moderation-strike-apply/revoke`, `moderation-case-decision` y `access` sin token → 401 `No autenticado` con
  `Cache-Control: no-store`; el bundle del alias contiene los textos R5-N. Navegador: `/admin/moderation` →
  `/login?returnTo=/admin/moderation`, sin desbordamiento.
- **Alias:** solo `upmina-testing-backend.vercel.app` cambió; `upmina-web-testing.vercel.app` y
  `upmina-web-testing-edwin-9cad.vercel.app` siguen en `…gd7diyhgk…`; los alias de Production siguen en
  `upmina-96juvj9cs`. No hizo falta revertir. Rollback: `alias set https://upmina-web-testing-cnnnjbp1u-edwin-9cad.vercel.app upmina-testing-backend.vercel.app --scope edwin-9cad`.
- **R7 (SELECT 04:01Z):** `enabled=false`, `min_age=24:00:00`, `last_run_at` NULL; Asset A `reserved`; 0 `deleting`;
  huella de `media_assets` `6f2399df…` (idéntica); 1 cron con el mismo comando; 45 migraciones, última `20261031`.
  Observación: `community_user_strikes` pasó de 0 a **1** fila (y 1 evento `strike_*` de auditoría) entre las 03:09Z y
  las 04:01Z: es el strike de PRUEBA aplicado por el propietario en su sesión; este despliegue no creó ni modificó ninguno.
- **Hallazgo (preexistente, no introducido aquí):** el compilador de funciones de Vercel imprime 5 diagnósticos de
  tipos (`TS2339/TS2322`) en `moderation-strike-handlers.ts` y `moderation-strike-contract.ts` (estrechamiento de la unión
  `ok`) en este despliegue **y en el anterior**; no son fatales y el código funciona en ejecución (las rutas responden
  según contrato), pero conviene corregirlos en un cambio aparte (`tsc -b` local no los reporta).
- **Requiere sesión autenticada (pendiente, no marcado PASS):** comprobar en el panel los cuatro escenarios de §5 de
  este documento.
