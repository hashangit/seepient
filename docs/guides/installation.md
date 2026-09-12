---
title: Installation
description: Install Seepient via Homebrew, package managers, or Docker.
---

# Installation

Seepient requires Node.js 22.19 or higher.

## System package managers

### Homebrew (macOS and Linux)

Use Homebrew to install the CLI and standalone server binaries:

```bash
brew tap hashangit/seepient
brew trust hashangit/seepient
brew install seepient
```

::: info Homebrew 6.0 trust requirement
Homebrew 6.0 requires explicitly trusting third-party taps with `brew trust` before executing formulas that bundle pre-compiled native binaries.
:::

## Node package managers

Install Seepient globally using your preferred package manager:

::: code-group

```bash [pnpm]
pnpm add -g seepient
```

```bash [npm]
npm install -g seepient
```

```bash [yarn]
yarn global add seepient
```

:::

## Docker container

Build and run Seepient locally from the cloned repository using Docker:

```bash
# Build the local Docker image
docker build -t seepient .

# Run Seepient interactively
docker run -it --rm \
  -v "$(pwd):/workspace" \
  -w /workspace \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  seepient seepient
```

To run the standalone HTTP and WebSocket server inside a container:

```bash
# Generate an API key
docker run --rm seepient seepient-server --generate-api-key

# Run the server container
docker run -d \
  --name seepient-server \
  -p 7337:7337 \
  -v seepient-data:/home/appuser/.seepient \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  seepient
```

## Platform compatibility

| Platform | TUI & CLI | File reads & shell | Model-authored file writes | Sandboxing |
|---|---|---|---|---|
| **macOS (arm64)** | Supported | Supported | Supported (native helper) | Seatbelt (`sandbox-exec`) |
| **macOS (x64)** | Supported | Supported | Supported (native helper) | Seatbelt (`sandbox-exec`) |
| **Linux (x64)** | Supported | Supported | Supported (native helper) | Bubblewrap (`bwrap`) |
| **Linux (arm64)** | Supported | Supported | Supported (native helper) | Bubblewrap (`bwrap`) |
| **Windows (native)** | Supported | Supported | Refused before approval | None |
| **Windows (WSL2)** | Supported | Supported | Supported | Bubblewrap (`bwrap`) |

::: warning Windows native limitation
On native Windows (cmd.exe or PowerShell), chat, planning, and file reading work without issues. Model-authored file writes are refused before approval because the native atomic commit helper (`seepient-fs-commit`) does not currently provide a native Windows build. There is no unguarded write fallback. Use WSL2 or Docker containers when running Seepient on Windows systems that require file modifications.
:::

## Building from source

To develop or contribute to Seepient:

1. Clone the repository:
   ```bash
   git clone https://github.com/hashangit/seepient.git
   cd seepient
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Build the TypeScript source and Rust commit helper:
   ```bash
   pnpm run build
   pnpm run native:build
   ```

4. Run the test suite:
   ```bash
   pnpm test
   ```
