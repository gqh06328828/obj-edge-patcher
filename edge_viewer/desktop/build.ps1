$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspace = [IO.Path]::GetFullPath((Join-Path $sourceRoot '..'))
$outputRoot = Join-Path $workspace 'EdgeScope-Windows'
$archive = Join-Path $sourceRoot 'build-cache/electron-v44.3.0-win32-x64.zip'
$checksumFile = Join-Path $sourceRoot 'build-cache/SHASUMS256.txt'
$expected = ((Get-Content -LiteralPath $checksumFile | Where-Object { $_ -match '\s\*?electron-v44\.3\.0-win32-x64\.zip$' }) -split '\s+')[0]
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if (-not $expected -or $actual -ne $expected) { throw 'Electron archive SHA256 verification failed.' }
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $outputRoot 'EdgeScope.exe'))) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $outputRoot)
  Rename-Item -LiteralPath (Join-Path $outputRoot 'electron.exe') -NewName 'EdgeScope.exe'
}
$appRoot = Join-Path $outputRoot 'resources/app'
New-Item -ItemType Directory -Force -Path $appRoot,(Join-Path $appRoot 'desktop') | Out-Null
foreach ($name in @('package.json','index.html','style.css','app.mjs','mesh-data.mjs','step-view.mjs','step-panel.mjs','view-settings.mjs','patch-edit.mjs','step-worker.js','model-pairs.mjs')) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination $appRoot -Force
}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'vendor') -Destination $appRoot -Recurse -Force
foreach ($name in @('main.cjs','preload.cjs','readout-results.cjs','merged-export.mjs')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $appRoot 'desktop') -Force
}
Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.txt' | Copy-Item -Destination $outputRoot -Force
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcut = $shortcutShell.CreateShortcut((Join-Path $workspace 'EdgeScope.lnk'))
$shortcut.TargetPath = Join-Path $outputRoot 'EdgeScope.exe'
$shortcut.WorkingDirectory = $outputRoot
$shortcut.Description = 'EdgeScope - 3D edge probability viewer'
$shortcut.Save()
Write-Output ('Built: ' + (Join-Path $outputRoot 'EdgeScope.exe'))
if (Test-Path -LiteralPath (Join-Path $workspace 'readout/geometry_readout.py')) {
  & (Join-Path $PSScriptRoot 'build-readout.ps1')
}
