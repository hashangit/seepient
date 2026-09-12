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
| `--provider <provider>` | `-p` | String | Configured default | Provider to use (`openai-compatible`, `openai`, `anthropic`, `glm`). |
| `--model <model>` | `-m` | String | Configured default | Model to use. |
| `--no-interactive` | `-n` | Boolean | `false` | Exit after processing the initial query (Headless mode). |
| `--docker` | | Boolean | `false` | Docker mode: implies --no-interactive, disables interactive prompts (denies un-predeclared actions; pass `--mode autonomous` or `--yes` for unattended runs). |
| `--yes` | `-y` | Boolean | `false` | Autonomous mode: auto-approve actions within deployment ceiling (alias for --mode autonomous). |
| `--mode <mode>` | | String | `edit-enabled` | Consent mode: `ask-everything`, `edit-enabled` (default), `autonomous`. |
| `--resume <id>` | `-r` | String | | Resume a previous session by id (or "last"). |
| `--version` | `-V` | Boolean | | Print version number and exit. |
| `--help` | `-h` | Boolean | | Print help summary and exit. |

---

## Subcommands

### `seepient setup`
Launches the interactive setup wizard to configure providers, API credentials, and default model routing.

```bash
seepient setup
```

### `seepient server`
Starts the Seepient HTTP and WebSocket daemon from the CLI.

```bash
# Start server on default port (7337)
seepient server

# Custom port and interface
seepient server --port 8080 --host 0.0.0.0
```

### `seepient auth`
Manages provider authentication and server API tokens.

```bash
# Log in or configure an API key for a provider
seepient auth login anthropic

# Remove credentials for an account
seepient auth logout anthropic

# Issue a scoped server API key
seepient auth issue-token --scope agent:run --label my-app
```

### `seepient providers`
Inspects and registers upstream model providers.

```bash
# List configured providers
seepient providers list

# Register a local Ollama endpoint
seepient providers add local-ollama --upstream ollama --url http://127.0.0.1:11434/v1 --allow-private

# Register a custom OpenAI-compatible endpoint with an API key
seepient providers add custom-ai --upstream openai --url https://api.example.com/v1 --credential env:CUSTOM_API_KEY
```

### `seepient models`
Inspects model catalogs and configures model assignments.

```bash
# List available models across active providers
seepient models list
```

### `seepient generate`
Direct media generation commands for image models.

```bash
# Generate an image from a prompt
seepient generate image "A futuristic city skyline at twilight" --output ./images

# Generate variations or edits
seepient generate image "Make the sky overcast" --operation edit --output ./images
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
| `--generate-api-key` | Boolean | `false` | Generates an ephemeral cryptographic API key and prints it on startup. |

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Execution completed successfully (or clean user exit via SIGINT). |
| `1` | Runtime error, invalid configuration/flags, or unhandled execution failure. |
