# Production — aplicación selectiva de las 5 migraciones finales (runbook; NO ejecutado)

Proyecto Supabase Production: `dmtuvzfdaectvqczwfhx`. Estado de partida confirmado por el propietario: última migración registrada
`20261118120000` (legal_acceptances), con `20261117120000` ya registrada. **No se vuelve a aplicar ninguna de esas dos.**

| Se aplican (en este orden)                           | No se aplican                                              |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `20261119120000` community_media_required            | `20261122120000` a `20261126120000` (community_shadow\_\*) |
| `20261120120000` held_for_review_pending_edits       |                                                            |
| `20261121120000` content_review_queue                |                                                            |
| `20261127120000` account_deletion_completion_notices |                                                            |
| `20261128120000` account_deletion_developer_recovery |                                                            |

Las cinco no dependen de las shadow (0 referencias; las shadow dependen de las anteriores, no al revés). Ensayo local (PGlite, baseline = 65
migraciones hasta la 18, 5/5 aplicadas, datos conservados, 0 objetos shadow, RLS forzada en las tres tablas nuevas, sin `EXECUTE` para
`anon`/`authenticated`): ver `scripts/rehearse-pending-migrations.mjs` (adaptado) y los checks de `scripts/sql/`.

## Piezas preparadas

| Pieza                                              | Uso                                                                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/backup-production.ps1`                    | Respaldo `pg_dump` (solo lectura). `-CheckOnly` solo verifica destino e historial. Exige historial **exacto** = archivos locales ≤ `20261118120000` |
| `scripts/production-readonly-sql.ps1`              | Ejecuta un `.sql` de lectura contra Production (rechaza cualquier sentencia que escriba; verifica project-ref; exit 2 si hay `FAIL`)                |
| `scripts/sql/production-migration-preflight.sql`   | Checks previos (historial, huellas de funciones, restricciones, datos, RLS, privilegios, cron)                                                      |
| `scripts/sql/production-definitions-snapshot.sql`  | Guarda las definiciones que se van a sobrescribir (referencia para recuperar)                                                                       |
| `scripts/prepare-production-migration-workdir.ps1` | Construye el directorio aislado con 65 migraciones de historial + las 5 (sin shadow), 70 en total, y un `config.toml` sin `[db.vault]`              |
| `scripts/sql/production-migration-postflight.sql`  | Checks posteriores                                                                                                                                  |

## Cómo maneja la CLI las versiones intermedias (por qué se usa un directorio aislado)

`supabase db push` compara los archivos locales con `supabase_migrations.schema_migrations` de Production. Con `supabase` 2.121.0:

- `--include-all` = «migraciones no encontradas en el historial remoto» (también las **anteriores** a la última remota).
- Si hay un archivo local con versión **menor** que la última remota y no está aplicado → la CLI se detiene («Found local migration files to be
  inserted before the last migration on remote database») salvo `--include-all`.
- Si el historial remoto tiene versiones **sin archivo local** → se detiene («Remote migration versions not found in local migrations directory») y
  sugiere `migration repair`.
- `db push` también actualiza los secretos de Vault declarados en `config.toml` salvo `--skip-vault`.

Por eso: el directorio aislado contiene **todo el historial ≤ 18 + solo las 5** (las 5 son mayores que la última remota ⇒ son las únicas
pendientes; ninguna shadow existe en el directorio ⇒ no puede arrastrarlas), no lleva `[db.vault]` y se usa `--skip-vault`. **No se usa `--include-all`,
`migration repair` ni `--dry-run`** (el runbook anterior registró que `--dry-run` muestra una credencial temporal). Estas reglas salen del `--help` de la CLI y de su
documentación; **el comportamiento no se ha ejecutado contra Production**: la salvaguarda es la lista que la CLI muestra antes de pedir confirmación (paso 7).

## Procedimiento (lo ejecuta el propietario)

Requisitos: `psql`, `pg_dump`, `pg_restore` en `PATH` (cliente instalado en `%USERPROFILE%\pgclient`), `supabase` CLI con sesión iniciada, y la cadena de
conexión _Session pooler_ de Production en un archivo **fuera del repo** (`$Conn`). Nada de esto imprime la contraseña.

```powershell
cd C:\Dev\upmina-web
$Conn = "C:\ruta\privada\prod.conn"

# 1. Verificar destino e historial (solo lectura, sin dump). Debe terminar con "Destino y historial verificados ... última 20261118120000".
powershell -File scripts\backup-production.ps1 -ConnFile $Conn -CheckOnly

# 2. Respaldo real (pg_dump). Guarda en %USERPROFILE%\upmina-backups\prod-<fecha>. Falla si el volcado queda vacío/ilegible o TOC != COPY.
powershell -File scripts\backup-production.ps1 -ConnFile $Conn
#    Anota la carpeta impresa ("Respaldo en: ...") como $B

