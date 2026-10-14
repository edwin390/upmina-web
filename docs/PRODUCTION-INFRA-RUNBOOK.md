# Production — respaldo, infraestructura y migraciones (runbook preparado, NO ejecutado)

Complementa `docs/COMMUNITY-PRODUCTION-RELEASE-PLAN.md`. Nada de lo descrito aquí se ha aplicado en Production.
Production: Supabase `dmtuvzfdaectvqczwfhx`; Vercel `upmina-web` (rama `main` por GitHub); R2 `upmina-media-prod-{public,private}`.

## 1. Respaldo de PostgreSQL de Production
**Estado (2026-10-14)**: **respaldo REALIZADO y verificado** (ver abajo). Production **no tiene backups ni PITR** (`backups: []`), así que este dump es hoy el único punto de restauración.
- **Respaldo**: `C:\Users\Edwin\upmina-backups\prod-20261014-084902\` (fuera del repo; ACL solo del usuario). Origen: proyecto `dmtuvzfdaectvqczwfhx`, PostgreSQL 17.6, 21 migraciones aplicadas; `pg_dump` 18.6; 2026-10-14T14:49:51Z. Alcance: esquemas `public`, `auth`, `storage`, `supabase_migrations` (datos + esquema + ACL/owners) en formato custom (`prod.dump`, 403 413 bytes, SHA-256 `b051a114…`), esquema de `public` en texto (`schema-public.sql`, 115 317 bytes), `roles.sql` (7 623 bytes: contiene **10 hashes de contraseña de roles** → tratarlo como secreto), `row-counts.csv`, `SHA256SUMS.txt` y `MANIFEST.txt`. 52 tablas = 52 `TABLE DATA` = 52 bloques `COPY`; 564 entradas de TOC (84 funciones, 21 triggers, 1 política); 268 filas en total (1 usuario en `auth.users`).
- **Verificaciones**: recuentos exactos en la base viva (16 tablas de `public` + `auth.users` + `schema_migrations`) = recuentos de los `COPY` del dump (**18/18**); SHA-256 recalculado = manifiesto; `pg_restore -l` y `pg_restore -f` legibles. Sesión `psql` en solo lectura (`set default_transaction_read_only = on`; el pooler ignora `PGOPTIONS`) y `pg_dump` abre transacciones de solo lectura; no se escribió nada en Production.
- **Ensayo de restauración + 42 migraciones** (`scripts/rehearse-restore-and-migrations.mjs`, base desechable PGlite en memoria, sin servicios externos): baseline = 21 migraciones; datos **reales** del dump restaurados en 19 tablas (`public` completo + `auth.users/identities/mfa_factors`, 64 filas) con **0 deriva de esquema** y recuentos = dump (19/19); las **42 pendientes aplican en orden (42/42)**; datos idénticos tras las 42 (19/19 tablas, columnas originales); 0 tablas sin RLS; `community-media-purge-tick` programado (stub). Fidelidad frente a DEV: tablas 45/45, triggers 62/62, políticas 1/1, funciones 181/182. **Limitaciones**: roles, `auth` (solo 3 tablas), `vault`, `pg_cron` y `pg_net` son stubs; `storage` y `supabase_migrations` solo se comparan por recuento; no equivale a Supabase administrado.
- **Herramientas**: `winget` `PostgreSQL.pgAdmin` 9.18 (instalador oficial de `ftp.postgresql.org`, SHA-256 verificado por winget: `ca82b9a0…9245`), instalado en `%USERPROFILE%\pgclient` (sin servidor); trae `pg_dump`/`pg_restore`/`psql` **18.6** (compatibles con el 17.6 de Production). Se ejecutan con `PATH=%USERPROFILE%\pgclient\runtime;%USERPROFILE%\pgclient\python` (la DLL `gssapi64.dll` está en `python`). Se intentó primero el instalador de EDB (`get.enterprisedb.com`): 403 de CloudFront desde esta red. También se instaló el redistribuible Microsoft VC++ 2015+ x64.
- **Cómo se obtuvo el acceso**: `supabase db dump` exige Docker/Podman (no autorizados) y `--dry-run` revela una credencial temporal (prohibido), así que se usó una cadena de conexión *Session pooler* de Production que el propietario dejó en un archivo privado fuera del repo (`prod.conn`, ACL solo del usuario); el script la lee sin imprimirla y **aborta si el usuario/host no son Production** o si el historial no tiene las 21 migraciones esperadas.
- **Credencial temporal que se mostró en una ejecución anterior**: ya **no es válida** (el CLI recrea el rol `cli_login_postgres` con contraseña nueva y caducidad de ~5 min en cada ejecución; 0 sesiones activas). No volver a usar `--dry-run`.
- **Repetir el respaldo**: `powershell -File scripts/backup-production.ps1 -ConnFile <ruta a prod.conn>` (con `pg_dump/pg_restore/psql` en `PATH`). Hacerlo de nuevo **justo antes** de migrar, para capturar cualquier cambio.
- **No cubierto por un `pg_dump`** (Supabase administrado): roles de plataforma y `vault`/`pgsodium` (vacío en Production), extensiones y configuración de Auth (Site URL, plantillas, SMTP: capturas manuales), objetos de R2 (bucket aparte; los 12 assets viven en R2, no en la base) y variables/secretos de Vercel y Cloudflare (inventario en §2.2).

```powershell
# Ubicación PRIVADA fuera del repo (contiene un correo real y un hash de contraseña)
$d = "$env:USERPROFILE\upmina-backups\prod-$(Get-Date -Format yyyyMMdd-HHmm)"; New-Item -ItemType Directory $d | Out-Null
$ref = "dmtuvzfdaectvqczwfhx"   # comprobar que es Production antes de ejecutar
npx supabase db dump --project-ref $ref -f "$d\schema-public.sql"                       # esquema (sin auth/storage por defecto)
npx supabase db dump --project-ref $ref --data-only --use-copy -f "$d\data-public.sql"  # datos de public
npx supabase db dump --project-ref $ref --data-only --use-copy -s auth -f "$d\data-auth.sql"   # usuarios/identidades/MFA
npx supabase db dump --project-ref $ref --role-only -f "$d\roles.sql"
Get-FileHash "$d\*.sql" -Algorithm SHA256 | Format-Table Hash, Path > "$d\SHA256SUMS.txt"
```
Todo es de **solo lectura** (`pg_dump` abre transacciones de lectura). No incluir `$d` en Git; no subirlo a ningún servicio público.

**Verificación de integridad** (sin revelar datos): (1) tamaños y SHA-256 registrados; (2) `COPY` por tabla = recuento real (`select count(*)` de las 16 tablas de `public` + `auth.users/identities/mfa_factors`); (3) **restauración de prueba** en una base *desechable* (Postgres local o proyecto Supabase temporal): aplicar `roles.sql` (si procede), `schema-public.sql`, `data-auth.sql`, `data-public.sql` y repetir los recuentos; (4) borrar la base desechable. Documentar solo tamaño, fecha y alcance.

**Procedimiento de restauración** (nunca sobre Production sin autorización específica):
1. Congelar escrituras (ventana corta; hay un único usuario real).
2. Fallo *durante* una migración → es transaccional: no hay nada que restaurar; corregir y reintentar.
3. Migración aplicada con efecto indeseado → preferir **fix-forward** con el rollback SQL de `supabase/rollbacks/` (existe para DEL-1/2/3, guard, reportes…); el esquema anterior a `20261007` es aditivo.
4. Pérdida o corrupción grave → restaurar el dump en un proyecto nuevo, verificar, y repuntar `VITE_SUPABASE_URL`/anon/service-role de Vercel (pérdida de los datos posteriores al dump).
5. Tras restaurar: `supabase migration list` debe coincidir con el historial (`migration repair` solo con evidencia).

## 2. Infraestructura (preparada, sin aplicar)
### 2.1 Secretos nuevos de Production (nunca copiados de DEV)
`node scripts/generate-production-secrets.mjs --out <ruta privada nueva fuera del repo>` genera el par Ed25519 y los tres secretos compartidos, los escribe en `production-secrets.env` y solo imprime la clave pública. Reparto: Vercel Production (cada variable), `wrangler secret put MEDIA_CHECK_SHARED_SECRET`, y Vault (§2.5). Archivo y copias: guardar en un gestor de contraseñas; no en Git.

### 2.2 Variables de Vercel (proyecto `upmina-web`, target *Production* únicamente)
| Variable | Valor / origen | Estado |
|---|---|---|
| `MEDIA_CAP_SIGNING_PRIVATE_KEY`, `MEDIA_CAP_KEY_ID` | generador (PKCS#8 base64, `prod-1`) | **creadas 2026-10-14** (Production, sensitive/encrypted) |
| `MEDIA_CAP_AUDIENCE` | `upmina-media-production` (igual que el worker) | **creada** |
| `MEDIA_CHECK_SHARED_SECRET`, `MEDIA_GC_SHARED_SECRET` | generador | **creadas** (el worker y Vault deben recibir el mismo valor después) |
| `MEDIA_DELIVERY_BASE_URL` | URL del worker de Production; **si no se define → modo LEGADO** (§4) | **retenida**: depende del worker de Cloudflare (aún no desplegado) |
| `ACCOUNT_DELETION_SHARED_SECRET` | generador (≥ 32; ya generado en la carpeta privada, **no cargado**) | **retenida**: debe cargarse junto con el secreto de Vault y el cron; sin ella el ejecutor no arranca (fail-closed) y una cuenta confirmada quedaría bloqueada sin limpieza |
| `ACCOUNT_DELETION_APP_URL` | `https://upminaa-web.com` (origen https exacto) | **retenida** (misma razón: se carga con el secreto, justo antes del despliegue) |
| `COPYRIGHT_APPEAL_APP_URL` | `https://upminaa-web.com` | **creada** |
| `COPYRIGHT_TEST_WINDOW_MINUTES` | **no definir** en Production (solo aplica a preview/development) | comprobar ausente |
| Ya presentes | `R2_PROD_*`, `MFA_RECOVERY_*`, `RESEND_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_*`, Instagram/TikTok/Twitch/YouTube | ok |
**Carga realizada (2026-10-14, solo nombres)**: en Vercel `upmina-web` (`prj_z6QNSyfd7SvZSunNv4YnPQzjLqln`, equipo `edwin-9cad`), target **production** únicamente, vía `vercel api POST /v10/projects/<id>/env` (sin `upsert`; no hay MCP de Vercel conectado): `MEDIA_CAP_SIGNING_PRIVATE_KEY`, `MEDIA_CAP_KEY_ID`, `MEDIA_CAP_AUDIENCE`, `MEDIA_CHECK_SHARED_SECRET`, `MEDIA_GC_SHARED_SECRET`, `COPYRIGHT_APPEAL_APP_URL`. Las 24 variables previas quedaron idénticas (id, target, tipo); Preview/Development y el proyecto de pruebas no se modificaron. Los secretos generados (incluidos los **retenidos**) están en `C:\Users\Edwin\upmina-secrets\prod-20261014\` (fuera del repo, ACL solo del usuario; pasar a un gestor de contraseñas). Cambiar variables **no** cambia el despliegue activo: solo se leen en el siguiente despliegue.
Comprobar: ninguna variable `R2_DEV_*` ni URL de DEV en Production; `r2-client.ts` solo usa `R2_PROD_*` cuando `VERCEL_ENV=production`.

### 2.3 Cloudflare
- **Worker**: plantilla `workers/media-delivery/wrangler.prod.jsonc` (`upmina-media-delivery-prod`, solo `upmina-media-prod-public`, `MEDIA_CHECK_URL=https://upminaa-web.com/api/media/access`). Sustituir `MEDIA_CAP_PUBLIC_KEYS` por la salida del generador; `wrangler secret put MEDIA_CHECK_SHARED_SECRET`; `wrangler deploy --config wrangler.prod.jsonc`. Probar con una URL firmada antes de definir `MEDIA_DELIVERY_BASE_URL`.
- **CORS de `upmina-media-prod-private`** (las subidas son PUT prefirmados a ese bucket): origen `https://upminaa-web.com` y `https://www.upminaa-web.com`, métodos `PUT, GET, HEAD`, `AllowedHeaders: ["content-type"]` (la prefirma con `requestChecksumCalculation: WHEN_REQUIRED` no añade cabeceras `x-amz-checksum-*`), `ExposeHeaders: ["ETag"]`, `MaxAgeSeconds: 3600`. Sin orígenes de Preview/DEV.
- El bucket público se sirve por el worker; verificar que no quede acceso público accidental distinto del previsto.

