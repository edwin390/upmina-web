<#
  Prepara, SOLO EN LOCAL, el directorio aislado desde el que se aplican en Production ÚNICAMENTE las 5 migraciones finales
  (20261119, 20261120, 20261121, 20261127, 20261128). No se conecta a ninguna base, no usa credenciales y no modifica el repo.

  El directorio contiene supabase/migrations con: las migraciones hasta 20261118120000 (el historial que Production ya tiene,
  imprescindible para que la CLI no vea "versiones remotas sin archivo local") + las 5 seleccionadas. NO incluye las
  community_shadow_* (20261122 a 20261126) ni ningún otro archivo. Escribe además un config.toml mínimo SIN [db.vault], para que
  `supabase db push` no toque secretos del Vault.

  Uso:  powershell -File scripts/prepare-production-migration-workdir.ps1 [-OutDir C:\Dev\_prod-migrate-workdir]
  Aborta si OutDir ya existe y no está vacío (no se sobrescribe nada).
#>
param([string]$OutDir = "C:\Dev\_prod-migrate-workdir")
$ErrorActionPreference = "Stop"

$LastBaseline = "20261118120000"
$Selected = @("20261119120000", "20261120120000", "20261121120000", "20261127120000", "20261128120000")
$Excluded = @("20261122120000", "20261123120000", "20261124120000", "20261125120000", "20261126120000")

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$src = Join-Path $repo "supabase\migrations"
if (-not (Test-Path $src)) { throw "No se encuentra $src" }
if ((Test-Path $OutDir) -and (Get-ChildItem $OutDir -Force | Select-Object -First 1)) { throw "$OutDir ya existe y no está vacío. Abortado (no se sobrescribe)." }

$all = Get-ChildItem $src -Filter *.sql | Sort-Object Name
function Ver($f) { ($f.Name -split '_')[0] }
$baseline = @($all | Where-Object { [string]::CompareOrdinal((Ver $_), $LastBaseline) -le 0 })
$picked = @($all | Where-Object { $Selected -contains (Ver $_) })
if ($picked.Count -ne $Selected.Count) { throw "Faltan archivos de las migraciones seleccionadas en el repo." }
foreach ($e in $Excluded) { if ($picked | Where-Object { (Ver $_) -eq $e }) { throw "Una migración shadow ($e) está en la selección. Abortado." } }
if ($baseline.Count -ne 65) { throw "Se esperaban 65 migraciones hasta $LastBaseline y hay $($baseline.Count). Abortado." }

$dst = Join-Path $OutDir "supabase\migrations"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
foreach ($f in ($baseline + $picked)) { Copy-Item $f.FullName (Join-Path $dst $f.Name) }
# config.toml mínimo: sin [db.vault] ni seed. project_id es solo una etiqueta local.
[System.IO.File]::WriteAllText((Join-Path $OutDir "supabase\config.toml"), "project_id = `"upmina-prod-migrate`"`n", (New-Object System.Text.UTF8Encoding($false)))

# Verificación del resultado: 70 archivos, ninguna shadow, y los 5 idénticos byte a byte a los del repo.
$out = @(Get-ChildItem $dst -Filter *.sql | Sort-Object Name)
if ($out.Count -ne 70) { throw "El directorio generado debe tener 70 migraciones y tiene $($out.Count)." }
foreach ($e in $Excluded) { if ($out | Where-Object { (Ver $_) -eq $e }) { throw "Shadow $e presente en el directorio generado." } }
$manifest = foreach ($v in $Selected) {
  $o = $out | Where-Object { (Ver $_) -eq $v }
  $r = $all | Where-Object { (Ver $_) -eq $v }
  $h1 = (Get-FileHash $o.FullName -Algorithm SHA256).Hash
  if ($h1 -ne (Get-FileHash $r.FullName -Algorithm SHA256).Hash) { throw "$($o.Name) difiere del repo." }
  "{0}  {1}" -f $h1, $o.Name
}
$manifest | Set-Content (Join-Path $OutDir "SELECTED-SHA256.txt")
"Directorio listo: $OutDir"
"Migraciones: $($out.Count) (65 de historial + 5 seleccionadas). Shadow excluidas: $($Excluded -join ', ')."
$manifest
