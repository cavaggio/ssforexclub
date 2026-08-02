$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
  throw "Missing mt5-bridge\.env. Run .\setup_bridge.ps1, then enter the FTMO account values."
}

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw "Python launcher 'py' was not found. Install 64-bit Python 3.11 and select Add Python to PATH."
}

if (-not (Test-Path ".venv")) {
  py -3.11 -m venv .venv
}

.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

$bindHost = if ($env:BRIDGE_BIND_HOST) { $env:BRIDGE_BIND_HOST } else { "127.0.0.1" }
$port = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { "8787" }

# python-dotenv loads .env inside app.py. Keep the service bound to localhost;
# publish it through an HTTPS reverse proxy or Cloudflare Tunnel.
.\.venv\Scripts\python.exe -m uvicorn connector:app --host $bindHost --port $port