### 2.4 Supabase Auth (comprobación manual en el panel; no legible con las herramientas disponibles)
Site URL `https://upminaa-web.com`; Redirect URLs solo de Production (sin `*.vercel.app` ni `localhost`); confirmación de correo activa; SMTP/Resend con remitente de Production; plantillas de verificación y recuperación; MFA TOTP habilitado; límites de tasa por defecto.

### 2.5 Extensiones, Vault y cron
```sql
-- Dashboard → Database → Extensions: habilitar pg_cron y pg_net (la migración 20261021 los crea con IF NOT EXISTS).
-- Vault (valores desde production-secrets.env; ejecutar UNA vez, tras el despliegue del backend):
select vault.create_secret('<MEDIA_GC_SHARED_SECRET>', 'media_gc_shared_secret');
select vault.create_secret('https://upminaa-web.com/api/media/gc', 'media_gc_endpoint_url');
-- Eliminación de cuentas: SOLO tras la validación y con autorización aparte
select vault.create_secret('<ACCOUNT_DELETION_SHARED_SECRET>', 'account_deletion_shared_secret');
select vault.create_secret('https://upminaa-web.com/api/admin/account-deletion-run', 'account_deletion_endpoint_url');
-- select cron.schedule('account-deletion-tick', '* * * * *', $$select public.account_deletion_tick()$$);  -- aparte
```
- `20261021` programa **`community-media-purge-tick`** (cada 5 min) en cuanto se aplica; sin los secretos de Vault solo emite el aviso `gc_not_configured` (inocuo). `20261028` añade `media_abandon_policy` con `enabled=false` (no marca nada hasta activarlo).
- Vercel **Deployment Protection** (`all_except_custom_domains`) no afecta a `upminaa-web.com`, pero sí a URLs `*.vercel.app`: el endpoint del tick debe usar el dominio propio.