# 3. Checks previos. CUALQUIER FAIL ⇒ detenerse (no aplicar nada). Guarda la salida junto al respaldo.
powershell -File scripts\production-readonly-sql.ps1 -ConnFile $Conn -SqlFile scripts\sql\production-migration-preflight.sql -OutFile "$B\preflight.txt"
powershell -File scripts\production-readonly-sql.ps1 -ConnFile $Conn -SqlFile scripts\sql\production-definitions-snapshot.sql -OutFile "$B\definitions-before.txt"

# 4. Directorio aislado (65 de historial + 5; sin shadow). Muestra los SHA-256 de las 5.
powershell -File scripts\prepare-production-migration-workdir.ps1 -OutDir C:\Dev\_prod-migrate-workdir

# 5. Enlazar SOLO ese directorio a Production (no toca el repo)
Set-Location C:\Dev\_prod-migrate-workdir
supabase link --project-ref dmtuvzfdaectvqczwfhx          # pedirá la contraseña de la base; no usar variables en el historial

# 6. Lista de pendientes (solo lectura): deben salir Local+Remote para las 65 anteriores y SOLO Local para las 5.
supabase migration list --linked

# 7. Aplicar. La CLI mostrará la lista de migraciones a aplicar: debe ser EXACTAMENTE las 5 (119, 120, 121, 127, 128). Si no, responde N.
supabase db push --linked --skip-vault

# 8. Checks posteriores. Debe haber 0 FAIL y los INFO de datos iguales a los del preflight.
Set-Location C:\Dev\upmina-web
powershell -File scripts\production-readonly-sql.ps1 -ConnFile $Conn -SqlFile scripts\sql\production-migration-postflight.sql -OutFile "$B\postflight.txt"
```

**Desplegar el código justo después del paso 8.** Entre la 19 y el despliegue nuevo, el código vivo (`d8ef593`) no conoce el error `media_required`:
crear una publicación sin archivos daría un error genérico (no hay otra consecuencia).

## Verificaciones previas (resumen de `production-migration-preflight.sql`)

Historial: última `20261118120000`, contiene 17 y 18, contiene `20261113`–`20261116`, 65 versiones, ninguna ≥ `20261119`. Objetos nuevos y shadow ausentes.
Huellas `md5(replace(prosrc, chr(13), ''))` de las 9 funciones que se sobrescriben iguales al baseline (si una difiere ⇒ hay deriva ⇒ **detenerse**).
`community_posts_status_check` sin `held_for_review`; `moderation_audit_log_action_check` sin acciones `content_*`. Sin eliminaciones en curso. Todas las tablas
con RLS; ninguna `SECURITY DEFINER` sin `search_path`; cron solo `community-media-purge-tick`; sin cron de eliminación; extensiones `pg_cron`/`pg_net`.
INFO: publicaciones por estado, recuentos de datos, solicitudes de eliminación, nombres del Vault.

## Recuperación

**Conservar el respaldo:** no borrar `prod-<fecha>`; copiar la carpeta completa (`prod.dump`, `schema-public.sql`, `row-counts.csv`, `SHA256SUMS.txt`,
`MANIFEST.txt`, `preflight.txt`, `definitions-before.txt`) a un segundo soporte y verificar el SHA-256. Production no tiene backups ni PITR: este dump es el único punto de restauración.

**Qué revertir y cómo (en orden inverso, solo si hay un problema real):**

1. `20261128`: `supabase/rollbacks/20261128120000_account_deletion_developer_recovery.rollback.sql` (restaura `account_deletion_developer_retry`, borra 2 funciones).
2. `20261127`: `supabase/rollbacks/20261127120000_account_deletion_completion_notices.rollback.sql` (restaura `account_deletion_backlog()`, borra funciones y la tabla de avisos; solo se pierden avisos).
3. `20261121`, `20261120`, `20261119`: **no tienen rollback**. Corrección hacia delante: reaplicar las definiciones de `definitions-before.txt`
   (fuente: `20261024120000` para las 4 funciones de publicaciones, `20261019` delivery_state, `20261026` sweep/discard) y las restricciones previas
   (`community_posts_status_check` de `20261015`, `moderation_audit_log_action_check` de `20261110`). Antes, comprobar que no existan publicaciones `held_for_review`, ediciones pendientes ni auditoría
   `content_*`: de haberlas, no se pueden restringir sin tratarlas primero. Las tablas nuevas de ediciones pendientes no se borran si contienen datos.
4. Después de cualquier reversión manual **no** se usa `migration repair` sin analizar: el historial de Production debe quedar reflejando lo que realmente está aplicado.

**Restaurar el dump (último recurso):** `pg_restore` sobre una base nueva o un proyecto de prueba primero; restaurar sobre Production solo con decisión explícita.
**Para no perder datos posteriores al respaldo:** antes de restaurar, volcar el estado actual (`pg_dump -Fc` adicional) y reimportar las tablas de datos
que hayan cambiado (`community_*`, `media_assets`, `account_deletion_*`, `profiles`, `auth.users`). Hoy hay muy poco tráfico (1 usuario), lo que reduce el riesgo,
pero la ventana entre el respaldo y la migración debe ser corta. Preferir siempre la corrección hacia delante a la restauración.

## Historial y las migraciones shadow

Al omitir 22–26 el historial de Production queda distinto al de DEV. Si algún día se aplican, tendrán versión menor que la última remota (`20261128`) y la CLI exigirá
`--include-all` (decisión consciente, tras revisar su configuración «fijada a DEV» en `20261122`). DEV registró DEL-4 y DEL-4b con versiones `20261018…`
(aplicadas por el conector): ese desajuste de DEV se corrige aparte, **nunca** automáticamente.

## Condiciones para autorizar la publicación

1. Pasos 1–3 sin `FAIL` y respaldo verificado y copiado.
2. La lista del paso 6/7 es exactamente las 5 migraciones.
3. Aprobación explícita de aplicar las 5 y de las variables (`ACCOUNT_DELETION_*`, `MFA_RECOVERY_*`, `COPYRIGHT_APPEAL_APP_URL` con valor `https://upminaa-web.com`; sin copiar secretos de DEV).
4. Decidido el momento del código (merge/push a `main` despliega Production automáticamente) y del Worker de Production.
5. Postflight sin `FAIL` antes de desplegar el código.

