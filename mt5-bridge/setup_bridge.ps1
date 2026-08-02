$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function New-RandomHex([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToHexString($buffer).ToLowerInvariant()
}

if (Test-Path ".env") {
  Write-Host ".env already exists. No credentials were overwritten." -ForegroundColor Yellow
  exit 0
}

$template = Get-Content ".env.example" -Raw
$apiKey = New-RandomHex 32
$secret = New-RandomHex 32

$template = $template.Replace(
  "BRIDGE_API_KEY=replace-with-at-least-32-random-characters",
  "BRIDGE_API_KEY=$apiKey"
)
$template = $template.Replace(
  "BRIDGE_SECRET=replace-with-at-least-32-random-characters",
  "BRIDGE_SECRET=$secret"
)

Set-Content -Path ".env" -Value $template -Encoding UTF8

Write-Host "Created mt5-bridge\.env with unique bridge credentials." -ForegroundColor Green
Write-Host "Now edit MT5_LOGIN, MT5_PASSWORD, MT5_SERVER, and MT5_TERMINAL_PATH." -ForegroundColor Cyan
Write-Host "Do not commit .env to GitHub." -ForegroundColor Yellow
