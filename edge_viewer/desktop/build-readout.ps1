$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspace = [IO.Path]::GetFullPath((Join-Path $sourceRoot '..'))
$resources = Join-Path $workspace 'EdgeScope-Windows/resources'
$runtimeSource = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python'
$runtimeTarget = Join-Path $resources 'python'
if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource 'python.exe'))) { throw 'Bundled Python runtime not found.' }
New-Item -ItemType Directory -Force -Path $runtimeTarget,(Join-Path $runtimeTarget 'Lib'),(Join-Path $runtimeTarget 'Lib/site-packages'),(Join-Path $resources 'readout') | Out-Null
foreach ($file in @('python.exe','python3.dll','python312.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt')) {
  Copy-Item -LiteralPath (Join-Path $runtimeSource $file) -Destination $runtimeTarget -Force
}
Copy-Item -LiteralPath (Join-Path $runtimeSource 'DLLs') -Destination $runtimeTarget -Recurse -Force
Get-ChildItem -LiteralPath (Join-Path $runtimeSource 'Lib') | Where-Object { $_.Name -notin @('site-packages','test','idlelib','tkinter','turtledemo','ensurepip','__pycache__') } | Copy-Item -Destination (Join-Path $runtimeTarget 'Lib') -Recurse -Force
Get-ChildItem -LiteralPath (Join-Path $runtimeSource 'Lib/site-packages') | Where-Object { $_.Name -eq 'numpy' -or $_.Name -eq 'numpy.libs' -or $_.Name -like 'numpy-*.dist-info' } | Copy-Item -Destination (Join-Path $runtimeTarget 'Lib/site-packages') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $workspace 'readout/geometry_readout.py') -Destination (Join-Path $resources 'readout') -Force
& (Join-Path $runtimeTarget 'python.exe') -c 'import numpy; print(numpy.__version__)'
if ($LASTEXITCODE -ne 0) { throw 'Readout runtime verification failed.' }
