$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw '需要安装 Node.js 后再启动。' }
$ready = $false
try { $response = Invoke-WebRequest 'http://127.0.0.1:8765/api/models' -TimeoutSec 2; $ready = $response.StatusCode -eq 200 } catch {}
if (-not $ready) {
  Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.cjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
  Start-Sleep -Seconds 1
}
Start-Process 'http://127.0.0.1:8765'
