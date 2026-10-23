param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appDirectory = $PSScriptRoot
$runtimeDirectory = Join-Path $appDirectory '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$bundleNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$nodeCommand = if (Test-Path -LiteralPath $bundleNode) { $bundleNode } else { (Get-Command node -ErrorAction Stop).Source }
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2
  if ($health.ok -and $health.mode -eq 'owner') {
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:4317' }
    Write-Host '创作者实验台已在运行。'
    exit 0
  }
} catch { }
Push-Location $appDirectory
try {
  if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'node_modules/tsx'))) { npm ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' } }
  if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'dist/index.html'))) { npm run build; if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' } }
  $serverProcess = Start-Process -FilePath $nodeCommand -ArgumentList @('--import','tsx','server/index.ts') -WorkingDirectory $appDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDirectory 'server.log') -RedirectStandardError (Join-Path $runtimeDirectory 'server-error.log')
  $serverProcess.Id | Set-Content -LiteralPath (Join-Path $runtimeDirectory 'server.pid') -Encoding utf8
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try { $response = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 1; if ($response.ok) { $ready = $true; break } } catch { }
    if ($serverProcess.HasExited) { break }
  }
  if (-not $ready) { throw ('工作台未启动，请查看 ' + (Join-Path $runtimeDirectory 'server-error.log')) }
  if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:4317' }
  Write-Host '创作者实验台：http://127.0.0.1:4317'
  Write-Host '独立示例空间：http://127.0.0.1:4318'
} finally { Pop-Location }
