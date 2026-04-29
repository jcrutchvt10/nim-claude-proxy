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

  $jsonBody = $Body | ConvertTo-Json -Depth 40
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

$bashTool = @{
  name = "Bash"
  description = "Run shell commands"
  input_schema = @{
    type = "object"
    properties = @{ command = @{ type = "string" } }
    required = @("command")
  }
}

$webFetchTool = @{
  name = "WebFetch"
  description = "Fetch and summarize a web page"
  input_schema = @{
    type = "object"
    properties = @{
      url = @{ type = "string" }
      prompt = @{ type = "string" }
    }
    required = @("url", "prompt")
  }
}

$readTool = @{
  name = "Read"
  description = "Read a file"
  input_schema = @{
    type = "object"
    properties = @{ file_path = @{ type = "string" } }
    required = @("file_path")
  }
}

Write-Host "[1/5] Forced Bash passthrough"
$bash = Invoke-ProxyMessage -Body @{
  model = "claude-sonnet-4-6"
  max_tokens = 96
  messages = @(
    @{ role = "user"; content = @(@{ type = "text"; text = "Use Bash to run echo plugin-ok" }) }
  )
  tools = @($bashTool)
  tool_choice = @{ type = "tool"; name = "Bash" }
}
Assert-Condition ($bash.stop_reason -eq "tool_use") "Expected tool_use stop reason for Bash"
Assert-Condition ($bash.content[0].type -eq "tool_use" -and $bash.content[0].name -eq "Bash") "Expected Bash tool_use block"
Write-Host "  PASS"

Write-Host "[2/5] Forced WebFetch passthrough"
$web = Invoke-ProxyMessage -Body @{
  model = "claude-sonnet-4-6"
  max_tokens = 140
  messages = @(
    @{ role = "user"; content = @(@{ type = "text"; text = "Use WebFetch on https://example.com and summarize the page title." }) }
  )
  tools = @($webFetchTool)
  tool_choice = @{ type = "tool"; name = "WebFetch" }
}
Assert-Condition ($web.stop_reason -eq "tool_use") "Expected tool_use stop reason for WebFetch"
Assert-Condition ($web.content[0].type -eq "tool_use" -and $web.content[0].name -eq "WebFetch") "Expected WebFetch tool_use block"
Write-Host "  PASS"

Write-Host "[3/5] Forced Read passthrough"
$read = Invoke-ProxyMessage -Body @{
  model = "claude-sonnet-4-6"
  max_tokens = 120
  messages = @(
    @{ role = "user"; content = @(@{ type = "text"; text = "Use Read to inspect README.md" }) }
  )
  tools = @($readTool)
  tool_choice = @{ type = "tool"; name = "Read" }
}
Assert-Condition ($read.stop_reason -eq "tool_use") "Expected tool_use stop reason for Read"
Assert-Condition ($read.content[0].type -eq "tool_use" -and $read.content[0].name -eq "Read") "Expected Read tool_use block"
Write-Host "  PASS"

Write-Host "[4/5] Multi-plugin auto mode returns supported tool"
$multi = Invoke-ProxyMessage -Body @{
  model = "claude-sonnet-4-6"
  max_tokens = 120
  messages = @(
    @{ role = "user"; content = @(@{ type = "text"; text = "Use the best tool to inspect README.md" }) }
  )
  tools = @($bashTool, $webFetchTool, $readTool)
  tool_choice = @{ type = "auto" }
}
$validNames = @("Bash", "WebFetch", "Read")
$gotToolUse = $multi.stop_reason -eq "tool_use" -and $multi.content.Count -gt 0 -and $multi.content[0].type -eq "tool_use"
Assert-Condition $gotToolUse "Expected tool_use block in auto mode"
Assert-Condition ($validNames -contains $multi.content[0].name) "Expected tool name in declared plugin set"
Write-Host "  PASS"

Write-Host "[5/5] WebFetch-style tool_result round-trip"
$roundTrip = Invoke-ProxyMessage -Body @{
  model = "claude-sonnet-4-6"
  max_tokens = 160
  messages = @(
    @{ role = "user"; content = @(@{ type = "text"; text = "Use WebFetch and then summarize the title" }) },
    @{ role = "assistant"; content = @(@{ type = "tool_use"; id = "toolu_web_1"; name = "WebFetch"; input = @{ url = "https://example.com"; prompt = "Find the page title" } }) },
    @{ role = "user"; content = @(@{ type = "tool_result"; tool_use_id = "toolu_web_1"; content = @{ title = "Example Domain"; summary = "Example page" } }) }
  )
  tools = @($webFetchTool)
  tool_choice = @{ type = "auto" }
}
$hasText = ($roundTrip.content | Where-Object { $_.type -eq "text" }).Count -ge 1
Assert-Condition $hasText "Expected assistant text after WebFetch tool_result"
Write-Host "  PASS"

Write-Host "All plugin passthrough checks passed."
