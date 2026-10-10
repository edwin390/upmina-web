# 9K · Cierre técnico de R5 y validación segura de R7 (2026-10-10)

Solo trabajo local + SELECT en Supabase DEV (`rkqeqbqwdswhpzwqptac`). Sin deploy, commit, push, migraciones,
escrituras remotas, barridos, ni cambios en Production, R2, `media_assets`, GC, cron, Asset A/B o la política R7.

## Resumen

| Bloque                         | Estado                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| A · Errores de tipos de Vercel | **PASS** (5/5 corregidos y reproducibles con un chequeo nuevo)                        |
| B · R7                         | **PARTIAL** (lógica SQL verificada localmente; la prueba A/B real NO está completada) |

## A. Los cinco diagnósticos

### Por qué `tsc -b` no los veía

`@vercel/node` compila cada función con el `tsconfig.json` de la raíz. Ese archivo solo tiene
`files: []` y `references`: **no tiene `compilerOptions`**, así que Vercel compila SIN `strict` (sin
`strictNullChecks`). `tsc -b` usa `tsconfig.node.json`, que sí es `strict`. Sin `strictNullChecks`, TypeScript
no estrecha uniones discriminadas por un booleano literal (`ok: true | false`) ni elimina `null` de un `unknown`.
Reproducción local: `tsc` con los mismos criterios (sin strict) sobre `api/**` devolvió exactamente 5 errores.

### Causa y solución (solo tipos; el comportamiento en ejecución no cambia)

| #   | Ubicación                                                    | Diagnóstico                   | Causa                                                                          | Solución                                                                                                           |
| --- | ------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 1   | `moderation-strike-contract.ts` (apply)                      | TS2322                        | `if (!reason.ok) return reason;` no estrecha → `reason` seguía siendo la unión | `if ("code" in reason) return { ok: false, code: reason.code };` (el narrowing por `in` funciona con y sin strict) |
| 2   | `moderation-strike-contract.ts` (revoke)                     | TS2322                        | idem                                                                           | idem                                                                                                               |
| 3   | `moderation-strike-contract.ts` `parseModerationStrikeState` | TS2322 (`unknown` → `string`) | `decisionId !== null` no estrecha `unknown` sin strictNullChecks               | `rawDecisionId` validado con `isStrikeUuid` y asignado a `decisionId: string \| null`                              |
| 4   | `moderation-strike-handlers.ts` (apply)                      | TS2339                        | `if (!input.ok) … input.code`                                                  | `if ("code" in input)`                                                                                             |
| 5   | `moderation-strike-handlers.ts` (revoke)                     | TS2339                        | idem                                                                           | idem                                                                                                               |

Sin `any`, `@ts-ignore` ni relajar comprobaciones. No cambian contratos HTTP, permisos ni reglas de strikes
(las 81 pruebas de `moderation-strike-api` y el resto de strikes siguen pasando).

### Comprobación reproducible

- Nuevo `tsconfig.functions.json` (sin strict, `include: api/**/*.ts`) y script `npm run typecheck:functions`.
- `npm run build` ahora lo ejecuta (`tsc -b && npm run typecheck:functions && vite build`), de modo que un
  build local o de Vercel falla si reaparece un error que solo ve el compilador de funciones.
- Mutación comprobada: volver a `if (!input.ok)` en el handler hace fallar `typecheck:functions` con TS2339.
- Limitación: replica los criterios (no estrictos) de `@vercel/node`, pero no se ejecutó el compilador de Vercel
  (no se desplegó). Se confirmará en el próximo Preview autorizado.

## B. R7

### Estado remoto exacto (SELECT, 2026-10-10 04:10Z)

`media_abandon_policy`: `enabled=false`, `min_age=24:00:00`, `batch_limit=20`,
`protected_before=2026-10-09 23:00Z`, `last_run_at/last_*` NULL. 154 assets, 0 `deleting`. Asset A
`a9c4e223…`: `reserved`, `created_at=updated_at=2026-10-09 23:06:39.885Z`, con `multipart_upload_id`
(solo comprobado que existe). Único asset posterior al corte: A. Asset B no existe. 1 cron activo.
45 migraciones, última `20261031120000`. Nada modificado.

### Casos verificados localmente (PGlite, SQL real; `media-abandoned-reservations.test.ts`, 24 tests)