## Registro de aplicación (2026-10-18)

| Campo                  | Valor                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fecha UTC              | 2026-10-18 (aplicación después del respaldo de las 22:00 UTC)                                                                                                                                                                                                                                                                         |
| Proyecto               | `dmtuvzfdaectvqczwfhx` (Production); directorio aislado enlazado solo a ese proyecto, el enlace del repo (DEV) no se tocó                                                                                                                                                                                                             |
| Respaldo PRE-MIGRATION | `C:\Users\Edwin\upmina-backups\prod-20261018-215831Z-PRE-MIGRATION` y copia en `D:\Upminaa-Backups\prod-20261018-215831Z-PRE-MIGRATION`; `prod.dump` SHA-256 `DEB0EDF9…1A6A8A` igual en ambas (verificado de nuevo antes de aplicar)                                                                                                  |
| Preflight previo       | PASS, 0 FAIL; historial 65 versiones, última `20261118120000`; huellas de las 9 funciones iguales al baseline                                                                                                                                                                                                                         |
| Antes de aplicar       | `supabase migration list --linked`: 65 con Local y Remote, y solo Local para `20261119`, `20261120`, `20261121`, `20261127`, `20261128`                                                                                                                                                                                               |
| Comando                | `supabase db push --linked --skip-vault --workdir <aislado>` (CLI 2.121.0)                                                                                                                                                                                                                                                            |
| Resultado de la CLI    | `Finished supabase db push.` Aplicó exactamente las 5 migraciones autorizadas, en orden: `20261119120000_community_media_required`, `20261120120000_held_for_review_pending_edits`, `20261121120000_content_review_queue`, `20261127120000_account_deletion_completion_notices`, `20261128120000_account_deletion_developer_recovery` |
| Historial final        | 70 versiones, registradas con las versiones exactas de los archivos (sin `migration repair`); última `20261128120000`                                                                                                                                                                                                                 |
| Postflight             | PASS, 0 FAIL (20 comprobaciones); evidencia en `C:\Users\Edwin\upmina-backups\evidence-20261018-migrations-applied\postflight.txt`                                                                                                                                                                                                    |
| Datos                  | Sin cambios: users=2, profiles=2, posts=0, assets=5, admin_roles=2; 0 solicitudes de eliminación, 0 avisos, 0 ediciones pendientes                                                                                                                                                                                                    |
| Cron / Vault           | Cron: solo `community-media-purge-tick` (`*/5`); ningún cron de eliminación. Vault: mismos 4 nombres de antes (`account_deletion_endpoint_url`, `account_deletion_shared_secret`, `media_gc_endpoint_url`, `media_gc_shared_secret`); no se modificó                                                                                  |
| Aplazadas a propósito  | `20261122`–`20261126` (community_shadow\_\*): no están en el directorio aislado ni en el historial                                                                                                                                                                                                                                    |
| Worker / web           | Sin desplegar: el Worker de Production y el despliegue de Vercel siguen como antes                                                                                                                                                                                                                                                    |

### Incidencia (a corregir en el procedimiento)

El paso 7 de este runbook supone que la CLI muestra la lista y pide confirmación. Ejecutada sin terminal interactiva (`"n" | supabase db push …`), la CLI **no preguntó y aplicó
directamente** (salida en formato JSON, sin prompt). No hubo daño: las migraciones aplicadas fueron exactamente las 5 autorizadas, porque la lista de pendientes ya se había
comprobado con `supabase migration list --linked` y el directorio aislado solo contenía esas 5 sobre el historial. Lección: la salvaguarda real es el directorio aislado
más `migration list`, no el aviso de confirmación; en una sesión no interactiva la CLI no pide confirmación ni se puede abortar con «n».
Aviso adicional: el repo (`C:\Dev\upmina-web`) sigue enlazado a DEV; nunca ejecutar `db push` desde él para Production.
