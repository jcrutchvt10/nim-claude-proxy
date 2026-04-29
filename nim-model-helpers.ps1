$ErrorActionPreference = 'Stop'

function Import-NimEnvironment {
    param([string]$RepoRoot)

    Set-Location $RepoRoot

    $envFile = Join-Path $RepoRoot '.env'
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^\s*([^#=]+)=(.*)$') {
                $name = $matches[1].Trim()
                $value = $matches[2].Trim().Trim('"')
                if ([string]::IsNullOrWhiteSpace((Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue).Value)) {
                    Set-Item -Path "Env:$name" -Value $value
                }
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:NIM_BASE_URL)) {
        throw 'NIM_BASE_URL is not set.'
    }

    if ([string]::IsNullOrWhiteSpace($env:NIM_API_KEY)) {
        throw 'NIM_API_KEY is not set.'
    }
}

function Get-NimModels {
    $response = Invoke-RestMethod -Method Get -Uri "$env:NIM_BASE_URL/models" -Headers @{ Authorization = "Bearer $env:NIM_API_KEY" }
    @($response.data | Where-Object { $_.id })
}

function Test-NimChatCapableModel {
    param([string]$ModelId)

    if ([string]::IsNullOrWhiteSpace($ModelId)) {
        return $false
    }

    $includePattern = '(instruct|chat|assistant|coder|codegemma|codestral|devstral|terminus|flash|\bit$|\bpro$|large|medium|small|maverick|nemotron|jamba)'
    $excludePattern = '(embed|rerank|reward|moderation|guard|safety|topic-control|retriever|deplot|fuyu|parse|vlm-embed|nv-embed|qa-|nemo(retriever)?-.*embed)'

    return ($ModelId -match $includePattern) -and ($ModelId -notmatch $excludePattern)
}

function Get-NimChatModels {
    Get-NimModels | Where-Object { Test-NimChatCapableModel $_.id }
}

function Get-NimModelDirective {
    param([string]$ModelId)

    "model:$ModelId"
}

function Get-NimFuzzyScore {
    param(
        [string]$ModelId,
        [string]$Query
    )

    if ([string]::IsNullOrWhiteSpace($Query)) {
        return 0
    }

    $id = $ModelId.ToLowerInvariant()
    $q = $Query.ToLowerInvariant()

    if ($id -eq $q) { return 1000 }
    if ($id.StartsWith($q)) { return 800 }
    if ($id.Contains("/$q")) { return 700 }
    if ($id.Contains($q)) { return 600 }

    $parts = $q.Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)
    if ($parts.Count -eq 0) { return 0 }

    $score = 0
    foreach ($part in $parts) {
        if ($id.Contains($part)) {
            $score += 100
        }
    }

    return $score
}
