# Moderación shadow con OpenAI — preparación para reactivación futura

Estado: **preparada y NUNCA ejecutada con OpenAI real.** Este documento solo describe lo que el código ya hace
(`src/lib/content-shadow-*.ts`, migraciones `20261122`–`20261125`). No contiene claves ni valores secretos.

## 1. Estado y validaciones

- F4-A a F4-D implementadas. Migraciones `20261122120000`, `20261123120000`, `20261124120000` y `20261125120000` aplicadas **solo en
  Supabase DEV** (`rkqeqbqwdswhpzwqptac`). Production (`dmtuvzfdaectvqczwfhx`, Vercel `upmina-web`) no se ha tocado.
- Transporte OpenAI: 75 pruebas unitarias con HTTP simulado (`content-shadow-openai.test.ts`). Build corregido en `7829b1d`.
- E2E con proveedor **fake** en DEV (Preview `dpl_umMkywgN26XKEm9s2t6fvKqtV4hN`, hoy detrás del alias `upmina-web-testing.vercel.app`):
  captura por trigger, adquisición, resultados fixture, presupuesto persistente y cobertura `unsupported_video`. Sin decisiones
  automáticas, strikes ni avisos. Datos sintéticos eliminados.
- **No existe validación con OpenAI real.** No hay `OPENAI_API_KEY` en ningún entorno de Vercel.

## 2. Proveedor fake frente a real

`selectShadowTransport()` (`content-shadow-openai.ts`):

| `CONTENT_SHADOW_PROVIDER` | Resultado                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| sin definir, o `fake`     | `FakeModerationTransport` (modo `simulated`, modelo devuelto `fixture-omni-shadow`, sin red). **Predeterminado.** |
| `openai`                  | `OpenAIModerationTransport`; exige todas las condiciones de la sección 3 o lanza `auth_unavailable`.              |
| cualquier otro valor      | Error `auth_unavailable`: no se ejecuta nada.                                                                     |

El proveedor real solo usa `https://api.openai.com/v1/moderations` (fijo en código), modelo `omni-moderation-latest`, POST sin
credenciales de navegador, `redirect: "manual"`, timeout de 1800 ms, respuesta acotada a 64 KiB y validación estricta de la
respuesta. Envía texto y **imágenes** como `data:image/webp;base64` (hasta 4 MiB); nunca URLs remotas, audio ni vídeo.

## 3. Variables que exige el código

Configurables (entorno **Preview** de `edwin-9cad/upmina-web-testing`, Project ID `prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP`):

| Variable                     | Valores admitidos                                             | Efecto                                                                              |
| ---------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `CONTENT_SHADOW_RUN_ENABLED` | exactamente `true`                                            | Cualquier otro valor: el endpoint responde 503 «Ejecución deshabilitada».           |
| `CONTENT_SHADOW_BUDGET_MODE` | `persistent_dev`                                              | Presupuesto SQL persistente. El proveedor real **lo exige** (si no, error).         |
| `CONTENT_SHADOW_PROVIDER`    | `fake` / sin definir / `openai`                               | Ver sección 2.                                                                      |
| `OPENAI_API_KEY`             | 10–512 caracteres ASCII imprimibles (`^[\x21-\x7e]{10,512}$`) | Solo con `openai`. Ausente o con formato inválido: `auth_unavailable`, sin llamada. |
| `SUPABASE_SERVICE_ROLE_KEY`  | clave de DEV                                                  | La usa el endpoint para el repositorio, los medios y el presupuesto.                |

Las siguientes **las pone Vercel** y el código las comprueba antes de cada componente: `VERCEL=1`, `VERCEL_ENV=preview`,
`VERCEL_PROJECT_ID=prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP`, `VITE_SUPABASE_URL=https://rkqeqbqwdswhpzwqptac.supabase.co`. Por eso OpenAI
real **no puede ejecutarse** en Production, en local, en otro proyecto ni contra otro Supabase. Estado actual del Preview:
`CONTENT_SHADOW_RUN_ENABLED=true`, `CONTENT_SHADOW_BUDGET_MODE=persistent_dev`; sin `CONTENT_SHADOW_PROVIDER` ni `OPENAI_API_KEY`.

## 4. Cómo añadir `OPENAI_API_KEY` sin exponerla

Solo con autorización explícita (sección 8). La clave se introduce por el gestor de secretos de Vercel, nunca en código, Git,
`.env.example`, chat ni este documento:

- Panel: Project `upmina-web-testing` → Settings → Environment Variables → Add → entorno **Preview** únicamente → marcar _Sensitive_.
- O CLI, escribiendo el valor en el prompt interactivo (no como argumento, para que no quede en el historial):
  `npx vercel env add OPENAI_API_KEY preview` y, si la CLI lo ofrece, `--sensitive`.

Las variables de Vercel solo afectan a **despliegues nuevos**: tras cambiarlas hace falta un despliegue Preview nuevo.

## 5. Mantener el procesamiento real desactivado

No definir `OPENAI_API_KEY` y no definir `CONTENT_SHADOW_PROVIDER` (o dejarlo en `fake`). Con eso el endpoint, aunque se llame,
usa el proveedor fake. Aunque alguien pusiera `openai` sin clave, el código falla cerrado antes de cualquier petición.

