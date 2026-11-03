# PizzaResolve_MCP_Codeverse - demo-day launcher (Windows PowerShell)
# 1) refreshes synthetic timestamps, 2) runs the live Talkdesk check, 3) starts the MCP server and the Cloudflare quick tunnel.
# Secrets are read by the server from .env / ..\..\oauthclient.json; nothing secret is printed.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$cloudflared = "C:\Users\abcom\tools\cloudflared\cloudflared.exe"

Write-Host "== Refreshing synthetic timestamps (orders/payments/events/refunds; ledger untouched)"
node src/seed.js --refresh-times | Select-String -NotMatch " 200$"
Write-Host "== Live Talkdesk data check"
node test/live_talkdesk_check.js | Select-Object -Last 1

Write-Host "== Starting MCP server on :8787 (data_source=TALKDESK_DATA_TABLES)"
$env:PZ_STORE = "talkdesk"; $env:PORT = "8787"
$server = Start-Process node -ArgumentList "src/server.js" -RedirectStandardOutput "server_audit.out.log" -RedirectStandardError "server_audit.err.log" -PassThru -WindowStyle Hidden
Start-Sleep 3
Invoke-RestMethod http://localhost:8787/healthz | Out-String | Write-Host

Write-Host "== Starting Cloudflare quick tunnel"
$tunnelLog = Join-Path $PSScriptRoot "tunnel.log"
$tunnel = Start-Process $cloudflared -ArgumentList "tunnel --no-autoupdate --url http://localhost:8787" -RedirectStandardError $tunnelLog -PassThru -WindowStyle Hidden
$url = $null
for ($i = 0; $i -lt 30 -and -not $url; $i++) { Start-Sleep 1; $m = Select-String -Path $tunnelLog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
Write-Host "PUBLIC MCP URL: $url/mcp"
Write-Host "Registered in Talkdesk (PizzaResolve_MCP_Codeverse): https://efficiently-potter-synthesis-jack.trycloudflare.com/mcp"
Write-Host "If these differ, edit the MCP server URL in Talkdesk (AI Agent Platform > MCP Servers) and re-paste the bearer token from .env, then Test connection."
Write-Host "Server PID $($server.Id), tunnel PID $($tunnel.Id). Stop with: Stop-Process -Id $($server.Id),$($tunnel.Id)"
