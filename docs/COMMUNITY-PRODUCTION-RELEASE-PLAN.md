# Community → Production: estado, inventario y plan de despliegue

Elaborado el 2026-10-14 desde la rama `feat/community-copyright-integration` (3 commits locales de eliminación de cuentas sobre `646889c`).
**Nada de este plan se ha ejecutado en Production.** Inventario de Production = solo lectura.

## 1. Estado de cierre

| Área | Estado | Evidencia |
|---|---|---|
| DEL-1/2/3 (eliminación de cuentas) | Implementado y validado en DEV Preview | docs/DEL-1…3; dos eliminaciones reales (con y sin multimedia), 6 etapas `done`, `completed` |
| Corrección `media_gc` (`20261115120000`) | Aplicada en DEV, historial reparado con `supabase migration repair` | `db push --dry-run`: «Remote database is up to date» |
| Cierre de moderación `author_deleted` | Validado en DEV (caso `closed/author_deleted`, sin decisión/aviso/strike) | consultas SQL de la validación |
| Puerta técnica | `tsc -b`, `eslint --max-warnings 0`, `build`, `typecheck:functions` limpios; suite integral 8600/8601 | único fallo: `media-abandoned-reservations` («reloj real»), **preexistente** |
| Git | 3 commits locales, árbol limpio, sin push | `c50faea`, `fdf02d9`, `792e480` |

### Pendientes
**Bloqueantes para Production**
- B1 · **Integración con `main`** (ver §3): la rama diverge de `main` (6 commits propios) con conflictos y una colisión de versiones de migración.
- B2 · **Worker de entrega de Production inexistente** (solo `upmina-media-delivery-dev`). Hay que crearlo (§4.3).
- B3 · **Variables de Production ausentes** para medios y eliminación (§4.2).
- B4 · **Extensiones** `pg_cron` y `pg_net` no instaladas en Production (las exige `20261021`).
- B5 · **Revisión jurídica** del texto de privacidad y de los plazos de retención (docs/DEL-3 §3). El texto dice que los plazos «no están definidos».
- B6 · **Configuración de Auth de Production** (Site URL, Redirect URLs, plantillas, SMTP): no inspeccionable con las herramientas disponibles → comprobación manual en el panel.
- B7 · **CORS del bucket de Production** (`upmina-media-prod-*`): no inspeccionable → debe admitir el origen de producción y exponer `ETag`.

**No bloqueantes (se documentan, no impiden publicar)**
- N1 · Verificación **física** en R2 DEV (sin credenciales locales; solo HTTP del worker y BD).
- N2 · Vista visual Moderator del caso `author_deleted` y panel Developer con cuenta real (DEV no tiene Developer; no se elevan roles).
- N3 · Procedimiento separado para cuentas con rol de equipo (D10).
- N4 · Fallo preexistente de `media-abandoned-reservations`.

## 2. Inventario de Production (solo lectura) frente a DEV

| Recurso | Production | DEV |
|---|---|---|
| Vercel | proyecto `upmina-web` (`prj_z6QNS…`), rama de producción **`main`** por GitHub (un push a `main` **despliega**); despliegue vivo = commit `6a2e441` (= `origin/main`) | `upmina-web-testing` (sin Git) |
| Supabase | `dmtuvzfdaectvqczwfhx`; el sitio vivo apunta a él (comprobado en el bundle) | `rkqeqbqwdswhpzwqptac` |
| Migraciones aplicadas | 21 (hasta `20261008120000`; falta `20261007`) | 62 + reparación hecha |
| **Pendientes en Production** | **41** (`20261007`, `20261009`…`20261115`) | — |
| Datos reales | 1 usuario (admin), 1 perfil, 1 publicación, 12 assets, 16 tablas, RLS en todas | datos de prueba |
| Extensiones | `pgcrypto`, `supabase_vault`; **sin `pg_cron` ni `pg_net`** | con cron `community-media-purge-tick` |
| Cron | ninguno | solo `community-media-purge-tick` (`*/5`) |
| R2 | buckets `upmina-media-prod-public/-private`; variables `R2_PROD_*` presentes | buckets `-dev-`; `R2_DEV_*` |
| Worker de entrega | **no existe** | `upmina-media-delivery-dev` |
| Variables presentes (nombres) | Instagram, TikTok, Twitch, YouTube, MFA_RECOVERY_*, RESEND_WEBHOOK_SECRET, R2_PROD_*, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_* | + MEDIA_*, (eliminación en Preview) |