| Requisito                            | Evidencia                                                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Política desactivada → no marca      | test «desactivado» y tick `abandoned.status=disabled`                                                                                                                                                                |
| Corte histórico respetado            | «EXCLUSIÓN HISTÓRICA…» (huérfanos, 27-sep, 22:59:59Z excluidos; justo en el corte, elegible); filtro en la propia consulta + revalidación bajo lock; CHECK impide bajar el corte; mutación al quitar el filtro falla |
| Reservas recientes no elegibles      | umbral exacto/por debajo; `updated_at` reciente protege; el trigger renueva la actividad                                                                                                                             |
| Antiguas solo cuando corresponde     | solo `reserved/uploaded/verifying/processing`, `community/cosplay`, `created_at` y `updated_at` ≤ ahora − min_age (≥ 2 h por CHECK y `greatest`)                                                                     |
| `ready`/`failed`/`deleting` intactos | «nunca toca ready, failed ni deleting»                                                                                                                                                                               |
| Idempotencia                         | «repetir no re-marca»                                                                                                                                                                                                |
| Límite de lote                       | orden por antigüedad, reanudación                                                                                                                                                                                    |
| Errores                              | fallo contenido en subtransacción, rollback del lote, solo `last_error_class`; el tick sigue                                                                                                                         |
| R2 solo por el flujo autorizado      | el marcador solo cambia `status`; no llama a R2. El GC existente (solo `deleting`) aborta con el `uploadId` exacto y la fila sobrevive si el aborto falla                                                            |
| Permisos                             | `anon/authenticated/service_role` sin acceso; solo `postgres`                                                                                                                                                        |

Resultados: 7 archivos relacionados (R7, cleanup, scheduler, GC ×3, strike-api) **250/250**.

### Lo que NO está verificado (brechas reales)

1. **Concurrencia real**: PGlite es una sola conexión; `FOR UPDATE SKIP LOCKED`, el lock de la fila de política y el
   advisory lock del tick se comprueban solo de forma estructural/por revisión, no con dos sesiones simultáneas.
2. **«Asociada a contenido publicado»**: el marcador no consulta enlaces; la protección es indirecta (un asset
   vinculado a un post ya es `ready`, y `ready` nunca es candidato). No hay un test con un asset pendiente vinculado.
   Se recomienda añadir uno (riesgo bajo).
3. **Prueba A/B real**: NO completada. No hay evidencia de que un barrido real marque A y el GC aborte la sesión R2.
   Tampoco se ha visto en producción-like el JSON del tick (`cron.job_run_details` no lo guarda).
4. El corte `2026-10-09 23:00Z` es específico de DEV (no usar tal cual en Production).
5. `media_abandoned_sweep` (R6) sigue invocable por `service_role` y sin corte histórico.

### Riesgo clave

Con `min_age=2h`, Asset A (≈ 5 h de antigüedad) sería elegible en el siguiente tick. Por eso no se cambió
`min_age` ni se activó. **Asset A ya no sirve como «abandonada en curso» de una prueba A/B limpia**: pasó la ventana
de 2 h; solo serviría como «X1 abandonada» (sacrificable) si se decide expresamente.

### Cómo completar la prueba sin poner en riesgo activos históricos

Opción preferida (sin tocar A): repetir el protocolo de `9K-R7-ABANDONED-RESERVATIONS.md` con **assets nuevos**
creados después del corte (X1 abandonada, X2 reciente) y una ventana controlada, sin otros assets de prueba. Opción
alternativa: usar A como X1 (ya tiene multipart abierto y es el único posterior al corte) y crear solo B como X2
recién reservado; es válida solo si el propietario acepta que A se elimine.

## Procedimiento seguro de la prueba final (NO ejecutado; cada paso requiere autorización)

1. **Previo (SELECT)**: política `enabled=false`; 0 `deleting`; backlog GC a cero; huella de `media_assets` anotada;
   alias DEV en un backend con la protección multipart; conjunto exacto de assets posteriores al corte.
2. Confirmar con `r2-multipart-check-dev.mjs` (script del propietario) la sesión abierta de X1.
3. Crear X2 (recién reservado, < 2 h) mientras X1 supera 2 h.
4. Autorizado: `update media_abandon_policy set enabled=true, min_age=interval '2 hours';` (1 fila).
5. Observar UN tick natural: esperado `candidates=1, marked=1` (solo X1); el siguiente ciclo del GC finaliza X1;
   X2 y todo lo demás intacto (huella).
