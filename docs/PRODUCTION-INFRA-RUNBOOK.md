# Production — respaldo, infraestructura y migraciones (runbook preparado, NO ejecutado)

Complementa `docs/COMMUNITY-PRODUCTION-RELEASE-PLAN.md`. Nada de lo descrito aquí se ha aplicado en Production.
Production: Supabase `dmtuvzfdaectvqczwfhx`; Vercel `upmina-web` (rama `main` por GitHub); R2 `upmina-media-prod-{public,private}`.

## 1. Respaldo de PostgreSQL de Production
**Estado (2026-10-14)**: herramientas cliente **instaladas**; respaldo **NO realizado** (falta una credencial de lectura; ver abajo). Production **no tiene backups ni PITR** (`backups: []`), así que este dump será el único punto de restauración.
- **Herramientas**: `winget` `PostgreSQL.pgAdmin` 9.18 (instalador oficial de `ftp.postgresql.org`, SHA-256 verificado por winget: `ca82b9a0…9245`), instalado en `%USERPROFILE%\pgclient` (sin servidor); trae `pg_dump`/`pg_restore`/`psql` **18.6** (compatibles con el 17.6 de Production). Se ejecutan con `PATH=%USERPROFILE%\pgclient\runtime;%USERPROFILE%\pgclient\python` (la DLL `gssapi64.dll` está en `python`). Se intentó primero el instalador de EDB (`get.enterprisedb.com`): 403 de CloudFront desde esta red. También se instaló el redistribuible Microsoft VC++ 2015+ x64.
- **Por qué no se hizo el dump**: `supabase db dump` exige Docker/Podman (no autorizados) y `pg_dump` directo necesita una credencial de lectura que solo el propio CLI genera (rol temporal que **solo** revela `--dry-run`, prohibido) o la contraseña de la base. No se extraen secretos por otras vías.
- **Credencial temporal que se mostró en la ejecución anterior**: ya **no es válida**: el CLI recrea el rol `cli_login_postgres` con una contraseña nueva en cada ejecución y con caducidad de ~5 min (comprobado en `pg_roles`: `rolvaliduntil` a minutos vista; 0 sesiones activas). No requiere revocación manual; no se vuelve a usar `--dry-run`.
- **Para ejecutarlo** (una sola acción del propietario, sin pegar nada en el chat): crear un archivo **fuera del repo**, p. ej. `C:\Users\Edwin\upmina-backups\prod.conn`, con una línea `postgresql://postgres.dmtuvzfdaectvqczwfhx:<PASSWORD>@aws-0-us-west-2.pooler.supabase.com:5432/postgres` (Supabase › Connect › Session pooler; contraseña de la base: *Database settings*; solo si se desconoce habría que restablecerla, lo que es un cambio en Production). Luego: `powershell -File scripts/backup-production.ps1 -ConnFile <ruta>`. El script aborta si el usuario/host no son Production, hace dump `-Fc` de `public`, `auth`, `storage` y `supabase_migrations`, esquema en texto, recuentos exactos, verificación de TOC/COPY y manifiesto con SHA-256 **sin datos personales**.
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
| `MEDIA_CAP_SIGNING_PRIVATE_KEY`, `MEDIA_CAP_KEY_ID` | generador (PKCS#8 base64, `prod-1`) | falta |
| `MEDIA_CAP_AUDIENCE` | `upmina-media-production` (igual que el worker) | falta |
| `MEDIA_CHECK_SHARED_SECRET`, `MEDIA_GC_SHARED_SECRET` | generador | falta |
| `MEDIA_DELIVERY_BASE_URL` | URL del worker de Production; **si no se define → modo LEGADO** (§4) | falta (opcional en fase A) |
| `ACCOUNT_DELETION_SHARED_SECRET` | generador (≥ 32) | falta |
| `ACCOUNT_DELETION_APP_URL` | `https://upminaa-web.com` (origen https exacto) | falta |
| `COPYRIGHT_APPEAL_APP_URL` | `https://upminaa-web.com` | falta |
| `COPYRIGHT_TEST_WINDOW_MINUTES` | **no definir** en Production (solo aplica a preview/development) | comprobar ausente |
| Ya presentes | `R2_PROD_*`, `MFA_RECOVERY_*`, `RESEND_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_*`, Instagram/TikTok/Twitch/YouTube | ok |
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
