<#
  Ejecuta un archivo SQL de SOLO LECTURA contra Supabase Production (psql) y muestra su salida. Pensado para
  scripts/sql/production-migration-preflight.sql, scripts/sql/production-migration-postflight.sql y
  scripts/sql/production-definitions-snapshot.sql.
  Requisitos: psql en PATH y un archivo con la cadena de conexión de Production FUERA del repo (una línea; ver
  scripts/backup-production.ps1). La contraseña solo vive en variables de entorno del proceso y nunca se imprime.
  Uso:  powershell -File scripts/production-readonly-sql.ps1 -ConnFile C:\ruta\privada\prod.conn -SqlFile scripts\sql\production-migration-preflight.sql [-OutFile C:\ruta\salida.txt]
  Seguridad: se aborta si la conexión no corresponde EXACTAMENTE a Production o apunta a DEV; el archivo SQL no puede contener
  sentencias que no sean SELECT/WITH/SET default_transaction_read_only (se comprueba antes de conectar); la sesión se fija en solo lectura.
  Código de salida distinto de 0 si algún check devuelve FAIL (cuando el archivo es un preflight/postflight).
#>
param(
  [Parameter(Mandatory = $true)][string]$ConnFile,
  [Parameter(Mandatory = $true)][string]$SqlFile,
  [string]$OutFile
)
$ErrorActionPreference = "Stop"
$ProdRef = "dmtuvzfdaectvqczwfhx"
$DevRef = "rkqeqbqwdswhpzwqptac"

if (-not (Test-Path $SqlFile)) { throw "No existe $SqlFile" }
# 1. El SQL debe ser de lectura: se quitan comentarios y literales y no puede quedar ninguna sentencia de escritura/DDL.
$sql = Get-Content -Raw -Path $SqlFile
$code = ($sql -split "`n" | Where-Object { $_.Trim() -notmatch '^--' }) -join "`n"
$noLiterals = [regex]::Replace($code, "'(?:[^']|'')*'", "''")
if ($noLiterals -match '(?i)\b(insert\s+into|update\s+\S+\s+set|delete\s+from|truncate\b|drop\s|alter\s|create\s|grant\s|revoke\s|copy\s|call\s|do\s+\$|vacuum\b|reindex\b|cluster\b|comment\s+on)') { throw "El SQL contiene sentencias que no son de lectura. Abortado." }

# 2. Conexión: debe ser Production y nunca DEV.
$conn = (Get-Content -Raw -Path $ConnFile).Trim()
if ($conn -notmatch '^postgres(?:ql)?://(?<u>[^:@/]+):(?<p>[^@]+)@(?<h>[^:/]+):(?<port>\d+)/(?<db>[^?\s]+)') { throw "Formato de conexión no reconocido." }
$u = $Matches.u; $pw = [System.Uri]::UnescapeDataString($Matches.p); $h = $Matches.h; $port = $Matches.port; $db = $Matches.db
if ($conn -like "*$DevRef*") { throw "La conexión apunta a DEV. Abortado." }
if (-not ($u -eq "postgres.$ProdRef" -or ($u -eq "postgres" -and $h -eq "db.$ProdRef.supabase.co"))) { throw "Usuario/host no corresponden a Production ($ProdRef). Abortado." }
$env:PGHOST = $h; $env:PGPORT = $port; $env:PGUSER = $u; $env:PGPASSWORD = $pw; $env:PGDATABASE = $db; $env:PGSSLMODE = "require"
Remove-Variable pw, conn -ErrorAction SilentlyContinue
try {
  $out = & psql -X -A -t -F "|" -v ON_ERROR_STOP=1 -c "set default_transaction_read_only = on" -f $SqlFile 2>&1
  if ($LASTEXITCODE -ne 0) { throw "psql falló (código $LASTEXITCODE)." }
  $lines = @($out | Where-Object { $_ -and $_ -ne "SET" })
  if ($OutFile) { $lines | Set-Content -Path $OutFile -Encoding UTF8 }
  $lines
  $fails = @($lines | Where-Object { $_ -match '\|FAIL(\||$)' })
  if ($fails.Count -gt 0) { Write-Error "$($fails.Count) check(s) en FAIL: DETENERSE y no aplicar nada."; exit 2 }
}
finally {
  Remove-Item Env:PGPASSWORD, Env:PGUSER, Env:PGHOST -ErrorAction SilentlyContinue
}
