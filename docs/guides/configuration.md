---
title: Configuration
description: Configure providers, models, consent modes, and sandbox settings in Seepient.
---

# Configuration

Seepient merges configuration from four layers:

1. CLI command flags (highest precedence)
2. Workspace configuration file (`.seepient/config.json` in current directory)
3. User global configuration file (`~/.seepient/config.json`)
4. Environment variables
5. Built-in defaults (lowest precedence)

## Managing settings interactively

The recommended way to configure providers and models is the interactive setup wizard:

```bash
seepient setup
```

The wizard writes validated configuration directly to `~/.seepient/config.json` and manages credentials securely in your operating system keychain when available.

## Configuration file format

Configuration files use standard JSON format. Below is an annotated example:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-3-7-sonnet",
  "consentMode": "ask-untrusted",
  "sandbox": {
    "enabled": true,
    "allowNetwork": true
  },
  "routing": {
    "text": {
      "standard": { "provider": "anthropic", "model": "claude-3-7-sonnet" },
      "efficient": { "provider": "openai", "model": "gpt-4o-mini" },
      "complex": { "provider": "anthropic", "model": "claude-3-7-sonnet" }
    },
    "commit": {
      "standard": { "provider": "anthropic", "model": "claude-3-7-sonnet" }
    },
    "media": {
      "standard": { "provider": "fal", "model": "flux-pro" }
    }
  },
  "providers": {
    "anthropic": {
      "credentialRef": { "type": "env", "key": "ANTHROPIC_API_KEY" }
    },
    "openai": {
      "credentialRef": { "type": "env", "key": "OPENAI_API_KEY" }
    },
    "local": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "apiKey": "ollama"
    }
  }
}
```

## Environment variables

### LLM providers

| Variable | Provider | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic | API key for Claude models |
| `OPENAI_API_KEY` | OpenAI | API key for GPT models |
| `GEMINI_API_KEY` | Google | API key for Gemini models |
| `GLM_API_KEY` | Zhipu GLM | API key for GLM models |
| `DEEPSEEK_API_KEY` | DeepSeek | API key for DeepSeek models |
| `OPENROUTER_API_KEY` | OpenRouter | Multi-model routing gateway |
| `FAL_KEY` | Fal.ai | Image generation and diffusion models |

### Tool integrations

| Variable | Integration | Purpose |
|---|---|---|
| `TAVILY_API_KEY` | Tavily | Real-time web search tool (`web_search`) |
| `SMTP_HOST` | SMTP Email | Mail server host (`send_email`) |
| `SMTP_PORT` | SMTP Email | Mail server port |
| `SMTP_USER` | SMTP Email | Username for authentication |
| `SMTP_PASS` | SMTP Email | Password or app password |
| `WEBHOOK_URL` | Notifications | Target endpoint for `send_notification` |

### System and security settings

| Variable | Default | Purpose |
|---|---|---|
| `SEEPIENT_CONSENT_MODE` | `always-ask` | Consent mode: `always-ask`, `ask-untrusted`, or `autonomous-trusted` |
| `SEEPIENT_SANDBOX` | `true` | Set to `false` to disable OS process sandboxing (macOS/Linux) |
| `SEEPIENT_AUDIT_LOG` | `~/.seepient/audit.log` | Path to the append-only 0600 audit log file |
| `SEEPIENT_CONFIG_DIR` | `~/.seepient` | Directory for sessions, credentials, and settings |

## Consent modes

Seepient provides three consent modes that determine when user confirmation is requested before executing tools:

### `always-ask` (default)
Every tool call that causes external side effects requires confirmation. Read-only operations like reading a file run automatically, while shell executions and file writes prompt for confirmation.

### `ask-untrusted`
Known, trusted tools run automatically if they match pre-configured allowlists. Unrecognized shell commands or mutations outside the working directory still prompt for confirmation.

### `autonomous-trusted`
Actions within the configured working directory run without confirmation. Useful for continuous integration runners, Docker containers, and batch scripts where no interactive terminal is attached.
