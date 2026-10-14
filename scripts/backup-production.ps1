<#
  Respaldo de SOLO LECTURA de Supabase Production (pg_dump). NO se ha ejecutado todavía.
  Requisitos: pg_dump/pg_restore/psql en PATH (ver docs/PRODUCTION-INFRA-RUNBOOK.md) y un archivo con la cadena de conexión
  de Production FUERA del repo (una sola línea, la que ofrece Supabase > Connect > Session pooler):
      postgresql://postgres.dmtuvzfdaectvqczwfhx:<PASSWORD>@aws-0-us-west-2.pooler.supabase.com:5432/postgres
  Uso:  powershell -File scripts/backup-production.ps1 -ConnFile C:\ruta\privada\prod.conn
  Seguridad: la contraseña solo vive en variables de entorno del proceso; nunca se imprime ni se escribe en logs.
  Se aborta si el usuario/host no corresponden EXACTAMENTE a Production. La salida no contiene datos personales.
#>
param(
  [Parameter(Mandatory = $true)][string]$ConnFile,
  [string]$OutRoot = "$env:USERPROFILE\upmina-backups"
)
$ErrorActionPreference = "Stop"
$ProdRef = "dmtuvzfdaectvqczwfhx"
$DevRef = "rkqeqbqwdswhpzwqptac"

$conn = (Get-Content -Raw -Path $ConnFile).Trim()
if ($conn -notmatch '^postgres(?:ql)?://(?<u>[^:@/]+):(?<p>[^@]+)@(?<h>[^:/]+):(?<port>\d+)/(?<db>[^?\s]+)') { throw "Formato de conexión no reconocido." }
$u = $Matches.u; $pw = [System.Uri]::UnescapeDataString($Matches.p); $h = $Matches.h; $port = $Matches.port; $db = $Matches.db
if ($conn -like "*$DevRef*") { throw "La conexión apunta a DEV. Abortado." }
if (-not ($u -eq "postgres.$ProdRef" -or ($u -eq "postgres" -and $h -eq "db.$ProdRef.supabase.co"))) { throw "Usuario/host no corresponden a Production ($ProdRef). Abortado." }

$env:PGHOST = $h; $env:PGPORT = $port; $env:PGUSER = $u; $env:PGPASSWORD = $pw; $env:PGDATABASE = $db; $env:PGSSLMODE = "require"
Remove-Variable pw, conn -ErrorAction SilentlyContinue
try {
  # 0. Comprobación del destino efectivo (solo metadatos, sin datos de usuario).
  $meta = & psql -X -A -t -c "select current_database()||'|'||split_part(version(),',',1)||'|'||(select count(*) from auth.users)||'|'||(select count(*) from supabase_migrations.schema_migrations)"
  $m = $meta.Trim().Split('|')
  if ($m[3] -ne "21") { throw "El historial de migraciones no es el esperado de Production (21 aplicadas); encontrado: $($m[3]). Abortado." }

  $ts = Get-Date -Format "yyyyMMdd-HHmmss"
  $d = Join-Path $OutRoot "prod-$ts"
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  icacls $d /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null

  # 1. Volcado lógico completo de los esquemas de aplicación (formato custom, comprimido; datos + esquema + ACL/owners).
  & pg_dump -Fc --no-comments --schema=public --schema=auth --schema=storage --schema=supabase_migrations -f "$d\prod.dump"
  if ($LASTEXITCODE -ne 0) { throw "pg_dump falló (código $LASTEXITCODE)." }
  # 2. Copia en texto del esquema (revisable) y de roles visibles.
  & pg_dump -s --no-comments --schema=public -f "$d\schema-public.sql"
  & pg_dumpall --roles-only -f "$d\roles.sql" 2>$null  # puede no estar permitido en Supabase administrado: no es fatal

  # 3. Verificación: TOC legible, secciones esperadas y recuentos de filas (sin mostrar datos).
  $toc = & pg_restore -l "$d\prod.dump"
  $dataEntries = ($toc | Where-Object { $_ -match "TABLE DATA" }).Count
  $tables = & psql -X -A -t -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','storage','supabase_migrations') and c.relkind='r'"
  $counts = & psql -X -A -t -F "," -c "select 'public.'||relname||','||n_live_tup from pg_stat_user_tables where schemaname='public' order by 1"
  $exact = @()
  foreach ($t in (& psql -X -A -t -c "select tablename from pg_tables where schemaname='public' order by 1")) {
    $exact += "public.$t," + (& psql -X -A -t -c "select count(*) from public.""$t""")
  }
  $exact += "auth.users," + (& psql -X -A -t -c "select count(*) from auth.users")
  $exact += "supabase_migrations.schema_migrations," + (& psql -X -A -t -c "select count(*) from supabase_migrations.schema_migrations")
  $exact | Set-Content "$d\row-counts.csv"

  # 4. Comprobación de restaurabilidad estructural sin base destino: pg_restore genera el SQL completo y se cuentan los COPY.
  $sqlOut = "$d\.restore-check.sql"
  & pg_restore --no-owner --no-privileges -f $sqlOut "$d\prod.dump"
  $copyBlocks = (Select-String -Path $sqlOut -Pattern '^COPY ' ).Count
  Remove-Item $sqlOut -Force

  # 5. Manifiesto SIN datos personales.
  Get-FileHash "$d\*" -Algorithm SHA256 | ForEach-Object { "{0}  {1}  {2} bytes" -f $_.Hash, (Split-Path $_.Path -Leaf), (Get-Item $_.Path).Length } | Set-Content "$d\SHA256SUMS.txt"
  @(
    "fecha_utc=$((Get-Date).ToUniversalTime().ToString('o'))",
    "proyecto=$ProdRef",
    "base_version=$($m[1])",
    "migraciones_aplicadas=$($m[3])",
    "esquemas=public,auth,storage,supabase_migrations",
    "tablas=$tables",
    "toc_table_data=$dataEntries",
    "copy_blocks=$copyBlocks",
    "pg_dump=$((& pg_dump --version))",
    "exclusiones=roles de plataforma, vault/pgsodium, extensions y schemas internos (ver runbook)"
  ) | Set-Content "$d\MANIFEST.txt"
  Get-Content "$d\MANIFEST.txt"
  "Respaldo en: $d"
  if ($dataEntries -ne $copyBlocks) { Write-Warning "TOC y COPY no coinciden: revisar." }
}
finally {
  Remove-Item Env:PGPASSWORD, Env:PGUSER, Env:PGHOST -ErrorAction SilentlyContinue
}
