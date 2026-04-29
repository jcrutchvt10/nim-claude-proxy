$ErrorActionPreference = 'Stop'

$claude = Get-Command 'claude' -ErrorAction SilentlyContinue
if (-not $claude) {
    Write-Error 'Claude Code CLI was not found on PATH.'
}

$proxyUrl = if ([string]::IsNullOrWhiteSpace($env:CLAUDE_PROXY_URL)) {
    'http://localhost:3000'
} else {
    $env:CLAUDE_PROXY_URL
}

$env:ANTHROPIC_BASE_URL = $proxyUrl
$env:ANTHROPIC_API_KEY = 'sk-ant-test-key-do-not-use'

Write-Host "ANTHROPIC_BASE_URL=$env:ANTHROPIC_BASE_URL"
Write-Host 'ANTHROPIC_API_KEY set to proxy placeholder key'

& $claude.Source @args