# 9K-R5-I · Validación integrada del panel de moderación (LOCAL · sin deploy · sin migraciones aplicadas)

Alcance: integración R5-D/E/F/G/H e inestabilidad observada de la suite. Sin funcionalidades nuevas.

## 1. Matriz de validación

| Área                                                                                  | Estado                                     | Evidencia                                                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cola Activos/Historial + filtros combinados + paginación anterior/siguiente           | PASS                                       | Tests R5-G (UI + SQL PGlite) y recorrido integrado R5-I                                                                              |
| Contador de pendientes (total del servidor, sin polling, error ≠ cero)                | PASS                                       | Tests R5-H (UI, handler, cliente, SQL)                                                                                               |
| Detalle + auditoría traducida (es/en/de) + eventos de strike                          | PASS                                       | Tests R5-F y recorrido integrado                                                                                                     |
| Aplicar/revocar strikes, MFA reciente, capacidades                                    | PASS                                       | Tests R5-D/E (sin cambios, siguen verdes)                                                                                            |
| Fallo del estado de strike (`strikeUnavailable`) con reintento                        | PASS                                       | Tests R5-F y recorrido integrado                                                                                                     |
| Imágenes/vídeos: carga, error, reintento, privacidad                                  | PASS                                       | Tests R5-H y recorrido integrado                                                                                                     |
| Caso expandido conservado al refrescar/filtrar                                        | PASS                                       | Tests R5-G/H y recorrido integrado                                                                                                   |
| Migraciones 29→30→31 encadenadas                                                      | PASS                                       | `moderation-migrations-chain.test.ts` (5 tests, SQL real)                                                                            |
| Compuerta de acceso en navegador (sin sesión)                                         | PASS                                       | `/admin/moderation` → `/login?returnTo=/admin/moderation`, escritorio y 375 px, sin desbordamiento horizontal                        |
| Panel autenticado en navegador (filtros, paginación, detalle, medios, teclado, móvil) | **BLOCKED**                                | Requiere sesión real con MFA reciente y datos de DEV; no se introducen credenciales ni se escribe en remoto. Solo cubierto por jsdom |
| Desbordamientos/solapes reales, scroll al paginar (`scrollIntoView`)                  | **BLOCKED**                                | Mismo motivo; jsdom no calcula layout                                                                                                |
| Inestabilidad de la suite                                                             | PASS (causa reproducible corregida) + RISK | Ver §3                                                                                                                               |

## 2. Defectos encontrados y corregidos

1. **Workers de Vitest que mueren («Worker exited unexpectedly») y dejan tests sin ejecutar** — ver §3.
2. **Test frágil `ArchiveEntry › desmontar con la secuencia a medias…`**: contaba TODOS los temporizadores
   falsos del Footer (`getTimerCount() === 1`) y bajo carga recibía 2. Ahora mide solo lo que añade el
   activador (delta = 1) y que desmontar no deje nada por encima de la base. Intención intacta.
3. **Falso positivo esporádico `community-author-media-delivery › never leaks the capability…`**: el
   regex `/k1/i` se aplicaba al valor `cap=` (base64url con firma aleatoria) y coincidía por azar
   (≈ 1 de cada 3–4 ejecuciones completas). Ahora se enmascara el token opaco y se exige que el resto del
   sobre no filtre claves ni rutas.
4. **`Stationery › pen()/eraser() fuerzan un escondite…`** (módulo de secretos): el plan de sesión usa
   `Math.random` y a veces coloca el lápiz real en el mismo escondite que el forzado → `queryByRole`
   encontraba 2 elementos. El test ahora comprueba «≥ 1» y que no escribe.
5. Nada que corregir en R5-D…H: el recorrido integrado no encontró regresiones.

## 3. Inestabilidad de la suite

**Síntoma:** ejecuciones completas con 94–240 tests «omitidos» y archivos «passed (n/238)»; en una
ejecución, además, fallos sueltos.
**Causa (reproducible):** `Error: Worker exited unexpectedly` (tinypool). Los workers de Vitest (pool
`forks`, por defecto = nº de núcleos, aquí 12) que ejecutan suites con **PGlite** (WASM Postgres, 24–25
archivos) mueren al coincidir muchas instancias a la vez; los tests de ese archivo no se ejecutan y no se
marcan como fallo (solo aparecen como «omitidos» y un «Unhandled Error» al final).
**Evidencia (solo las 24 suites PGlite, 718 tests):**

