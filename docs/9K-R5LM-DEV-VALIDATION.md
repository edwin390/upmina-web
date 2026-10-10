# 9K-R5-L/M · Despliegue y cierre técnico de moderación en DEV (2026-10-10, ≈ 03:00–03:25Z)

**Estado final: PARTIAL** — despliegue, alias y todas las pruebas automatizadas y de humo: PASS. Pendiente solo lo
que exige una sesión humana con MFA (§6). R5 puede considerarse cerrado **técnicamente**; no funcionalmente
validado en DEV hasta completar §6.

## 1. Despliegue

|                                                                                                                  | Identificador                               | URL                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| **Anterior (rollback del alias)**                                                                                | `dpl_6AGTMU5asb2GdQcrhVsfERp3Yv1e`          | `https://upmina-web-testing-pccytl1nz-edwin-9cad.vercel.app` |
| **Nuevo (Preview, sin `--prod`)**                                                                                | `dpl_4PaKcPDMeHdwaYJb8cr5A6FDfa1e`          | `https://upmina-web-testing-cnnnjbp1u-edwin-9cad.vercel.app` |
| **Alias DEV actualizado**                                                                                        | `upmina-testing-backend.vercel.app` → nuevo | **`https://upmina-testing-backend.vercel.app`**              |
| Proyecto `upmina-web-testing` (`prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP`), scope `edwin-9cad`, desde el paquete aislado |
| `C:\Dev\upmina-web-r5-deploy` (nunca desde el árbol principal). Preview Ready, 5 funciones (`api/admin/[action]` |
| 960 KB, `api/media/[resource]`, …). No se aplicaron migraciones nuevas (las 3 ya estaban: R5-K).                 |

## 2. Comprobaciones previas (Fase 1) — PASS

Vercel enlazado a `upmina-web-testing`; Supabase del paquete = `rkqeqbqwdswhpzwqptac` (solo para el dry-run de
R5-K; el directorio `supabase/.temp` se **eliminó** del paquete antes de desplegar para no subirlo); paquete sin
cambios ajenos desde R5-J.1 (16 modificados + 38 añadidos, 0 en R2/media/AUTH-2/9N/cron/package/vercel.json);
`tsc`, ESLint (0 warnings) y build OK; historial 45 migraciones, última `20261031`; `enabled=false`, 0 `deleting`;
alias antes: `…pccytl1nz…`; escaneo de secretos limpio, solo `.env.example`.

## 3. Pruebas de humo (Preview y luego alias) — PASS

| Prueba                                                                                                                         | Preview                | Alias      |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ---------- |
| `/`, `/community`, `/cosplay`, `/login`, `/admin/moderation` (SPA)                                                             | 200                    | 200        |
| `/api/content/community-feed`, `/api/content/cosplay-list`                                                                     | 200 (= alias anterior) | 200        |
| `GET moderation-cases` (cola, `summary=pending`, detalle)                                                                      | 401 `No autenticado`   | 401        |
| `POST moderation-strike-apply`, `moderation-strike-revoke`, `moderation-case-decision`                                         | 401                    | 401        |
| `GET /api/admin/access`                                                                                                        | 401                    | —          |
| `Cache-Control` de las respuestas administrativas                                                                              | `no-store`             | `no-store` |
| 5xx inesperados                                                                                                                | ninguno                | ninguno    |
| Notas: `/api/twitch-status` responde 503 tanto en el despliegue anterior como en el nuevo (credenciales de Twitch              |
| no configuradas en este Preview): **preexistente, sin cambio**. Las rutas de strike existen en el backend nuevo (401, no 404). |
| El bundle servido por el alias contiene el panel nuevo (rutas de strike, filtros, textos del contador y de                     |
| reintento de carga multimedia).                                                                                                |

## 4. Alias — PASS

Solo se movió `upmina-testing-backend.vercel.app`. Verificado con `alias ls`: apunta a `…cnnnjbp1u…`;
`upmina-web-testing.vercel.app` y `upmina-web-testing-edwin-9cad.vercel.app` siguen en `…gd7diyhgk…`; los alias de
Production (`upminaa-web.com`, `www`, `upmina-web.vercel.app`, `…git-main…`) siguen en `upmina-96juvj9cs`. Las
pruebas posteriores al cambio pasaron: **no se revirtió** el alias (el rollback documentado sería
`alias set https://upmina-web-testing-pccytl1nz-edwin-9cad.vercel.app upmina-testing-backend.vercel.app`). No se
ejecutó rollback SQL.
Navegador (en el alias): `/admin/moderation` redirige a `/login?returnTo=/admin/moderation` (escritorio); `/community`
a 375 px sin desbordamiento horizontal y sin errores de consola.

