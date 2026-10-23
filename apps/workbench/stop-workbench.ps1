$ErrorActionPreference = 'Stop'
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2
} catch { Write-Host '创作者实验台当前没有运行。'; exit 0 }
if (-not $health.ok -or $health.mode -ne 'owner' -or $health.upstreamCommit -ne '5e8fb6ffb8a0f67f8456348ee08932c93e93abf5') {
  throw '该端口不是当前创作者实验台，未执行停止操作。'
}
Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/shutdown' -Method Post -ContentType 'application/json' -Body '{}' | Out-Null
Write-Host '已请求停止，正在等待任务退出和临时资料清理。'
Write-Host '已保存的作品、稿件与预测记录会保留。'
