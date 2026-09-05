---
title: CLI command reference
description: Complete reference for Seepient CLI commands, flags, and exit codes.
---

# CLI command reference

## Syntax

```bash
seepient [prompt] [options]
seepient <subcommand> [options]
```

When run without `prompt` or `subcommand`, Seepient starts the interactive Terminal UI.

---

## Global options

| Flag | Shorthand | Type | Default | Description |
|---|---|---|---|---|
| `--provider <name>` | `-p` | String | Configured default | LLM provider to use (`anthropic`, `openai`, `gemini`, etc.). |
| `--model <name>` | `-m` | String | Configured default | Model name (e.g. `claude-3-7-sonnet`, `gpt-4o`). |
| `--tier <tier>` | | String | `standard` | Purpose tier: `standard`, `complex`, or `efficient`. |
| `--session <id>` | `-s` | String | Auto-generated | Session ID to attach to or resume. |
| `--skill <name>` | | String | None | Force-inject a skill pack into the agent context. |
| `--no-interactive` | `-y` | Boolean | `false` | Automatically approve safe operations without prompting. |
| `--dry-run` | | Boolean | `false` | Plan actions and display diffs without writing to disk or executing commands. |
| `--consent-mode <mode>` | | String | `always-ask` | Consent mode: `always-ask`, `ask-untrusted`, `autonomous-trusted`. |
| `--no-sandbox` | | Boolean | `false` | Disable operating system process sandboxing. |
| `--version` | `-v` | Boolean | | Print version number and exit. |
| `--help` | `-h` | Boolean | | Print help summary and exit. |

---

## Subcommands

### `seepient setup`
Launches the interactive setup wizard to configure providers, API credentials, and default model routing.

```bash
seepient setup
```

### `seepient sessions`
Inspects and manages conversation checkpoints.

```bash
# List recent sessions
seepient sessions list

# Export a session transcript to markdown
seepient sessions export sess_20260905_a1b2 --output ./review.md

# Fork an existing session from turn 3
seepient sessions fork sess_20260905_a1b2 --turn 3
```

### `seepient audit`
Inspects recent entries recorded in `~/.seepient/audit.log`.

```bash
# View the last 10 audit entries
seepient audit --limit 10

# Filter audit records by session ID
seepient audit --session sess_20260905_a1b2
```

---

## Server binary (`seepient-server`)

The standalone server binary starts the HTTP and WebSocket daemon:

```bash
seepient-server [options]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `--port <number>` | Number | `7337` | Port to listen on. |
| `--host <string>` | String | `127.0.0.1` | Network interface to bind to (`0.0.0.0` for all interfaces). |
| `--api-key <key>` | String | None | Static API key required for HTTP and WebSocket authentication. |
| `--generate-api-key` | Boolean | `false` | Generates an ephemeral cryptographic API key and prints it on startup. |

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Execution completed successfully. |
| `1` | Runtime error or unhandled model execution failure. |
| `2` | Configuration error, invalid command flags, or missing API credentials. |
| `130` | Terminated by user (`SIGINT` or `Ctrl+C`). |