## 6. Prueba controlada futura (una publicación sintética)

1. Autorización escrita del propietario y presupuesto confirmado (sección 7).
2. Añadir `OPENAI_API_KEY` y `CONTENT_SHADOW_PROVIDER=openai` en Preview; desplegar un Preview nuevo; no mover el alias estable.
3. Con una cuenta de prueba de DEV, crear **una** publicación sintética con texto e imagen inocuos (flujo normal de Community).
4. Con sesión developer + MFA reciente: `POST /api/admin/content-shadow-run` con `{"limit":1}`. Esperado: `mode: "openai"`, 1 job,
   máximo 2 componentes (texto + imagen).
5. Verificar en DEV: resultados, `community_shadow_budget_days`, cobertura y que no hay decisiones, strikes ni avisos.
6. Eliminar la publicación sintética por el flujo normal; retirar la clave y `CONTENT_SHADOW_PROVIDER` y desplegar de nuevo.

## 7. Presupuesto, cooldown y fallos

- Presupuesto: **100 componentes por día UTC** (`community_shadow_budget_days`). Un job reserva entre 1 y 11 unidades (texto + hasta
  10 imágenes). Agotado → `quota_exhausted` hasta las 00:00 UTC. Ningún RPC puede subir el tope.
- Una petición del endpoint procesa 1 o 2 jobs (`limit`), y solo una tanda a la vez por instancia.
- Reintentos: máximo 3 intentos por job, con espera creciente. Un 429 aplica cooldown compartido con `Retry-After` (mínimo 60 s); si
  supera 7 días queda `halted`. `auth_unavailable` con proveedor real fija cooldown de 1 h y detiene la tanda; `internal_failure`
  detiene la tanda. Ningún fallo se interpreta como aprobación ni genera decisiones.
- Resultados: solo modo sombra. El pipeline no aprueba, rechaza, retiene, sanciona ni avisa.

## 8. Confirmaciones necesarias antes de activar

Orden expresa del propietario; clave nueva creada solo para esta prueba y con límite de gasto en OpenAI; confirmar que el destino es
Preview de `upmina-web-testing`; confirmar `VITE_SUPABASE_URL` de DEV; revisar los términos de OpenAI sobre datos enviados (texto e
imágenes de usuarios); decidir el tope diario; confirmar que el alias estable no se cambia hasta validar.

## 9. Desactivación inmediata

De más rápida a más lenta:

1. Revocar o rotar la clave en el panel de OpenAI: corte inmediato (las llamadas pasan a `auth_unavailable` y cooldown de 1 h).
2. SQL con privilegios de administrador en DEV: `update public.community_shadow_budget_control set halted = true;`. Todas las
   reservas devuelven `cooldown_active`. Ningún RPC lo revierte: hacerlo requiere SQL de administrador.
3. Vercel: eliminar `OPENAI_API_KEY` y `CONTENT_SHADOW_PROVIDER`, o poner `CONTENT_SHADOW_RUN_ENABLED=false`, y desplegar de nuevo.

## 10. Limitación conocida: vídeo

Los vídeos **no se analizan**. Un job con vídeo queda `partial` con cobertura `unsupported_video` y sin resultados de proveedor.
La moderación de vídeo, si se quisiera, es trabajo nuevo.

## 11. Estado exacto de DEV y suspensión

- **Procesamiento:** solo existe el endpoint manual `POST /api/admin/content-shadow-run` (capacidad `developer_panel`, MFA reciente,
  DEV). No hay cron de Vercel ni de Supabase para shadow (el único cron de DEV es `community-media-purge-tick`). Con
  `CONTENT_SHADOW_RUN_ENABLED=true` solo se procesa cuando un developer lo invoca; nada es programado.
- **Suspensión mínima:** `CONTENT_SHADOW_RUN_ENABLED=false` (o eliminarla) en Preview y un despliegue nuevo, o no llamar al endpoint.
  Con proveedor fake y sin clave no hay coste ni salida de datos en ningún caso.
- **La captura NO se detiene:** los triggers `community_shadow_*_capture` están en la base de datos y siguen creando un job por cada
  versión de publicación o edición pendiente, aunque el procesamiento esté desactivado. Cada job guarda una copia del texto
  (`snapshot_text`).
- **Acumulación:** la limpieza (`community_shadow_maintain`: borra la copia del texto a las 24 h y las filas a los 30 días) solo se
  ejecuta dentro del endpoint de procesamiento. Con el procesamiento parado los jobs y sus copias de texto se acumulan.
  Mitigación sin cambios de código: ejecutar periódicamente, con SQL de administrador, `select public.community_shadow_maintain(100);`.
  Evitarla del todo exigiría desactivar los triggers (`ALTER TABLE … DISABLE TRIGGER community_shadow_post_capture`, `…media_capture`,
  `…edit_capture`, `…edit_media_capture`) o una migración nueva; no se ha hecho y requiere autorización.
- **Último estado conocido de DEV:** 0 jobs, 0 resultados, 0 reservas; el presupuesto diario conserva la fila de `2026-10-18`
  (2 unidades, del E2E fake).
