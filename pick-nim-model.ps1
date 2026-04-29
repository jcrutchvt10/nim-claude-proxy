[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Query,
    [int]$Top = 20,
    [switch]$All,
    [int]$Select
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'nim-model-helpers.ps1')

Import-NimEnvironment -RepoRoot $PSScriptRoot

$models = if ($All) { Get-NimModels } else { Get-NimChatModels }

if (-not $models -or $models.Count -eq 0) {
    throw 'No matching NIM models found for this API key.'
}

if ([string]::IsNullOrWhiteSpace($Query)) {
    $Query = Read-Host 'Search model ids'
}

$ranked = $models |
    ForEach-Object {
        [PSCustomObject]@{
            id = $_.id
            score = Get-NimFuzzyScore -ModelId $_.id -Query $Query
        }
    } |
    Where-Object { $_.score -gt 0 -or [string]::IsNullOrWhiteSpace($Query) } |
    Sort-Object -Property @{ Expression = 'score'; Descending = $true }, @{ Expression = 'id'; Descending = $false } |
    Select-Object -First $Top

if (-not $ranked -or $ranked.Count -eq 0) {
    throw "No models matched query '$Query'."
}

for ($i = 0; $i -lt $ranked.Count; $i++) {
    $displayIndex = $i + 1
    Write-Host ("[{0}] {1}" -f $displayIndex, $ranked[$i].id)
}

$selectedNumber = if ($PSBoundParameters.ContainsKey('Select')) {
    $Select
} else {
    $choice = Read-Host 'Pick a model number to copy'
    if ($choice -notmatch '^\d+$') {
        throw 'Selection must be a number.'
    }
    [int]$choice
}

$selectedIndex = $selectedNumber - 1
if ($selectedIndex -lt 0 -or $selectedIndex -ge $ranked.Count) {
    throw 'Selection out of range.'
}

$directive = Get-NimModelDirective -ModelId $ranked[$selectedIndex].id
Set-Clipboard -Value $directive
Write-Output $directive
Write-Host 'Copied to clipboard.'