6. Cierre inmediato: `update media_abandon_policy set min_age=interval '24 hours', enabled=false;`.

### Criterios de aceptación

- Se marca exactamente X1; X2 y los históricos (incluido cualquier otro posterior al corte no previsto) intactos.
- Sesión R2 de X1 pasa a `NO_OPEN_SESSION`; fila X1 finalizada; `policy.last_*` coherentes; sin errores en logs.
- Huella de assets idéntica salvo X1; política devuelta a `enabled=false, 24 h`.

### Reversión

Inmediata, sin deploy: `update media_abandon_policy set enabled=false, min_age=interval '24 hours';`. Lo marcado
`deleting` sigue su curso en el GC (es el objetivo; no es reversible por diseño). Rollback completo de la
funcionalidad: nueva migración que elimine la tabla y la función y restaure el tick de `20261021` (sin editar la ya
aplicada).

## Validaciones ejecutadas

- `tsc -b` OK · `typecheck:functions` OK · ESLint 0 warnings · Prettier OK (archivos tocados) · `npm run build` OK
  (ya incluye `typecheck:functions`).
- Tests de R5/R7/GC/strikes: 7 archivos, 250/250.
- Suite completa (3 workers, PGlite, `VITE_` sintéticas): **239 archivos / 7155 tests OK**, sin workers perdidos ni
  omitidos. Una pasada previa tuvo 1 fallo de foco en un test de UI (`expect(region).toHaveFocus()`) ajeno a estos
  cambios; no se repitió en la pasada siguiente (flake conocido bajo carga, no se declara resuelto).

## Pendientes reales para cerrar 9K

1. Validación autenticada de R5 en `https://upmina-testing-backend.vercel.app/admin/moderation` (sesión humana con MFA,
   segunda cuenta developer/admin y autor con perfil para aplicar → revocar).
2. Confirmar en el próximo Preview autorizado que Vercel ya no imprime los 5 diagnósticos (requiere deploy).
3. Completar la prueba A/B de R7 (arriba) o decidir descartarla; opcional test de pendiente vinculado y de
   concurrencia real con dos sesiones.
4. Decidir el destino de los históricos protegidos y de `media_abandoned_sweep`.
5. Producción: nada de esto se ha aplicado; commit/push pendientes (árbol con muchos cambios sin confirmar).

## Actualización R7 FINAL (2026-10-10)

Ver `docs/9K-R7-FINAL-VALIDATION.md`. Hallazgo: el corte histórico NO protege a Asset A (posterior al corte; con
`min_age=24h` es elegible desde 2026-10-10 23:06Z). El marcador no admite selección por asset; el aislamiento
requiere subir `protected_before` (escritura de política, no ejecutada) y `batch_limit=1`. 5 tests nuevos de
regresión (29/29). Estado R7: **PARTIAL**; prueba remota B/C no ejecutada.

## Despliegue de cierre de R5 en DEV (2026-10-10, 04:42–04:47Z)

- **Nuevo Preview (sin `--prod`):** `dpl_BehZFx7hww6nU6VEy2gEw26ajT5e`, `https://upmina-web-testing-euvv69ars-edwin-9cad.vercel.app`, Ready.
  Anterior (rollback del alias): `dpl_3sJLkHxs3T9n3y9pFNqd4dtG1qLK` (`…prwzbctve…`):
  `alias set https://upmina-web-testing-prwzbctve-edwin-9cad.vercel.app upmina-testing-backend.vercel.app --scope edwin-9cad`.
- **Trasladado al paquete** (diff previo = solo esto): `moderation-strike-contract.ts`, `moderation-strike-handlers.ts`,
  `package.json` (scripts `typecheck:functions` y `build`), `tsconfig.functions.json` (nuevo). `typecheck:functions`
  cubre los 12 entrypoints de `api/`.
- **Log de compilación de Vercel:** `tsc -b && npm run typecheck:functions && vite build` se ejecutó; 12 compilaciones de
  funciones; **0 líneas `TS####`** (antes: 5 × TS2339/TS2322). Build Completed, Deployment completed.
- **Paquete:** `tsc -b`, `typecheck:functions`, ESLint (0 warnings), Prettier y build OK; suite 209 archivos / 6520 tests OK.
- **Alias:** solo `upmina-testing-backend.vercel.app` → nuevo Preview; `upmina-web-testing*.vercel.app` siguen en
  `…gd7diyhgk…`; Production (`upminaa-web.com`, `www`, `upmina-web.vercel.app`) en `upmina-96juvj9cs`. No hubo revert.