| maxForks                                                                                                     | resultado (2 ejecuciones cada una)                               |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1, 3, 6                                                                                                      | 718/718 pasan, sin errores de worker                             |
| 8                                                                                                            | 677/718 y 366/718, con errores de worker                         |
| 12 (defecto)                                                                                                 | 374/718 y 477/718 (y antes 192, 529, 149), con errores de worker |
| Máquina: 12 núcleos, 15,7 GB de RAM (≈4–5 GB libres durante las pruebas), archivo de paginación de 6 GB.     |
| Los mismos archivos pasan siempre en aislamiento. La causa raíz exacta dentro del proceso (límite de         |
| memoria nativa/WASM por instancia) no se midió; la correlación con el número de instancias simultáneas es    |
| causal en estas pruebas (variando solo `maxForks`).                                                          |
| **Corrección local:** `vite.config.ts` → `test.poolOptions.forks = { minForks: 1, maxForks: 6 }`, con        |
| comentario. No se tocaron timeouts. Resultado: 4/4 ejecuciones completas con 238 archivos y 7131 tests       |
| aprobados, 0 errores de worker (duración ≈ 90 s frente a ≈ 75 s).                                            |
| **Riesgo residual:** (a) el umbral depende de la RAM; en una máquina con menos memoria podría hacer falta un |
| valor menor. (b) Antes del tope se observó un fallo aislado en `AccountPage.profile-edit` y otro en          |
| `CosplayEditorDialog.mfa` (viewport estrecho) en ejecuciones completas; pasan en aislamiento y no se         |
| reprodujeron tras el tope. (c) Cualquier ejecución futura debería comprobar que el resumen diga              |
| «N passed (N)» y no contenga «Worker exited unexpectedly».                                                   |

## 4. Estado de las migraciones locales (NO aplicadas)

| Migración                                                                                                     | Qué hace                                                                                     | Dependencias / orden                                                                                                             |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `20261029120000_moderation_audit_strike_events`                                                               | `create or replace` de `community_moderation_cycle_read` (eventos de strike en la auditoría) | Parte de la definición de `20261022` (última que la redefine; 23–28 no la tocan); necesita `community_user_strikes` (`20261023`) |
| `20261030120000_moderation_queue_filters`                                                                     | `drop` + `create` de `community_moderation_cases_read` con 5 parámetros nuevos con DEFAULT   | Necesita la firma de 5 argumentos de `20261013`; usa `cycle_read` (cualquier versión)                                            |
| `20261031120000_moderation_pending_count`                                                                     | función nueva `community_moderation_pending_count(uuid)`                                     | Independiente                                                                                                                    |
| Verificado con PGlite (cadena completa): una sola firma por función, `anon`/`authenticated` sin EXECUTE,      |
| `service_role` solo en `cases_read` y `pending_count` (`cycle_read` es interna), llamada antigua de 5         |
| argumentos válida, re-aplicar `29` es idempotente, flujo caso→contador→filtro→decisión→strike→auditoría.      |
| Las migraciones `25`–`28` (cuenta/medios) no interactúan con estas funciones y no se incluyeron en la cadena. |
| Orden de despliegue recomendado: migraciones 29→31 y el backend/frontend a la vez (backend nuevo + SQL        |
| viejo: la cola sin filtros funciona, pero filtros y contador devuelven error).                                |

## 5. Resultados de pruebas (ejecución final)

Ver el informe de entrega para las cifras exactas. Archivos nuevos: `moderation-migrations-chain.test.ts`;
test integrado «R5-I» en `AdminModerationPage.test.tsx`.

## 6. Riesgos residuales

- BLOCKED de navegador autenticado (§1): layout real, scroll y teclado solo verificados en jsdom.
- Umbral de workers dependiente de la máquina (§3).
- `.claude/launch.json` declara el puerto 5173 para `dev`, pero Vite arranca en 3000 (config de Vite); la
  vista previa abre una pestaña en 5173 que falla. No se modificó (no relacionado).
- Backend y frontend R5-D…H siguen sin desplegarse en DEV.

## 7. Plan mínimo de validación posterior en DEV (con autorización)

1. Dry-run y aplicar `20261029`, `20261030`, `20261031`; desplegar el árbol completo.
2. Iniciar sesión como moderador con MFA: el contador coincide con el recuento de «Activos».
3. Filtrar por motivo + autor + fechas; paginar adelante/atrás (necesita >20 casos o datos de prueba).
4. Abrir un caso del Historial «Procede»: auditoría legible; aplicar y revocar un strike y ver ambos
   eventos con su nivel.
5. Con las herramientas del navegador bloquear el dominio de medios: placeholder y «Reintentar carga».
6. Revisar 375 px: sin desbordamiento horizontal ni controles solapados.
