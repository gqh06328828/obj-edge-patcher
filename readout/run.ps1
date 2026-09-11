param(
  [Parameter(Mandatory=$true)][string]$Mesh,
  [Parameter(Mandatory=$true)][string]$Probabilities,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$MinFaces = 80,
  [double]$MinArea = 0.0004
)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if (-not (Test-Path -LiteralPath $runtime)) {
  $runtimeCommand = Get-Command python -ErrorAction Stop
  $runtime = $runtimeCommand.Source
}
& $runtime (Join-Path $PSScriptRoot 'geometry_readout.py') --mesh $Mesh --probabilities $Probabilities --out $Out --min-faces $MinFaces --min-area $MinArea
exit $LASTEXITCODE
