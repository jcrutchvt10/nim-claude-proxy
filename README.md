# NIM Claude Multi-Model Proxy

## Setup

1. **Create a `.env` file** with your NVIDIA NIM credentials:
```bash
cp .env.example .env
# Edit .env with your NIM_BASE_URL and NIM_API_KEY
```

2. **Start the proxy**:

macOS/Linux:
```bash
chmod +x start.sh
./start.sh
```

Windows PowerShell:
```powershell
./start.ps1
```

3. **Claude Code in this workspace is preconfigured to use the proxy** via [.claude/settings.json](.claude/settings.json).

That project setting overrides broken global defaults like `http://localhost:8080` and provides a valid placeholder Anthropic key format so Claude does not fall back to `/login` for this workspace.

4. **If you launch Claude from a terminal, prefer bare mode or the included wrapper**:

macOS/Linux:
```bash
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_API_KEY=sk-ant-test-key-do-not-use
claude --bare
```

Windows PowerShell:
```powershell
$env:ANTHROPIC_BASE_URL = 'http://localhost:3000'
$env:ANTHROPIC_API_KEY = 'sk-ant-test-key-do-not-use'
claude --bare
```

Or use the included launcher:
```powershell
./claude-proxy.ps1 --bare
```

## One command launch (recommended)
Use this script to ensure the proxy is running, then launch Claude:

```powershell
./launch-claude.ps1
```

Default launcher behavior keeps Claude Code functionality enabled and adds
`--exclude-dynamic-system-prompt-sections` to reduce avoidable prompt overhead.

Useful options:

```powershell
# Restart proxy first, then launch Claude
./launch-claude.ps1 -RestartProxy

# Use a different port
./launch-claude.ps1 -Port 3001

# Force bare mode (minimal Claude runtime)
./launch-claude.ps1 -Bare

# Pass through Claude CLI arguments
./launch-claude.ps1 -Claude @('-p', 'Reply with proxy-ok')
```

Pass Claude CLI args through the wrapper as needed:
```powershell
./claude-proxy.ps1 --version
./claude-proxy.ps1 --help
```

## Verify tool calling compatibility
Run the built-in tool-calling compatibility checks:

```powershell
./verify-tool-calling.ps1
```

This validates:
- forced tool use (`tool_choice: tool`)
- explicit no-tool mode (`tool_choice: none`)
- tool_result round-trip across turns
- fallback from tool-unsupported primary routes to tool-capable alternates

Run the skills-focused compatibility checks:

```powershell
./verify-skills-functionality.ps1
```

This validates:
- forced skill passthrough
- `tool_choice: any` and `tool_choice: auto` behavior with multiple declared skills
- successful and failed skill result round-trips (`tool_result` with `is_error`)
- streaming `tool_use` event shape for skill invocations

If Claude Code sees an invalid key format or a stale proxy base URL from user-level settings, it can still fail before reaching the proxy. The project-local `.claude/settings.json` in this repo is intended to override that for this workspace.

## Why the dummy API key?
The proxy uses `sk-ant-test-key-do-not-use` as a placeholder ANTHROPIC_API_KEY. This is intentional — it's a valid format that allows Claude Code to connect, but all actual API calls are routed through your NIM credentials (NIM_API_KEY).

## Models
- minimax (default)
- mixtral
- llama
- glm51 (`z-ai/glm-5.1`)

Print just the model ids your API key can use:

```powershell
./list-nim-model-ids.ps1
```

Print only chat-capable/instruct-style model ids:

```powershell
./list-nim-chat-model-ids.ps1
```

Fuzzy-pick a model and copy a `model:...` line to your clipboard:

```powershell
./pick-nim-model.ps1
./pick-nim-model.ps1 -Query mixtral
./pick-nim-model.ps1 -Query qwen -Top 10
```
List available models:

```powershell
Invoke-RestMethod http://localhost:3000/nim/models | ConvertTo-Json -Depth 6
```

or:

```powershell
Invoke-RestMethod http://localhost:3000/v1/models | ConvertTo-Json -Depth 6
```

## Override model
Use header:
```
x-model: mixtral
x-model: glm51
```

## In-chat model selector
You can force model selection from inside your Claude message by putting one of these on the first line:

```
/nim minimax
/nim mixtral
/nim llama
/nim glm51
```

or:

```
#model:minimax
#model:mixtral
#model:llama
#model:glm51
```

or:

```
model:minimax
model:mixtral
model:llama
model:glm51
```

You can also use a full NVIDIA model id on the first line, for example:

```
model:mistralai/mixtral-8x7b-instruct-v0.1
model:meta/llama-3.1-70b-instruct
model:z-ai/glm-5.1
```

In Claude Code chat, `/nim ...` may be intercepted as a slash command before reaching the proxy.
If that happens, use `#model:...` or `model:...` instead.

The selector line is removed before forwarding the prompt to NVIDIA NIM.

