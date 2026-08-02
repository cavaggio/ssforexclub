$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
  throw "Missing .env. Run .\setup_bridge.ps1 first."
}

$config = @{}
Get-Content ".env" | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) { return }
  $parts = $line.Split("=", 2)
  if ($parts.Count -eq 2) {
    $config[$parts[0].Trim()] = $parts[1]
  }
}

$required = @(
  "BRIDGE_API_KEY",
  "BRIDGE_SECRET",
  "BRIDGE_INSTANCE_ID",
  "MT5_LOGIN",
  "MT5_SERVER"
)
foreach ($name in $required) {
  if (-not $config[$name]) { throw "Missing $name in .env" }
}

$payload = [ordered]@{
  account = [ordered]@{
    login = $config["MT5_LOGIN"]
    server = $config["MT5_SERVER"]
    terminalId = $config["BRIDGE_INSTANCE_ID"]
  }
  operation = "local_bridge_test"
}
$body = $payload | ConvertTo-Json -Depth 5 -Compress

$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
$nonce = [Guid]::NewGuid().ToString()
$canonical = "$timestamp.$nonce.$body"

$hmac = [System.Security.Cryptography.HMACSHA256]::new(
  [Text.Encoding]::UTF8.GetBytes($config["BRIDGE_SECRET"])
)
try {
  $signatureBytes = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))
  $signature = [Convert]::ToHexString($signatureBytes).ToLowerInvariant()
} finally {
  $hmac.Dispose()
}

$port = if ($config["BRIDGE_PORT"]) { $config["BRIDGE_PORT"] } else { "8787" }
$headers = @{
  "x-signal-stack-key" = $config["BRIDGE_API_KEY"]
  "x-signal-stack-timestamp" = $timestamp
  "x-signal-stack-nonce" = $nonce
  "x-signal-stack-signature" = $signature
}

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:$port/v1/diagnostics" `
  -ContentType "application/json" `
  -Headers $headers `
  -Body $body

$response | ConvertTo-Json -Depth 10