**Código vivo por delante del esquema**: Production ejecuta `6a2e441`, cuyo árbol incluye migraciones hasta `20261022` (comprobado con `git ls-tree origin/main`), contra un esquema que solo llega a `20261008`: las 14 migraciones `20261007`–`20261022` ya son esperadas por el código vivo. Por eso las migraciones deben aplicarse **antes** del código nuevo.

## 3. Integración Git (B1) — decisión incluida en la autorización
Estado: `origin/main` = `6a2e441`; la rama está **4 commits por delante** y 0 por detrás. La `main` **local** tiene 9 commits sin subir (3 de AUTH + 6 propios: `b1072a0` guard de suplantación de username, `b3ac59d` diálogo de reportes, `ccc1c9e` diseño Copyright, `1c19037` privacidad, `b990488` fix de checksums de R2, `dbb06aa` docs).
`git merge-tree` (sin tocar nada) detecta conflictos en: `CommunityReportButton(.test).tsx`, `community-report(.test).ts`, `community-report-reasons-sql.test.ts`, `profile-handlers.ts` y los 6 JSON de i18n (`auth`, `moderation`), además de `PrivacyPage.tsx`.
**Colisión de migraciones**: `main` define `20261101120000_username_impersonation_guard` y `20261102120000_community_report_reasons`; la rama ya usa esas versiones para `developer_panel` y `developer_transition`. La `20261102` de `main` es el mismo contenido que la `20261106` de la rama (ya en DEV).
Propuesta (mínima y reversible), a ejecutar tras la autorización:
1. Crear una rama de integración local desde la rama actual y fusionar `main` en ella (sin tocar `main`).
2. Descartar la `20261102…report_reasons` de `main` (duplicada por la `20261106` de la rama); renumerar `username_impersonation_guard` a `20261116120000` (libre, posterior a todo) con su rollback.
3. Resolver JSON de i18n por unión de claves; conservar el flujo de reportes ya validado en DEV; reconciliar `PrivacyPage` (el texto de la rama es el vigente; el borrador de `main` aporta la corrección sobre cuentas y localStorage: ya incluida).
4. Re-ejecutar la puerta técnica y las pruebas del guard de username, de reportes y de R2.
5. Aplicar `20261116…` en DEV con `supabase db push` y validar el guard.

## 4. Infraestructura previa (antes de migrar)
### 4.1 Backups
Comprobar en el panel de Supabase de Production un backup/PITR reciente y descargar un `pg_dump` lógico **antes** de la primera migración. Con 1 usuario y 1 publicación la restauración es barata; la ventana de riesgo está en el esquema, no en el volumen.
### 4.2 Variables de Vercel (proyecto `upmina-web`, solo Production)
Nuevas (valores generados para Production, **no copiados de DEV**): `MEDIA_CAP_SIGNING_PRIVATE_KEY`, `MEDIA_CAP_KEY_ID`, `MEDIA_CAP_AUDIENCE`, `MEDIA_DELIVERY_BASE_URL`, `MEDIA_CHECK_SHARED_SECRET`, `MEDIA_GC_SHARED_SECRET`, `ACCOUNT_DELETION_SHARED_SECRET`, `ACCOUNT_DELETION_APP_URL=https://upminaa-web.com`, `COPYRIGHT_APPEAL_APP_URL`. Verificar que `COPYRIGHT_TEST_WINDOW_MINUTES` **no** exista en Production.
### 4.3 Worker de entrega de Production
Nuevo `wrangler` (copia de `workers/media-delivery/wrangler.jsonc`) con nombre `upmina-media-delivery-prod`, binding **solo** `upmina-media-prod-public`, `MEDIA_CAP_PUBLIC_KEYS` de la clave de Production, `MEDIA_CHECK_URL=https://upminaa-web.com/api/media/access` y secreto `MEDIA_CHECK_SHARED_SECRET`. Verificar con una URL firmada antes de enlazarlo.
### 4.4 R2 y Auth
CORS del bucket de Production: origen `https://upminaa-web.com` (y `www`), métodos `PUT/GET/HEAD`, `ExposeHeaders: ETag`. Auth: Site URL y Redirect URLs de Production, SMTP/Resend, plantilla de verificación. Confirmar que ninguna URL de Preview/DEV está permitida.
### 4.5 Extensiones y secretos de Vault
Habilitar `pg_cron` y `pg_net` (Dashboard). Cargar en Vault: `media_gc_shared_secret`, `media_gc_endpoint_url`, y —**solo tras la validación**— `account_deletion_shared_secret`, `account_deletion_endpoint_url`.