- **Humo (Preview y alias):** `/`, `/community`, `/cosplay`, `/login`, `/admin/moderation`, `community-feed`,
  `cosplay-list` = 200; cola, `access`, strike apply/revoke y decisión sin token = 401 con `no-store`; el chunk
  `AdminModerationPage` contiene los textos R5-N; en navegador `/admin/moderation` → `/login?returnTo=…`, sin errores de consola ni desbordamiento.
- **DEV sin cambios (SELECT 04:46Z):** R7 `enabled=false`, 24 h, `last_run_at` NULL; Asset A `reserved`; 0 `deleting`;
  huella de assets `6f2399df…` idéntica; 1 cron; strikes=1 (el de prueba previo del propietario); última migración `20261031`.

### Aceptación autenticada (a realizar por el propietario con sesión MFA; NO marcadas PASS)

1. Activos: un caso pendiente sin publicación muestra «La publicación ya no existe…» y solo «No procede».
2. Historial: un «Procede» con autor sin perfil muestra «la cuenta del autor ya no está disponible» y ningún botón de strike.
3. Caso `42b875cd`, ciclo 1 («No procede»): sin sección de strike; el ciclo 2 («Procede») sí.
4. Strike aplicado por tu cuenta: aviso «lo aplicaste tú: otra persona con rol de desarrollo o administración debe revocarlo», sin botón.
5. Alternar Activos/Historial: sin acciones de strike en Activos ni de decisión en Historial; contador y filtros coherentes.
6. Pendiente (requiere 2.ª cuenta developer/admin y autor con perfil): aplicar → revocar completo.

## Consolidación en Git (2026-10-10)

Un único commit local exclusivo de 9K (91 archivos; el hash se informa en la entrega, no se escribe aquí porque
no puede estar dentro del propio commit). **Sin push.** Rama `main`, HEAD inicial `6a2e441`.

**Estado de R5:** aceptación visual completada por el propietario (casos pendiente sin publicación, autor sin
perfil, `42b875cd` ciclo 1/ciclo 2, strike propio sin botón de revocar, Activos/Historial). Sigue pendiente la
revocación de un strike con dos cuentas autorizadas.
**Estado de R7:** validación local acelerada completada (PGlite, 36/36 en el archivo); `media_abandon_policy.enabled=false`
en DEV (última comprobación 04:46Z), Asset A `reserved` y sin cambios. Prueba remota B/C y concurrencia real con dos
conexiones PostgreSQL: **pendientes**.
**Validación del conjunto** (worktree limpio de HEAD + solo el diff preparado): `tsc -b`, `typecheck:functions`,
ESLint (0 warnings), Prettier y build OK; resultado de la suite completa en la entrega. El despliegue DEV pasó
6520 tests en el paquete aislado y la suite del árbol principal 7167.

**Fuera del commit (siguen sin confirmar en el árbol de trabajo):** AUTH-2 (`account-*`, migración
`20261025120000_account_complete_authority.sql` —aplicada en DEV pero no versionada hasta el commit de AUTH-2—,
`auth-context`, Login/Signup, hunks AUTH-2 de handlers y de `useMediaUpload`/`media-client`), Easter eggs 9N
(`src/secrets/`, `App.tsx`, `Footer`, locales `secrets`/`auth`, `VITE_SECRETS_ENABLED`), rediseño de UI (Home, secciones,
Header, globals.css), `r2-client.ts` (`requestChecksumCalculation`), `.agents/`, `AGENTS.md`, `evidence/*.csv`,
`public/images/echidna.gif` eliminado, y los hunks de AUTH-2/precheck de reserva de los archivos mixtos
(`community-post-handlers`, `media-handlers`, `moderation-handlers.test`, etc.), que permanecen en el árbol de trabajo.

**Pendientes antes de Production:** (1) revocar strike con dos cuentas; (2) prueba remota R7 B/C (subiendo
`protected_before` antes de activar) y concurrencia real; (3) decidir `media_abandoned_sweep` y los históricos
protegidos; (4) migraciones 20261023–20261031 en Production solo tras autorización expresa (el corte de R7 es
específico de DEV); (5) commits de AUTH-2 y 9N por separado (la migración 25 ya está en DEV); (6) push y revisión.
Nada de esto está validado en Production.