## 3. Migraciones pendientes (42), dependencias y orden
Orden = orden de versión; `supabase db push --include-all` (por `20261007`, anterior a la última remota `20261008`). Cada archivo es transaccional.
| Bloque | Versiones | Dependencias / notas |
|---|---|---|
| A. Moderación base | `20261007`, `20261009`–`20261015` | tablas de moderación, reportes, casos, decisión agrupada; DML sobre tablas nuevas. Sin extensiones. |
| B. Frontera de escritura | `20261016`–`20261019` | **`20261016` retira privilegios de escritura directa** sobre tablas de Community; el código vivo (`6a2e441`) ya los espera. |
| C. Purga/GC | `20261020`, **`20261021`**, `20261022` | `20261021`: `pg_cron` + `pg_net` + Vault (ver §2.5). Programa el cron. |
| D. Strikes y cuenta completa | `20261023`–`20261025` | `20261025`: autoridad de cuenta completa → requiere correo confirmado (Production: 1/1 confirmado). |
| E. Medios abandonados | `20261026`, `20261027`, **`20261028`** | `20261028` usa Vault (opcional) y política `enabled=false`. |
| F. Moderación y MFA | `20261029`–`20261031150000`, `20261101`–`20261105` | `admin_roles`: nuevo rol `developer`, reset/recuperación MFA, recuperación de contraseña. Production tiene 1 `admin` con 1 factor verificado. |
| G. Reportes y Copyright | `20261106`–`20261112` | motivos ordinarios, reclamaciones, apelaciones, strikes de Copyright. Tablas nuevas. |
| H. Eliminación de cuentas | `20261113`, **`20261114`**, `20261115` | `20261114` lee Vault (sin cron); `20261113` añade triggers de barrera sobre `profiles`/contenido. |
| I. Guard de username | `20261116` | trigger en `profiles`; el único username real (`edwin`) no lo infringe. |
Datos reales afectados: 1 usuario, 1 perfil, 1 publicación, 12 assets (4 cosplay, 6 imágenes y 2 vídeos de Community, todos `ready`). Ninguna migración exige secretos para aplicarse; solo `20261021` crea extensiones (requiere habilitarlas si el panel lo pide).
**Ensayo hecho** (`scripts/rehearse-pending-migrations.mjs`, PGlite en memoria; **no** es una copia de Production): baseline = las 21 migraciones aplicadas en Production + datos con su forma (1 usuario confirmado con MFA, 1 perfil `edwin`, 1 `admin`, 1 publicación con 3 medios, 12 assets `ready`); se aplican **las 42 en orden: 42/42 correctas**; datos conservados (usuarios, perfil, rol, publicación y estado, medios y 12 assets idénticos); 0 tablas sin RLS; `community-media-purge-tick` programado (stub de `pg_cron`). Fidelidad frente a DEV: tablas 45/45, triggers 62/62, políticas 1/1, funciones 181/182. **Limitaciones**: roles, `auth`, `vault`, `pg_cron` y `pg_net` son stubs (no se ejecuta `create extension` real); no reproduce permisos reales de Supabase ni datos reales. **No equivale a Production**: el ensayo definitivo requiere restaurar el dump en una base desechable.

