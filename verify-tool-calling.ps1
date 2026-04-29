param(
  [string]$BaseUrl = "http://localhost:3000",
  [string]$ApiKey = "sk-ant-test-key-do-not-use"
)

$ErrorActionPreference = "Stop"

function Invoke-ProxyMessage {
  param(
    [hashtable]$Body,
    [hashtable]$Headers,
    [int]$MaxAttempts = 4
  )

  $jsonBody = $Body | ConvertTo-Json -Depth 30
  $requestHeaders = @{ 
    "x-api-key" = $ApiKey
    "anthropic-version" = "2023-06-01"
  }

  if ($Headers) {
    foreach ($key in $Headers.Keys) {
      $requestHeaders[$key] = $Headers[$key]
    }
  }

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      return Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/messages" -Headers $requestHeaders -ContentType "application/json" -Body $jsonBody -TimeoutSec 60
    } catch {
      $responseText = $_.ErrorDetails.Message
      $isRetryable = $responseText -match 'Too Many Requests|"status"\s*:\s*429|NIM returned 429' -or $responseText -match 'NIM returned 5\d\d'
      if (-not $isRetryable -or $attempt -eq $MaxAttempts) {
        throw
      }

      $backoffMs = 600 * [Math]::Pow(2, $attempt - 1) + (Get-Random -Minimum 0 -Maximum 250)
      Write-Host "  transient failure on attempt $attempt, retrying in $backoffMs ms"
      Start-Sleep -Milliseconds $backoffMs
    }
  }
}

function Assert-Condition {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw "ASSERTION FAILED: $Message"
  }
}

$toolSchema = @{
  name = "Bash"
  description = "Run shell commands"
  input_schema = @{
    type = "object"
    properties = @{
      command = @{ type = "string" }
    }
    required = @("command")
  }
}

Write-Host "[1/4] Forced tool call returns tool_use"
$forced = Invoke-ProxyMessage -Body @{
  model = "claude-sonnet-4-6"
  max_tokens = 96
  messages = @(
    @{ role = "user"; content = @(@{ type = "text"; text = "Use Bash to run echo hi" }) }
  )
  tools = @($toolSchema)
  tool_choice = @{ type = "tool"; name = "Bash" }
}

Assert-Condition ($forced.stop_reason -eq "tool_use") "Expected stop_reason tool_use"
Assert-Condition ($forced.content.Count -gt 0 -and $forced.content[0].type -eq "tool_use") "Expected first block to be tool_use"
Write-Host "  PASS"

Write-Host "[2/4] tool_choice none does not force tools"
$none = Invoke-ProxyMessage -Body @{
  model = "claude-sonnet-4-6"
  max_tokens = 48
  messages = @(
    @{ role = "user"; content = @(@{ type = "text"; text = "Reply with exactly OK" }) }
  )
  tools = @($toolSchema)
  tool_choice = @{ type = "none" }
}

Assert-Condition ($none.stop_reason -eq "end_turn" -or $none.stop_reason -eq "max_tokens") "Expected text completion stop reason"
Assert-Condition (($none.content | Where-Object { $_.type -eq "text" }).Count -ge 1) "Expected text content"
Write-Host "  PASS"

Write-Host "[3/4] Tool result round-trip works"
$roundTrip = Invoke-ProxyMessage -Body @{
  model = "claude-sonnet-4-6"
  max_tokens = 140
  messages = @(
    @{ role = "user"; content = @(@{ type = "text"; text = "Use Bash to run echo hi" }) },
    @{ role = "assistant"; content = @(@{ type = "tool_use"; id = "toolu_test_1"; name = "Bash"; input = @{ command = "echo hi" } }) },
    @{ role = "user"; content = @(@{ type = "tool_result"; tool_use_id = "toolu_test_1"; content = "hi" }) }
  )
  tools = @($toolSchema)
  tool_choice = @{ type = "auto" }
}

Assert-Condition (($roundTrip.content | Where-Object { $_.type -eq "text" }).Count -ge 1) "Expected assistant text after tool_result"
Write-Host "  PASS"

Write-Host "[4/4] Tool-unsupported primary route falls back"
$fallback = Invoke-ProxyMessage -Body @{
  model = "claude-sonnet-4-6"
  max_tokens = 96
  messages = @(
    @{ role = "user"; content = @(@{ type = "text"; text = "Use Bash to run echo hi" }) }
  )
  tools = @($toolSchema)
  tool_choice = @{ type = "auto" }
} -Headers @{ "x-model" = "mixtral" }

Assert-Condition ($fallback.stop_reason -eq "tool_use") "Expected tool_use after fallback"
Write-Host "  PASS"

Write-Host "All tool-calling checks passed."