## 5. Validación funcional automatizada — PASS

Paquete (el mismo código desplegado), `tsc` OK; **suite completa 209 archivos / 6502 tests** en 2 ejecuciones
finales con 3 workers, sin errores de worker, sin omitidos, sin fallos. Cubre: Activos/Historial, filtros y
paginación (anterior/siguiente/inicio, carreras, cursor inválido), contador de pendientes (cero/uno/varios, >1
página, tras decisión, error/carga, permisos), detalle y auditoría traducida (es/en/de), aplicar y revocar
strikes (MFA, roles, un solo vuelo, `strikeUnavailable`), medios (carga/error/reintento/privacidad), mensajes
`author_restricted` (backend y editor), SQL real con PGlite (filtros, contador, eventos de strike, cadena 29→31 y
rollback con `md5` de DEV). Además, 1394 tests del subconjunto de moderación antes del despliegue.

## 6. BLOCKED por sesión humana / MFA (NO ejecutado, NO PASS)

Panel autenticado en el alias: contador real = recuento de «Activos»; filtros y paginación con datos reales de DEV
(≥ 20 casos); detalle y auditoría de un caso «Procede»; aplicar y revocar un strike en una cuenta de PRUEBA y ver
ambos eventos con su nivel; aviso `author_restricted` para el autor sancionado; imagen/vídeo con fallo simulado;
layout real a 375 px en el panel; teclado; compuerta MFA con TOTP vencido. (No se pidieron credenciales ni se
eludió MFA; tampoco se crearon strikes.)

## 7. R7 (Fase 6, SELECT 03:09Z) — sin cambios

`enabled=false`, `min_age=24:00:00`, `last_run_at` NULL; Asset A `reserved`; 0 `deleting`; 154 assets con la misma
huella `6f2399df…`; cron: 1 job activo con el mismo comando (`a11fc58e…`); 0 strikes. No se activó la política ni
se ejecutó ningún barrido.

## 8. Problemas encontrados y correcciones

1. **Workers de Vitest con poca memoria libre:** con ≈ 3,6 GB libres, una corrida del subconjunto con 6 workers
   perdió workers (`Worker exited unexpectedly`); con 3 workers pasó 39/39 archivos (1394 tests). Misma causa que
   R5-I (instancias PGlite simultáneas); el tope de 6 depende de la RAM libre. No se declaró PASS con workers perdidos.
2. **Flake del test `community-author-media-delivery › never leaks…`** (regex `/k1/i` sobre la firma aleatoria de
   `cap=`): reapareció en el paquete porque el paquete conservaba el test de HEAD. Se portó el mismo arreglo (solo
   test; ningún código desplegado cambia) y el archivo pasa 3/3 aislado y 2/2 en suite completa.
3. Sin defectos en el código desplegado.

## 9. Riesgos pendientes

- Validación autenticada pendiente (§6). - El backend nuevo corre contra SQL ya compatible; el rollback del alias
  es suficiente si se detecta un fallo (el SQL nuevo es compatible con el backend anterior). - `/api/twitch-status`
  503 (credenciales no presentes en el entorno Preview; preexistente). - Un autor sancionado todavía puede reservar
  una subida (precheck de reserva excluido del paquete; la publicación sí queda bloqueada). - Flakes ajenos
  intermitentes (`AccountPage.profile-edit`, `workers/media-delivery`, `CosplayEditorDialog.mfa`) y tests no
  herméticos (necesitan `VITE_SUPABASE_URL/ANON_KEY`). - R7 sigue pendiente (Asset A sería elegible de inmediato con
  `min_age=2h`). - El Preview anterior huérfano `…24b70pvvl…` sigue existiendo (sin alias).

## 10. Siguiente paso humano

Iniciar sesión con una cuenta moderadora (MFA reciente) en `https://upmina-testing-backend.vercel.app/admin/moderation`
y recorrer §6; después decidir si retomar R7.