## 4. Estrategia de entrega de medios
- **Fase A (recomendada primero)**: desplegar **sin** `MEDIA_DELIVERY_BASE_URL` → modo legado (el contenido público sigue con la URL pública antigua; los estados privados —moderador, en revisión— no tienen URL). Menos piezas nuevas en el primer release.
- **Fase B**: desplegar el worker, probarlo con una URL firmada, definir `MEDIA_DELIVERY_BASE_URL` y redeploy. Necesario para la vista de medios del Moderator y los estados privados.

## 5. Riesgos restantes
Sin backup ni PITR hasta que se haga el dump (B8); migraciones sin ensayo sobre una copia real; ventana entre migraciones y código (el código vivo ya espera hasta `20261022`); `pg_cron` programa un job al migrar (inocuo sin Vault); CORS y Auth no verificables desde aquí; R2 DEV físico y vistas Moderator/Developer reales sin validar; revisión jurídica pendiente; borrado de cuentas irreversible (cron aparte).

## 6. Autorizaciones que se necesitarán
1. Descargar e instalar herramientas cliente de PostgreSQL y ejecutar el respaldo (§1).
2. Generar los secretos y cargarlos (Vercel, Cloudflare, Vault) (§2.1–2.5).
3. Crear/desplegar el worker de Production y fijar el CORS (§2.3).
4. Habilitar `pg_cron`/`pg_net` (§2.5).
5. `supabase db push --include-all` a Production (§3).
6. Merge a `main` y push (despliega).
7. (Aparte) programar `account-deletion-tick`.

