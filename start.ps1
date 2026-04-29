$ErrorActionPreference = 'Stop'

Write-Host 'Starting NIM <-> Claude Proxy...'

if (Test-Path '.env') {
    Get-Content '.env' | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim().Trim('"')
            if ([string]::IsNullOrWhiteSpace((Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue).Value)) {
                Set-Item -Path "Env:$name" -Value $value
            }
        }
    }
}

if (-not (Test-Path 'node_modules')) {
    npm install
}

$port = if ([string]::IsNullOrWhiteSpace($env:PORT)) { '3000' } else { $env:PORT }

$env:ANTHROPIC_BASE_URL = "http://localhost:$port"
$env:ANTHROPIC_API_KEY = 'sk-ant-test-key-do-not-use'

Write-Host "ANTHROPIC_BASE_URL=$env:ANTHROPIC_BASE_URL"
Write-Host 'ANTHROPIC_API_KEY set to proxy placeholder key'

node proxy.js