## 5. Secuencia de despliegue (con puntos de parada)
0. **Congelar**: ventana corta; no hay tráfico relevante (1 usuario). Anotar versión viva (`6a2e441`) y el alias para el rollback de Vercel.
1. **Integración Git** (§3) y puerta técnica. *Parada si falla algo crítico.*
2. **Infra** §4.1–4.5 (excepto Vault de eliminación y el cron de eliminación). *Parada: smoke del worker con URL firmada.*
3. **Migraciones en Production** con `supabase db push --include-all` (por `20261007`, anterior a la última remota) tras `--dry-run`. Orden = orden de versión. `20261021` y `20261028` crean `pg_cron/pg_net` y **programan `community-media-purge-tick`**, que sin los secretos de Vault solo emite `gc_not_configured` (inocuo). *Parada tras cada bloque: comprobar `schema_migrations`, RLS (0 tablas sin RLS) y grants.*
4. **Código**: merge a `main` y push → despliegue automático. Hasta este punto el esquema es compatible con el código vivo; **el código nuevo exige el esquema nuevo** (el gate de eliminación falla cerrado si falta la RPC), por eso va después.
5. **Smoke no destructivo** (§6). *Parada si falla.*
6. **Cron de eliminación**: solo con aprobación aparte; cargar los secretos de Vault y programar `account-deletion-tick`.
7. **Observabilidad**: logs de Vercel, `cron.job_run_details`, alertas Developer.

## 6. Verificación posterior
Carga de `/`, `/community`, login con la cuenta de prueba autorizada, publicar y leer (texto), subida y entrega de una imagen por el worker de Production, reporte y caso (cuenta de prueba), acceso Moderator/Admin (sesión real del propietario), `GET /api/admin/account-deletion-alerts` sin sesión → 401, `account-deletion-run` sin firma → 401, 0 tablas sin RLS, `VITE_SUPABASE_URL` de Production y ningún recurso `-dev-` en el bundle ni en las variables. **No** se ejecuta ninguna eliminación real en Production.

## 7. Recuperación (realista)
| Qué falla | Respuesta | Límite |
|---|---|---|
| Frontend/API con error | `vercel rollback` al despliegue `upmina-1ozmu8gz0` (commit `6a2e441`) | **No revierte migraciones**: el código viejo debe seguir siendo compatible con el esquema nuevo (aditivo en su mayoría; ver riesgo R1) |
| Una migración falla | Cada migración es transaccional: se detiene sin aplicarse; se corrige y se reintenta | — |
| Migración aplicada con efecto no deseado | Rollback SQL de `supabase/rollbacks/` si existe; si no, restauración desde el `pg_dump` previo | Restaurar pierde los datos posteriores al dump |
| Configuración (variables, CORS, worker) | Revertir la variable/regla; redeploy | Los secretos regenerados no se recuperan: guardar los anteriores si existían |
| Eliminación de cuentas | **Irreversible por diseño** una vez confirmada | Por eso el cron de eliminación se activa aparte y el smoke no elimina cuentas |
Riesgos: **R1** migraciones como `20261016` retiran privilegios de escritura directa; el código vivo (`6a2e441`) ya las espera (su árbol llega a `20261022`), así que aplicarlas acerca esquema y código; las posteriores (`20261023`–`20261115`) son las que el código vivo no conoce y se comprueban en el smoke inmediato. **R2** `pg_cron` programa un job nada más migrar (inocuo sin Vault). **R3** el borrador legal de privacidad sin revisar.

## 8. Operaciones que requieren autorización explícita
1. Integración Git local (§3) y, después, `merge` a `main` + `push` (**despliega Production**).
2. Variables/secretos de Vercel de Production y alta del worker y CORS de Cloudflare (§4).
3. Habilitar `pg_cron`/`pg_net` y cargar secretos de Vault.
4. `supabase db push --include-all` contra Production (41 migraciones).
5. (Aparte, más adelante) programar `account-deletion-tick`.
