$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

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

if ([string]::IsNullOrWhiteSpace($env:NIM_BASE_URL)) {
    throw 'NIM_BASE_URL is not set.'
}

if ([string]::IsNullOrWhiteSpace($env:NIM_API_KEY)) {
    throw 'NIM_API_KEY is not set.'
}

$models = Invoke-RestMethod -Method Get -Uri "$env:NIM_BASE_URL/models" -Headers @{ Authorization = "Bearer $env:NIM_API_KEY" }

$models.data |
    Where-Object { $_.id } |
    Select-Object -ExpandProperty id
