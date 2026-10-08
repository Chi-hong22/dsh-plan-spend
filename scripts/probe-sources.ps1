# 一次性探针：验证用量数据源是否真实可用。
# 只从凭据库读取密钥，绝不打印密钥本身；输出仅保留响应状态与响应体。
$ErrorActionPreference = 'Stop'

$store = Join-Path $env:DSH_HOME '.credentials.yaml'
$raw = Get-Content $store -Encoding UTF8 -Raw

function Get-Ref([string] $name) {
  $m = [regex]::Match($raw, "(?m)^\s+$name`:\s*(\S+)\s*$")
  if (-not $m.Success) { throw "credential ref not found: $name" }
  return $m.Groups[1].Value
}

$deepseekKey = Get-Ref 'DEEPSEEK_API_KEY'
$opencodeKey = Get-Ref 'OPENCODEGO_API_KEY'

Write-Output "== DeepSeek official balance =="
try {
  $r = Invoke-RestMethod -Uri 'https://api.deepseek.com/user/balance' `
    -Headers @{ Authorization = "Bearer $deepseekKey" } -TimeoutSec 25
  Write-Output ('HTTP OK; body = ' + ($r | ConvertTo-Json -Depth 6 -Compress))
} catch {
  Write-Output ('FAILED: ' + $_.Exception.Message)
}

Write-Output ''
Write-Output "== OpenCode Go usage (no session header) =="
try {
  $r = Invoke-RestMethod -Uri 'https://opencode.ai/zen/go/v1/usage' `
    -Headers @{ Authorization = "Bearer $opencodeKey" } -TimeoutSec 25
  Write-Output ('HTTP OK; body = ' + ($r | ConvertTo-Json -Depth 6 -Compress))
} catch {
  Write-Output ('FAILED: ' + $_.Exception.Message)
}

Write-Output ''
Write-Output "== OpenCode Go usage (with x-opencode-session) =="
try {
  $r = Invoke-RestMethod -Uri 'https://opencode.ai/zen/go/v1/usage' `
    -Headers @{ Authorization = "Bearer $opencodeKey"; 'x-opencode-session' = 'dsh-plan-spend' } -TimeoutSec 25
  Write-Output ('HTTP OK; body = ' + ($r | ConvertTo-Json -Depth 6 -Compress))
} catch {
  Write-Output ('FAILED: ' + $_.Exception.Message)
}
