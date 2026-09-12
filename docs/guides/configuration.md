---
title: Configuration
description: Configure providers, models, consent modes, and sandbox settings in Seepient.
---

# Configuration

Seepient merges configuration across layers in this precedence order:

1. CLI command flags (highest precedence)
2. Environment variables
3. Workspace configuration file (`.seepient/setting.json` in current directory)
4. User global configuration file (`~/.seepient/setting.json`)
5. Built-in defaults (lowest precedence)

## Managing settings interactively

The recommended way to configure providers and models is the interactive setup wizard:

```bash
seepient setup
```

The wizard writes validated configuration directly to `~/.seepient/setting.json` and manages credentials securely in your operating system keychain when available.

## Configuration file format

Configuration files (`setting.json`) use standard JSON format. Below is an annotated example of supported settings:

```json
{
  "smtpHost": "smtp.example.com",
  "smtpPort": "587",
  "smtpUser": "agent@example.com",
  "tavilyApiKey": "tvly-sample-key",
  "autoConfirm": false,
  "permissions": {
    "consentMode": "edit-enabled",
    "approvalTimeoutMs": 600000,
    "trustedHostAllowlist": ["use_skill"]
  },
  "server": {
    "maxBodyBytes": 10485760,
    "maxSteps": 50,
    "rateLimitRpm": 120
  },
  "gatewayEnabled": true
}
```

Provider credentials and model routing can be configured interactively via `seepient setup`, in the TUI Model & Provider Dock (`Ctrl+M` or `/models`), via CLI commands (`seepient auth login`, `seepient providers add`), or using environment variables.

## Environment variables

### LLM providers (auto-detected at boot)

| Variable | Provider | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic | API key for Claude models |
| `OPENAI_API_KEY` | OpenAI | API key for GPT models |
| `GLM_API_KEY` | Zhipu GLM | API key for GLM models |
| `OPENAI_COMPAT_API_KEY` | OpenAI-Compatible | API key for custom or local endpoints |
| `OPENAI_COMPAT_BASE_URL` | OpenAI-Compatible | Base URL (e.g. `http://127.0.0.1:11434/v1` for Ollama) |

### Tool integrations

| Variable | Integration | Purpose |
|---|---|---|
| `TAVILY_API_KEY` | Tavily | Real-time web search tool (`web_search`) |
| `SMTP_HOST` | SMTP Email | Mail server host (`send_email`) |
| `SMTP_PORT` | SMTP Email | Mail server port |
| `SMTP_USER` | SMTP Email | Username for authentication |
| `SMTP_PASS` | SMTP Email | Password or app password |
| `FEISHU_WEBHOOK` | Feishu | Webhook endpoint for `send_notification` |
| `DINGTALK_WEBHOOK` | DingTalk | Webhook endpoint for `send_notification` |
| `WECOM_WEBHOOK` | WeCom | Webhook endpoint for `send_notification` |

### System and security settings

| Variable | Default | Purpose |
|---|---|---|
| `SEEPIENT_CONSENT_MODE` | `edit-enabled` | Consent mode: `ask-everything`, `edit-enabled` (default), or `autonomous` |
| `SEEPIENT_SESSION_DIR` | `~/.seepient/sessions` (CLI) / `./.seepient/sessions` (Server) | Directory for persisted conversation history |
| `SEEPIENT_SKILLS_PATH` | unset | Colon-separated list of custom skill directories |
| `SEEPIENT_UNCONTAINED` | unset | Set to `1` to run without platform sandbox containment |
| `SEEPIENT_PORT` | `7337` | Port for the HTTP/WebSocket server |
| `SEEPIENT_HOST` | `127.0.0.1` | Host interface for HTTP/WebSocket server (`127.0.0.1` loopback, `0.0.0.0` all interfaces) |

## Consent modes

Seepient provides three consent modes that determine when user confirmation is requested before executing tools:

### `ask-everything`
Every tool call that causes external side effects requires confirmation. Read-only operations like reading a file run automatically, while shell executions and file writes prompt for confirmation.

### `edit-enabled` (default)
Permits routine workspace edits, reads, and normal development tools without prompts. Shell commands or actions outside the workspace boundary prompt for confirmation.

### `autonomous`
Actions within the configured working directory run without confirmation. Useful for continuous integration runners, Docker containers, and batch scripts where no interactive terminal is attached.
