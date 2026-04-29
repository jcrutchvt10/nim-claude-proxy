$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'nim-model-helpers.ps1')

Import-NimEnvironment -RepoRoot $PSScriptRoot

Get-NimChatModels |
    Select-Object -ExpandProperty id
