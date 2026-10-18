<#
  Respaldo de SOLO LECTURA de Supabase Production (pg_dump). NO se ha ejecutado todavía.
  Requisitos: pg_dump/pg_restore/psql en PATH (ver docs/PRODUCTION-INFRA-RUNBOOK.md) y un archivo con la cadena de conexión
  de Production FUERA del repo (una sola línea, la que ofrece Supabase > Connect > Session pooler):
      postgresql://postgres.dmtuvzfdaectvqczwfhx:<PASSWORD>@aws-0-us-west-2.pooler.supabase.com:5432/postgres
  Uso:  powershell -File scripts/backup-production.ps1 -ConnFile C:\ruta\privada\prod.conn [-CheckOnly]
  -CheckOnly: solo verifica el destino y el historial de migraciones (solo lectura, sin pg_dump). Úsalo antes del respaldo real.
  Historial esperado: EXACTAMENTE las versiones de los archivos de supabase/migrations con versión <= -ExpectedLastVersion
  (hoy 20261118120000). Cualquier versión de más, de menos o posterior ABORTA: no se respalda un estado que no se conoce.
  Seguridad: la contraseña solo vive en variables de entorno del proceso; nunca se imprime ni se escribe en logs.
  Se aborta si el usuario/host no corresponden EXACTAMENTE a Production. La salida no contiene datos personales.
#>
param(
  [Parameter(Mandatory = $true)][string]$ConnFile,
  [string]$OutRoot = "$env:USERPROFILE\upmina-backups",
  [string]$ExpectedLastVersion = "20261118120000",
  [switch]$CheckOnly,
  [string]$Label = ""
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

# Toda consulta de psql se ejecuta con la sesión en solo lectura (el pooler ignora PGOPTIONS, por eso se fija con SET).
function Invoke-Ro([string]$Sql) {
  $out = & psql -X -A -t -c ("set default_transaction_read_only = on; " + $Sql)
  if ($LASTEXITCODE -ne 0) { throw "psql falló (código $LASTEXITCODE)." }
  $out | Where-Object { $_ -ne "SET" -and $_ -ne "" }  # psql también devuelve la línea del SET
}
try {
  # 0. Comprobación del destino efectivo (solo metadatos, sin datos de usuario).
  $meta = Invoke-Ro "select current_database()||'|'||split_part(version(),',',1)||'|'||(select count(*) from auth.users)||'|'||(select count(*) from supabase_migrations.schema_migrations)"
  $m = (($meta | Where-Object { $_ -match '\|' }) | Select-Object -Last 1).Trim().Split('|')

  # 0b. Historial de migraciones: debe ser EXACTAMENTE el esperado (ni una versión de más ni de menos).
  $localDir = Join-Path $PSScriptRoot "..\supabase\migrations"
  if (-not (Test-Path $localDir)) { throw "No se encuentra supabase/migrations junto al script." }
  $expected = @(Get-ChildItem $localDir -Filter *.sql | ForEach-Object { ($_.Name -split '_')[0] } |
    Where-Object { [string]::CompareOrdinal($_, $ExpectedLastVersion) -le 0 } | Sort-Object -Unique)
  $remote = @(Invoke-Ro "select version from supabase_migrations.schema_migrations order by version" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d{14}$' } | Sort-Object -Unique)
  if ($remote.Count -eq 0) { throw "No se pudo leer el historial de migraciones. Abortado." }
  if ($remote[-1] -ne $ExpectedLastVersion) { throw "Última versión remota $($remote[-1]) distinta de la esperada $ExpectedLastVersion. Abortado." }
  $unexpected = @($remote | Where-Object { $expected -notcontains $_ })
  $missing = @($expected | Where-Object { $remote -notcontains $_ })
  if ($unexpected.Count -gt 0) { throw "Migraciones remotas inesperadas (sin archivo local o posteriores): $($unexpected -join ', '). Abortado." }
  if ($missing.Count -gt 0) { throw "Migraciones esperadas que NO están aplicadas en Production: $($missing -join ', '). Abortado." }
  if ($m[3] -ne [string]$expected.Count) { throw "El recuento del historial ($($m[3])) no coincide con el esperado ($($expected.Count)). Abortado." }
  "Destino y historial verificados: proyecto $ProdRef, $($expected.Count) migraciones, última $ExpectedLastVersion."
  if ($CheckOnly) { return }

  # Nombre único: Production + fecha/hora UTC + etiqueta (p. ej. PRE-MIGRATION). Nunca se reutiliza ni sobrescribe una carpeta existente.
  $ts = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss") + "Z"
  $name = "prod-$ts" + $(if ($Label) { "-" + ($Label -replace '[^A-Za-z0-9_-]', '') } else { "" })
  $d = Join-Path $OutRoot $name
  if (Test-Path $d) { throw "La carpeta de respaldo $d ya existe. Abortado (no se sobrescribe)." }
  New-Item -ItemType Directory -Path $d | Out-Null
  icacls $d /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null

  # 1. Volcado lógico completo de los esquemas de aplicación (formato custom, comprimido; datos + esquema + ACL/owners).
  & pg_dump -Fc --no-comments --schema=public --schema=auth --schema=storage --schema=supabase_migrations -f "$d\prod.dump"
  if ($LASTEXITCODE -ne 0) { throw "pg_dump falló (código $LASTEXITCODE)." }
  if (-not (Test-Path "$d\prod.dump") -or (Get-Item "$d\prod.dump").Length -lt 10240) { throw "El volcado no existe o está vacío/truncado. Abortado." }
  # 2. Copia en texto del esquema (revisable) y de roles visibles.
  & pg_dump -s --no-comments --schema=public -f "$d\schema-public.sql"
  & pg_dumpall --roles-only -f "$d\roles.sql" 2>$null  # puede no estar permitido en Supabase administrado: no es fatal

  # 3. Verificación: TOC legible, secciones esperadas y recuentos de filas (sin mostrar datos).
  $toc = & pg_restore -l "$d\prod.dump"
  if ($LASTEXITCODE -ne 0 -or -not $toc) { throw "pg_restore no puede leer el volcado. Abortado." }
  if (-not ($toc | Where-Object { $_ -match "schema_migrations" })) { throw "El volcado no contiene supabase_migrations.schema_migrations. Abortado." }
  $dataEntries = ($toc | Where-Object { $_ -match "TABLE DATA" }).Count
  $tables = (Invoke-Ro "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','storage','supabase_migrations') and c.relkind='r'" | Select-Object -Last 1)
  $exact = @()
  foreach ($t in (Invoke-Ro "select tablename from pg_tables where schemaname='public' order by 1")) {
    $exact += "public.$t," + (Invoke-Ro "select count(*) from public.""$t""")
  }
  $exact += "auth.users," + (Invoke-Ro "select count(*) from auth.users")
  $exact += "supabase_migrations.schema_migrations," + (Invoke-Ro "select count(*) from supabase_migrations.schema_migrations")
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
  if ($dataEntries -ne $copyBlocks) { throw "TOC ($dataEntries) y COPY ($copyBlocks) no coinciden: el respaldo NO es fiable. Revisar antes de migrar." }
}
finally {
  Remove-Item Env:PGPASSWORD, Env:PGUSER, Env:PGHOST -ErrorAction SilentlyContinue
}
