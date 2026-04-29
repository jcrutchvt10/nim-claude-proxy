[CmdletBinding(PositionalBinding = $false)]
param(
    [int]$Port = 3000,
    [switch]$RestartProxy,
    [switch]$Bare,
    [string[]]$Claude = @()
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

function Test-ProxyHealthy {
    param([int]$HealthPort)

    try {
        $null = Invoke-RestMethod -Method Get -Uri "http://localhost:$HealthPort/health" -TimeoutSec 2
        return $true
    } catch {
        return $false
    }
}

function Load-DotEnv {
    param([string]$EnvFilePath)

    if (-not (Test-Path $EnvFilePath)) {
        return
    }

    Get-Content $EnvFilePath | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim().Trim('"')
            if ([string]::IsNullOrWhiteSpace((Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue).Value)) {
                Set-Item -Path "Env:$name" -Value $value
            }
        }
    }
}

Set-Location $repoRoot

$rememberLogDir = Join-Path $repoRoot '.remember\logs'
if (-not (Test-Path $rememberLogDir)) {
    New-Item -ItemType Directory -Path $rememberLogDir -Force | Out-Null
}

if ($RestartProxy) {
    $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existing) {
        Stop-Process -Id $existing.OwningProcess -Force
        Write-Host "Stopped existing proxy process $($existing.OwningProcess) on port $Port"
    }
}

if (-not (Test-ProxyHealthy -HealthPort $Port)) {
    Write-Host "Proxy is not healthy on port $Port. Starting proxy..."

    Load-DotEnv -EnvFilePath (Join-Path $repoRoot '.env')

    if (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
        npm install
    }

    $env:PORT = "$Port"
    Start-Process -FilePath 'node' -ArgumentList 'proxy.js' -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null

    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        if (Test-ProxyHealthy -HealthPort $Port) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }

    if (-not $ready) {
        Write-Error "Proxy failed to become healthy on http://localhost:$Port/health"
    }

    Write-Host "Proxy started on http://localhost:$Port"
} else {
    Write-Host "Proxy already running on http://localhost:$Port"
}

$env:CLAUDE_PROXY_URL = "http://localhost:$Port"

$effectiveArgs = @()

if ($Bare -and -not ($Claude -contains '--bare')) {
    $effectiveArgs += '--bare'
}

if (-not ($Claude -contains '--exclude-dynamic-system-prompt-sections')) {
    $effectiveArgs += '--exclude-dynamic-system-prompt-sections'
}

$effectiveArgs += $Claude

& (Join-Path $repoRoot 'claude-proxy.ps1') @effectiveArgs