## 7. Registro de ejecución (2026-10-14)
- **Respaldo previo**: `C:\Users\Edwin\upmina-backups\prod-20261014-092847\` (SHA-256 `3b031f57…`, 18/18 recuentos, 268 filas). Se conserva el anterior `prod-20261014-084902`.
- **Migraciones en Production** (`dmtuvzfdaectvqczwfhx`): aplicadas las **42** (`20261007120000` … `20261116120000`) con `supabase db push --linked --include-all --workdir <dir aislado con project-ref de Production>` (sin tocar el enlace de DEV del repo). Preflight: historial = 21 versiones previas, 42 solo-locales exactas, 0 solo-remotas, `pg_cron`/`pg_net` disponibles, sin DDL destructivo de nivel superior.
- **Resultado**: 63 migraciones (última `20261116120000`); extensiones `pg_cron 1.6.4` y `pg_net 0.20.4`; 45 tablas (0 sin RLS), 182 funciones, 62 triggers, 1 política (= DEV); datos intactos (1 usuario, 1 perfil, 1 publicación `published`, 12 assets `ready`, 1 `admin`). Cron: solo `community-media-purge-tick` (`*/5`, inerte sin Vault: 0 secretos); **sin** `account-deletion-tick`; 0 solicitudes de eliminación. El código vivo en Production sigue siendo el anterior (no se desplegó la web).
