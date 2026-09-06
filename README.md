# Seepient Agent 🦞

[![NPM Version](https://img.shields.io/npm/v/seepient.svg?style=flat-square)](https://www.npmjs.com/package/seepient)
[![NPM Downloads](https://img.shields.io/npm/dm/seepient.svg?style=flat-square)](https://www.npmjs.com/package/seepient)
[![GitHub Release](https://img.shields.io/github/v/tag/hashangit/seepient?style=flat-square&label=release)](https://github.com/hashangit/seepient/releases)
[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-blue.svg?style=flat-square)](https://github.com/hashangit/seepient/blob/main/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)

**The Engineering-First Headless Agent Framework: CLI, SDK, and Server. Stable, Scalable Automation for the Post-Vision Era.**

**Platform support** — chat, planning, and file reads work everywhere. Model-authored file writes are enforced through exact atomic commits via the bundled native helper (`native/fs-commit`): fully supported on **macOS (arm64/x64)** and **Linux (x64/arm64)**; on **Windows** writes are refused before approval (read-only) until a win32 helper exists. There is no unguarded write fallback.

---

🔗 **GitHub Repository**: [https://github.com/hashangit/seepient](https://github.com/hashangit/seepient)

---

Seepient Agent is a high-stability, open-source automation framework specifically engineered for **headless systems**.

Unlike "screen-seeing" agents (such as OpenClaw) that rely on visual interpretation, Seepient Agent is built on a foundation of precise command-driven execution. This makes it significantly more **stable**, **robust from an engineering perspective**, and **easier to scale** across complex environments—whether it's a local server, a CI/CD pipeline, or thousands of containerized nodes.

## Why Seepient Agent?
- 🐳 **Docker Native**: Built to run safely inside containers with pre-packaged Chromium, CJK fonts, non-root security, and native helper binaries.
- 🚀 **Better Engineering**: Operates via precise system APIs and shell commands rather than unstable visual recognition, ensuring deterministic outcomes.
- 🛡️ **Superior Stability**: Immune to issues like UI rendering, screen resolution, or network lag that plague vision-based agents.
- 📈 **Massive Scalability**: Low resource consumption allows orchestrating thousands of instances (e.g., in K8s) for true automation swarms.
- 🔌 **Swarm Ready**: Stateless design allows for easy orchestration via K8s, Docker Swarm, or simple shell loops.
- 🧩 **Extensible Integrations**: Built-in support for Web Search (Tavily), Email (SMTP), and Notification Webhooks (Feishu, DingTalk, WeCom).
- 📦 **SDK & Server**: TypeScript SDK for programmatic use, standalone HTTP/WebSocket server for remote access.
- 🛠 **Skills System**: Loadable skill packs with file references, custom tool registration, and extensible workflows.

## Features

- 🤖 **Multi-Provider & Purpose × Tier Routing**: Route tasks across `text`, `vision`, `plan`, `commit`, and `media` (image) with `standard`, `complex`, and `efficient` tiers (OpenAI, Anthropic Claude, Google Gemini, GLM, Ollama, DeepSeek, LocalLLM).
- 🔄 **Dynamic Catalog & Live Discovery**: Zero static model lists — dynamic upstream catalog discovery via `@earendil-works/pi-ai` and `@oh-my-pi/pi-catalog` with automatic `/models` polling.
- 🛡️ **Multi-Target Resilience & Fallbacks**: Automatic ordered retry traversal (`[selectedTarget, ...failureTargets]`) with circuit-breaker cooldowns per `(account, capability)` and streaming no-replay guards.
- 💰 **Precision Cost & Reasoning Accounting**: Real-time tracking of input, output, cached prompt, and reasoning/thinking tokens with dynamic live pricing calculation.
- 📜 **Headless Execution**: No browsers, no GUIs. Pure terminal efficiency.
- 🚀 **Non-Interactive Mode**: Intelligent flag handling (`-y`, `--no-interactive`) for zero-touch automation.
- 📂 **Universal Control**: From simple file I/O to complex system administration.
- 🧠 **Context Aware**: Detects container environments and provides accurate system time for relative date queries.
- 🌐 **Web Search**: Integrated with Tavily for real-time information retrieval.
- 🕒 **Time Accuracy**: Built-in tool to get precise system date and time for correct temporal context.
- 📧 **Communication**: Send emails and push notifications to chat groups automatically.
- 📦 **TypeScript SDK**: Programmatic access via 3 statefulness tiers: `askSeepient` (one-shot), `createSeepient` (stateful multi-turn), and `runSeepientServer` (remote server).
- 🖥 **Server Mode**: Standalone HTTP/WebSocket server with REST v2 management API (`/v1/providers`, `/v1/models` with ETag/If-Match), API key auth, and session management.
- 🛠 **Skills System**: Loadable skill packs from directories with `@path` file references, turn-scoped skill switching, and custom tool creation.
- 🛡️ **Security & Permission Pipeline**: Single Domain-owned enforcement pipeline (`PolicyEngine` → `ApprovalBroker` → `ExecutionBoundary` → `AuditRecorder`) default-on across CLI, TUI, SDK, and HTTP/WebSocket server.
- 🔒 **Fail-Closed Isolation & SSRF Defense**: Process containment (macOS Seatbelt / Linux Bubblewrap) and exact-file write helpers fail closed; SSRF guards prevent metadata reflection.
- 💾 **Durable Approvals & 0600 Audit**: File-locked atomic NDJSON stores and append-only `0600` audit logs (`~/.seepient/audit.log`) with fsync before mutation commits.
- 🐳 **Server Worker Backend**: ephemeral Docker worker container scheduler with mTLS transport, Ed25519/HMAC signed dispatches, and secret-free worker execution environments.
- 🏗️ **Clean Modular Architecture**: Strict responsibility-driven layers (`UI → Transport → Domain → Capabilities → Vendors → Foundations`) with decomposed route modules, isolated WebSocket message families, centralized connection registry, and decoupled TUI state hooks.
- 🖥️ **Interactive TUI**: In a TTY, a full-screen Ink/React UI with bordered always-on input, streaming feed, interactive terminal widgets (tables, forms, charts), session manager, message queue/`/steer`, and inline `write_file` diffs (atomic, crash-safe writes).

## Tech Stack
- **Runtime**: Node.js
- **Language**: TypeScript
- **Architecture**: Modular multi-adapter (core, CLI, SDK, server)
- **Framework**: Commander.js
- **UI**: Inquirer (interactivity), Chalk (styling), Ora (spinners)
- **AI**: Multi-Provider (OpenAI, Anthropic Claude, GLM, OpenAI-Compatible)

## Installation

### npm
```bash
npm install -g seepient
```

### pnpm
```bash
pnpm add -g seepient
```

### Homebrew (macOS & Linux)
```bash
brew tap hashangit/seepient
brew trust hashangit/seepient
brew install seepient
```

> **Note:** Requires [Node.js](https://nodejs.org/) 22.19 or later. The `brew trust` step is required by Homebrew 6.0+ (third-party taps must be explicitly trusted before their formulas run).

### Server Binary
The `seepient-server` binary is included for running the standalone HTTP/WebSocket server:
```bash
seepient-server --port 7337 --generate-api-key
```

### SDK Usage
Import the SDK in your TypeScript/JavaScript project:
```bash
npm install seepient
```
```ts
// Main SDK exports
import { askSeepient, createSeepient } from 'seepient';
// Server exports
import { runSeepientServer } from 'seepient/server';
```

### Development Installation
1.  Clone the repository:
    ```bash
    git clone https://github.com/hashangit/seepient.git
    cd seepient
    ```
2.  Install dependencies:
    ```bash
    pnpm install
    ```
3.  Build the project:
    ```bash
    pnpm run build
    ```
4.  Link globally (optional):
    ```bash
    pnpm link
    ```

## Quick Start

1.  **Setup**: Run the interactive setup wizard to configure your providers, credentials, and model assignments in under a minute.
    ```bash
    seepient setup
    ```
    The wizard connects to the live community catalog (supporting dozens of upstream providers including OpenAI, Anthropic, Google, xAI, OpenRouter, Mistral, DeepSeek, and local endpoints), allows multi-mode credentials (API key paste, environment variable reference, keyless, or OAuth provider sign-in), and assigns your main models safely without touching unrelated settings.

2.  **Run**: Start the agent in interactive mode.
    ```bash
    seepient
    ```

## Usage

### 1. Terminal User Interface (TUI)

Running `seepient` in any standard terminal launches a full-screen interactive interface built with Ink and React:

```bash
seepient
> List all TypeScript files in the src folder.
```

When piped into scripts or run with `--no-interactive`, Seepient automatically drops back to a simple readline loop or standard stdout stream.

#### Key Interface Highlights

- ✍️ **The Composer**: Multiline editing (`Shift+Enter`), input history (`↑`/`↓`), and bracketed paste protection so large code snippets never run before you are ready.
- 📁 **File & Command Autocomplete**: Type `@` to fuzzy-search your project and insert file paths directly. Type `/` to browse built-in commands and installed skills.
- 🔄 **Atomic Diffs & Live Feed**: Syntax-highlighted green and red file diffs render right in your feed. Edits write to temporary files first, then rename atomically so a crash never corrupts your code.
- 🧩 **Interactive Terminal Widgets**: The agent can render rich UI components inline: data tables, interactive forms, bar charts, status grids, and tree inspectors. Press `Tab` or `Ctrl+T` to focus a widget, use `↑`/`↓` and `Enter` to submit inputs or actions, and press `Esc` to return to typing.
- 🎯 **In-Flight Steering**: Need to change direction? Type while the agent runs to queue follow-up messages, or use `/steer <instruction>` to cancel the active run and redirect immediately.
- 📋 **Task Tracking & Reasoning**: Long workflows display an active checklist powered by `manage_todos`. Reasoning models stream their thoughts into dedicated collapsible blocks (`Ctrl+O`).
- 📊 **Live Status & File Alerts**: The bottom status line tracks your active model, context token consumption, real-time cost accounting, and alerts you if files change externally while idle.

#### Modal Overlays, Palettes & Docks

Certain commands take over the terminal with dedicated full-screen panels or popup overlays so you can manage complex tasks without leaving your session:

- 🔍 **Command Palette (`Ctrl+P`)**: A fuzzy-search launcher that pops up over your screen. Type any keyword to filter through built-in commands and installed skills, then press `Enter` to run.
- 🎛️ **Model Manager Dock (`/models` or `/providers`)**: A multi-tab configuration dock. Visually assign models to specific tasks (`text`, `vision`, `plan`, `commit`, `media`), browse catalog models with live pricing, probe provider connectivity, or trigger OAuth sign-in (`/login`).
- 🗂️ **Session Selector (`/sessions`)**: A search overlay listing your past conversations. Browse by title, see message counts, and switch sessions with `Enter`. Press `e` to export JSON, `t` to write a clean transcript, `r` to rename, or `d` to delete.
- ⚙️ **Settings Editor (`/settings`)**: An interactive configuration browser. Toggle feature flags, pick enum options with radio selectors, and update values directly without hand-editing `setting.json`.
- 🧙 **Setup Wizard (`/setup`)**: A guided onboarding workflow that walks you through adding providers, testing API credentials, and selecting your default models.
- 🛡️ **Permission Prompt**: When a tool requires approval (such as shell commands or network requests), an approval card appears with exact file targets and risk levels. Press `1`–`9` to select an option, `Enter` to confirm, or `Esc`/`q` to deny.
- ⚠️ **Autonomous Mode Guard**: If you switch to autonomous mode (`/mode autonomous`), a confirmation modal appears to ensure you acknowledge the safety implications before proceeding.

#### Common Slash Commands

Type `/` in the composer for fuzzy autocomplete across all commands and custom skills.

| Category | Command | Description |
| :--- | :--- | :--- |
| **Models & Accounts** | `/models [query]` | Open Model Manager dock to assign models, fallback chains, and test connections |
| | `/login [provider]` | Start OAuth sign-in flow for subscription providers (e.g. `/login anthropic`) |
| | `/logout <account>` | Log out of a provider account and remove cached credentials |
| | `/setup` | Launch the interactive first-run onboarding wizard |
| **Session Control** | `/steer <message>` | Interrupt the active run and switch immediately to a new instruction |
| | `/sessions` | Open session manager to resume, rename (`r`), export (`e`), or delete (`d`) sessions |
| | `/clear` | Clear feed, reset tasks, rotate session ID, and start a fresh session (`Ctrl+L`) |
| | `/compact` | Summarize conversation history to free up context window tokens |
| | `/exit` | Terminate session and exit to shell |
| **Governance & System** | `/mode [mode]` | View or switch consent mode (`ask-everything`, `edit-enabled`, `autonomous`) |
| | `/permissions` | Inspect active capabilities, grants, and deployment ceiling policies |
| | `/settings` | Open interactive settings editor (or `get`/`set <key> <val>` from prompt) |
| | `/context` | Show token breakdown across system instructions, history, tools, and skills |
| | `/skills` | List all discovered skills with paths and tool permissions (or run `/<skill-name>`) |
| | `/gateway` | Manage API gateway targets, routes, credentials, and audit logs |
| | `/?` | Open the built-in keyboard shortcuts cheat sheet |

#### Essential Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+P` | Open command palette (search and run commands & skills) |
| `Ctrl+O` | Expand or collapse tool output blocks and diff viewers |
| `Ctrl+L` | Clear feed and start fresh (same as `/clear`) |
| `Shift+Tab` | Cycle consent mode (`ask-everything` ⇄ `edit-enabled` ⇄ `autonomous`) |
| `Ctrl+C` | Abort current run (or clear draft / exit when idle) |
| `Shift+Enter` | Insert newline in prompt (also `Alt+Enter` or `Ctrl+J`) |
| `↑` / `↓` | Move between prompt lines, or cycle prompt history at the top/bottom boundary |
| `@path` | Fuzzy-find and insert workspace file path |
| `Tab` / `Ctrl+T` | Cycle focus between prompt composer and live interactive widgets |
| `Esc` | Abort run, return focus from widgets to prompt, or close any open overlay |
| `/?` | Show full in-terminal shortcut and command reference |

> **Tip**: In permission prompts, press `1`–`9` to select an option directly, `Enter` to approve, or `Esc`/`q` to deny. In the session selector, press `e` to export JSON, `t` for a text transcript, `r` to rename, and `d` to delete.

---

### 2. TypeScript SDK & Programmatic Usage

Seepient Agent provides a TypeScript SDK for building agent-powered applications.

#### Basic Agent
```ts
import { createSeepient } from 'seepient';

const seepient = await createSeepient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
});

const result = await seepient.chat('List all running Docker containers');
console.log(result.text);
```

#### One-Shot Streaming
```ts
import { askSeepient } from 'seepient';

const stream = await askSeepient('Analyze the logs for errors', {
  provider: 'openai',
  stream: true,
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

#### One-Shot Non-Streaming
```ts
import { askSeepient } from 'seepient';

const result = await askSeepient('Extract the top 3 issues from these logs', {
  provider: 'anthropic',
});
console.log(result.text);
```

#### Programmatic Instance Management
Use `createSeepient` for instance-scoped lifecycle control, custom tool registration, and provider management:

```ts
import { createSeepient } from 'seepient';

// Initialize with automatic settings resolution (~/.seepient/setting.json or env vars)
const seepient = await createSeepient();

// Resolve model assignments dynamically
const resolved = await seepient.resolve({ purpose: 'text', tier: 'standard' });
console.log(`Resolved model: ${resolved.model.id} on ${resolved.providerAccount}`);

// Clean disposal of runtime resources
await seepient.dispose();
```

#### Custom Tools (Explicit Trust Models)
Seepient supports three explicit trust models for custom tools with full permission pipeline governance:

```ts
import { createSeepient, trustedHostTool, preparedTool, brokerConnector } from 'seepient';

// 1. Host Execution (trusted code execution on local machine)
const diskTool = trustedHostTool({
  definition: {
    type: 'function',
    function: {
      name: 'check_disk',
      description: 'Check disk usage',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  execute: async () => JSON.stringify(await getDiskUsage()),
});

// 2. Governed Preparation (custom analyzer, exact-commit execution)
const reportTool = preparedTool({
  definition: {
    type: 'function',
    function: {
      name: 'save_report',
      description: 'Save structured status report',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
      },
    },
  },
  allowedOperationKinds: ['commit-files'],
  analyze: async (args, ctx) => {
    const artifact = await ctx.artifacts.put(Buffer.from(args.content), 'text/plain');
    const target = { canonicalPath: '/workspace/report.txt', exists: false, canonicalParent: '/workspace', basename: 'report.txt', finalSymlink: false };
    return {
      operation: { kind: 'commit-files', commits: [{ destination: target, content: artifact }] },
      effects: [{ kind: 'filesystem-write', targets: [{ target, mode: 'create' }] }],
      risk: 'edit',
      display: { title: 'Save report', summary: 'Write report.txt', canonicalTargets: [target.canonicalPath], effects: ['filesystem-write'] },
    };
  },
});

// 3. Declarative Broker Connector (data-only mapping, zero embedder execution)
const searchTool = brokerConnector({
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search documentation',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  connector: 'web-search',
  mapping: {
    version: 1,
    operation: 'search',
    argumentBindings: { query: '/query' },
    secretRefs: ['tavilyApiKey'],
  },
});

const seepient = await createSeepient({
  provider: 'openai',
  tools: [diskTool, reportTool, searchTool],
});
```

#### Session Persistence
```ts
const seepient = await createSeepient({
  provider: 'anthropic',
  persist: 'my-session',          // Resume a previous session
});
```

#### Programmatic Server Creation & Custom Store Injection
```ts
import { runSeepientServer } from "seepient/server";

// Stateless worker mode with custom runtime and in-memory stores
const server = await runSeepientServer({
  port: 7337,
  runtime: myCustomRuntime,
  persist: myRedisBackend,
  auditStore: myRemoteAuditStore,
});
```

#### Programmatic Gateway Client
```ts
import { gateway } from 'seepient';
const gw = await gateway.createGateway({ enabled: true, semanticTopK: 3, defaultRateLimitPerMin: 60, maxAuditLogsInMemory: 1000 });
```

---

### 3. Command Line Interface (CLI)

The `seepient` command line provides headless automation, scriptable subcommands, and CI/CD integration.

#### Execution Modes & Global Options

Run queries directly from your shell:

```bash
# Headless one-shot: process prompt and exit
seepient "Check disk usage and save the report to usage.txt" --no-interactive

# Autonomous mode (CI/CD): auto-approve tool execution within deployment ceiling
seepient "Refactor src/index.ts to use ES modules" -y

# Quick provider override: specify model or provider for a single run
seepient -p anthropic -m claude-sonnet-4-5-20250929 "Audit this repository for security risks"

# Resume a previous conversation by session ID, or resume the latest session
seepient -r last "Continue with the remaining test failures"
```

##### Global CLI Flags

| Flag | Description |
| :--- | :--- |
| `-m, --model <model>` | Override the model for this query (e.g. `gpt-4o`, `claude-sonnet-4-5-20250929`) |
| `-p, --provider <provider>` | Override the provider account (`openai`, `anthropic`, `glm`, `openai-compatible`) |
| `-n, --no-interactive` | Exit immediately after completing the query (headless execution) |
| `-y, --yes` | Autonomous mode: auto-approve actions within deployment ceiling (alias for `--mode autonomous`) |
| `--mode <mode>` | Set consent mode: `edit-enabled` (default) \| `ask-everything` \| `autonomous` |
| `-r, --resume <id>` | Resume a conversation by session ID, or pass `last` for the most recent session |
| `--docker` | Run in container mode: implies `--no-interactive` and suppresses interactive prompts |

#### Consent Modes & Security Governance

Every tool execution passes through a single, fail-closed Domain policy pipeline (`PolicyEngine` → `ApprovalBroker` → `ExecutionBoundary` → `AuditRecorder`). Seepient enforces three canonical consent modes:

- **`edit-enabled` (Default)**: Pre-approves workspace edits, reads, and normal development tools. Prompts for human confirmation before running high-risk shell commands or outbound network actions.
- **`ask-everything`**: Prompts for confirmation before executing any tool with external side effects or model egress.
- **`autonomous`**: Executes all actions permitted by your deployment ceiling without interactive prompts. Ideal for sandboxed environments or CI/CD pipelines with `-y`.

#### Subcommands Reference

##### Setup Wizard (`seepient setup`)
Configure providers, API keys, and model defaults in an interactive guided wizard:
```bash
seepient setup               # Saves to global config (~/.seepient/setting.json)
seepient setup --project     # Saves to project-level config (.seepient/setting.json)
```

##### Model Management (`seepient models`)
Inspect model assignments, browse the live upstream catalog, and configure routing across purposes (`text`, `vision`, `plan`, `commit`, `media`) and tiers (`standard`, `complex`, `efficient`):

| Subcommand | Description | Key Options |
| :--- | :--- | :--- |
| `models list` | List configured purpose assignments | `--resolved` (show active runtime targets), `--json` |
| `models browse [query]` | Search catalog models with reachability, context window, and pricing | `--reachable-only`, `--json` |
| `models resolve <slot>` | Dry-run preview of the selected target and fallback chain (e.g. `text.standard`) | `--json` |
| `models set <slot> <target>` | Assign a model to a slot (e.g. `text.standard anthropic/claude-sonnet-5`) | `--thinking <none\|low\|medium\|high>`, `--json` |
| `models fallback <slot> <targets>` | Configure ordered fallback candidates (e.g. `anthropic/claude-sonnet-5,openai/gpt-4o`) | `--json` |
| `models status` | Display active assignments and credential health across all slots | `--json` |
| `models check` | Pre-flight sanity check ensuring required model slots are configured | `--require <slots>`, `--offline`, `--json` |
| `models probe <provider>` | Test connectivity, latency, and credential validity for a provider | `--json` |
| `models discover <account>` | Query an account's `/models` endpoint to discover newly available upstream models | `--json` |

##### Provider Account Management (`seepient providers`)
Manage connected provider accounts, credentials, and custom endpoints:

| Subcommand | Description | Key Options |
| :--- | :--- | :--- |
| `providers list` | List all configured provider accounts and their status | `--pool <language\|image>`, `--json` |
| `providers add <id>` | Add a new provider account | `--upstream <provider>`, `--credential env:VAR\|none`, `--url <url>`, `--allow-private`, `--compat <compat>` |
| `providers edit <id>` | Update an existing provider account's configuration | `--upstream`, `--credential`, `--url`, `--allow-private`, `--compat` |
| `providers remove <id>` | Remove a provider account | `--force` (bypass active slot references), `--json` |

##### Authentication & Tokens (`seepient auth`)
Manage provider credentials and issue server API keys:

| Subcommand | Description | Key Options |
| :--- | :--- | :--- |
| `auth login <provider>` | Configure credentials or initiate OAuth sign-in | `--key <apiKey>`, `--env-var <name>`, `--upstream <provider>` |
| `auth logout <provider>` | Remove stored credentials for an account | `--json` |
| `auth issue-token` | Generate a scoped server API key token (SHA-256 hashed at rest) | `--scope <agent:run\|agent:read\|provider:admin\|admin>`, `--label <name>` |

##### Direct Media Generation (`seepient generate`)
Generate or edit images directly from the command line using your configured image model:
```bash
seepient generate image --prompt "Architectural blueprint of a headless agent system" --aspect-ratio 16:9 --output ./assets
```
Supported options: `--prompt <text>`, `--operation <generate|variation|edit|mask>`, `--aspect-ratio <1:1|16:9|9:16>`, `--quality-preset <low|standard|high>`, `--count <n>`, `--image <path>`, `--mask <path>`, `--output <dir>`.

---

### 4. Server Mode

Run Seepient Agent as a standalone HTTP/WebSocket server for remote agent access or stateless worker deployments. The HTTP server operates in inference and planning mode in this release; effectful tool execution fails closed with `backend-unsupported` by design until the isolated worker scheduler ships.

#### Starting the Server
```bash
# Start with default settings (port 7337)
seepient-server

# Generate a server API key
seepient-server --generate-api-key

# Custom port and host
seepient-server --port 8080 --host 0.0.0.0
```

#### REST API
```bash
# Send a chat message
curl -X POST http://localhost:7337/v1/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "Check disk usage", "model": "gpt-5.4"}'

# List active sessions
curl http://localhost:7337/v1/sessions \
  -H "Authorization: Bearer YOUR_API_KEY"

# Model catalog & live resolution
curl http://localhost:7337/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

#### WebSocket Streaming
```ts
const ws = new WebSocket('ws://localhost:7337/ws?token=YOUR_API_KEY');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'chat',
    message: 'Analyze the error logs',
    provider: 'anthropic',
  }));
};

ws.onmessage = (event) => {
  const chunk = JSON.parse(event.data);
  process.stdout.write(chunk.text);
};
```

#### Programmatic Server Creation & Custom Store Injection
```ts
import { runSeepientServer } from "seepient/server";

// Stateless worker mode with custom runtime and in-memory stores
const server = await runSeepientServer({
  port: 7337,
  runtime: myCustomRuntime,
  persist: myRedisBackend,
  auditStore: myRemoteAuditStore,
});
```

---

## Configuration

Seepient loads configuration through a clear hierarchy:

1. **CLI arguments**: Explicit flags take top precedence (e.g. `-m <model>`, `-p <provider>`).
2. **Environment variables**: System shell variables and `.env` files.
3. **Project configuration**: `./.seepient/setting.json` in the current workspace.
4. **Global configuration**: `~/.seepient/setting.json` in your home directory.

### Core environment variables

| Variable | Purpose | Default |
|:---|:---|:---|
| `SEEPIENT_SHELL_APPROVE` | Shell command approval: `auto` (approve all), `deny` (block all), or unset (interactive prompt) | unset |
| `SEEPIENT_CONSENT_MODE` | Runtime permission level: `ask-everything`, `edit-enabled`, or `autonomous` | `edit-enabled` |
| `SEEPIENT_SKILLS_PATH` | Colon-separated list of custom skill directories | unset |
| `SEEPIENT_SESSION_DIR` | Directory for persisted conversation history | `~/.seepient/sessions` |

---

## Provider management

Seepient routes model requests across upstream providers with automatic catalog discovery, multi-target fallback chains, and cross-surface parity between the TUI, CLI, Server, and SDK.

### Setting up providers

You can configure providers in three ways:

#### 1. Zero-config auto-discovery
If you have standard provider API keys in your environment or `.env`, Seepient detects them automatically at boot:
- `OPENAI_API_KEY` (OpenAI)
- `ANTHROPIC_API_KEY` (Anthropic Claude)
- `GEMINI_API_KEY` (Google Gemini)
- `DEEPSEEK_API_KEY` (DeepSeek)
- `GROQ_API_KEY` (Groq)
- `GLM_API_KEY` (Z.ai GLM)

#### 2. Guided wizard and interactive TUI dock
- Run `seepient setup` for the first-run interactive onboarding wizard.
- In the TUI, press `Ctrl+M` or run `/models` to open the Model & Provider Dock. Browse models, test credentials, and switch active tiers visually.

#### 3. CLI commands
Add accounts, sign in with OAuth, and map models from the shell:

```bash
# Sign in with OAuth or configure API keys interactively
seepient auth login openai
seepient auth login anthropic

# Configure using a custom environment variable or key directly
seepient auth login my-openai --env-var CUSTOM_OPENAI_KEY
seepient auth login my-claude --key sk-ant-...

# Register a local endpoint (Ollama, LM Studio, vLLM) without credentials
seepient providers add ollama-local --upstream openai --base-url http://127.0.0.1:11434/v1 --credential none

# Assign default models by purpose and tier
seepient models set text.standard openai/gpt-5.6-terra
seepient models set text.efficient openai/gpt-5.6-luna
seepient models set plan.standard openai/gpt-5.6-sol
```

### Credential storage options

Credentials are never stored in plaintext within version-controlled repositories:

| Storage mode | `kind` | Description |
|:---|:---|:---|
| **OS Keychain** | `keychain` | Encrypted via macOS Keychain or Linux Secret Service. No plaintext keys touch disk. |
| **OAuth / Session** | `seepient` | Secure token storage with automatic token refresh for subscription sign-ins. |
| **Environment pointer** | `env` | Stores only the variable name (e.g. `OPENAI_API_KEY`). The secret stays in your shell environment. |
| **None** | `none` | For local inference endpoints that do not require authentication (e.g. Ollama, LM Studio). |

### Configuration shape (`setting.json`)

When saved to `~/.seepient/setting.json` or `.seepient/setting.json`, your provider configuration and tiered assignments use this format:

```json
{
  "providers": {
    "openai": {
      "adapter": "pi-ai",
      "upstreamProvider": "openai",
      "credential": { "kind": "env", "name": "OPENAI_API_KEY" }
    },
    "anthropic": {
      "adapter": "pi-ai",
      "upstreamProvider": "anthropic",
      "credential": { "kind": "env", "name": "ANTHROPIC_API_KEY" }
    },
    "ollama-local": {
      "adapter": "pi-ai",
      "upstreamProvider": "openai",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "ssrfAllowPrivate": true,
      "credential": { "kind": "none" }
    }
  },
  "modelAssignments": {
    "text": {
      "standard": {
        "providerAccount": "openai",
        "model": "gpt-5.6-terra",
        "fallback": [{ "providerAccount": "anthropic", "model": "claude-sonnet-5" }]
      },
      "efficient": { "providerAccount": "openai", "model": "gpt-5.6-luna" }
    },
    "plan": { "standard": { "providerAccount": "openai", "model": "gpt-5.6-sol" } },
    "media": { "image": { "providerAccount": "openai", "model": "gpt-image-2" } }
  },
  "retryPolicy": {
    "maxAttempts": 3,
    "cooldownThreshold": 3,
    "cooldownDurationMs": 60000
  }
}
```

---

## Integrations

### Gateway (MCP client, REST proxy, OpenAPI adapter)

Seepient includes a universal API gateway that connects to downstream MCP servers and REST APIs:

- **Semantic injection**: Middleware scores your message against all discovered tools and injects the top-K most relevant directly into the agent tool context.
- **Proxy pattern**: Generic tools (`gateway_route`, `gateway_call_tool`) let the agent navigate targets when semantic injection finds no match.
- **OpenAPI import**: Import any OpenAPI spec (JSON/YAML) and auto-register all operations as a REST target.
- **Credential trust guard**: Admin-registered targets can resolve stored credentials; agent-registered targets cannot, preventing credential exfiltration.
- **Audit logging**: Ring-buffer audit logs with per-target usage summaries for debugging and self-healing.

**Configuration** (`~/.seepient/setting.json` or env vars):
```json
{
  "gatewayEnabled": true,
  "gatewaySemanticTopK": 3,
  "gatewayRateLimit": 60,
  "gatewayMaxAuditLogs": 1000
}
```

**Interactive TUI command**: `/gateway list|add|remove|toggle|routes|credentials|audit|usage`

**REST API**: `GET/POST/PATCH/DELETE /v1/gateway/*` (admin scope required for mutations)

**SDK**:
```ts
import { gateway } from 'seepient';
const gw = await gateway.createGateway({ enabled: true, semanticTopK: 3, defaultRateLimitPerMin: 60, maxAuditLogsInMemory: 1000 });
```

### Web Search (Tavily)
Seepient Agent can search the web if you provide a Tavily API Key during setup or in config.
- **Usage**: "Search for the latest Node.js release notes."

### Email (SMTP)
Configure SMTP settings to let the agent send emails.
- **Usage**: "Send an email to user@example.com with the summary of the log file."

### Notifications (Feishu/DingTalk/WeCom)
Configure webhooks to receive alerts or reports in your team chat apps.
- **Usage**: "Notify the team on Feishu that the build has finished."

### Date & Time
Built-in utility to provide the agent with the current system time, ensuring accurate handling of relative time requests.
- **Usage**: "What's the date today?" or "Remind me to check the logs next Monday."

## Skills System

Skills are single `SKILL.md` files with YAML frontmatter that extend the agent with domain-specific prompts and tool restrictions. See [docs/sdk/skills.md](docs/sdk/skills.md) for full documentation.

### Skill Format
```yaml
---
name: docker-ops
description: Docker operations assistant
tags: [docker, devops]
allowedTools: [execute_shell_command, read_file]
args: [environment, service]
model:
  provider: anthropic
  model: claude-sonnet-4-20250514
---

Skill instructions and templates here.
Use {{environment}} and {{service}} for argument substitution.
Reference files with @k8s/deployment.yaml.
```

### Key Features
- **Argument substitution**: `{{argName}}`, `$1`/`$2`/`$ALL` for positional args
- **File references**: `@path/to/file.yaml` injects file contents into the prompt
- **Tool restrictions**: `allowedTools` limits which tools the skill can use
- **Model selection**: `model` overrides provider/model per skill
- **Lazy loading**: skill body is only read when invoked, keeping startup fast
- **Body limits**: bodies over 8k chars warn, over 32k chars truncate (~8k tokens)

### Discovery Locations
Skills are discovered in priority order (last wins):
1. Built-in bundled skills
2. `~/.seepient/skills/`
3. `.seepient/skills/` (project-level)
4. `SEEPIENT_SKILLS_PATH` directories

```bash
# Add custom skill directories
export SEEPIENT_SKILLS_PATH=/path/to/skills:/another/path
```

## Docker support

Seepient includes a production multi-stage [`Dockerfile`](./Dockerfile) based on Node 22 Slim, plus a [`docker-compose.yml`](./docker-compose.yml) file for container deployment.

### Quick start with Docker

```bash
# Clone and build
git clone https://github.com/hashangit/seepient.git
cd seepient
docker build -t seepient .

# Run the server with persistent sessions and a mounted workspace
docker run -d -p 7337:7337 \
  --name seepient-server \
  --env-file .env \
  -v seepient-sessions:/data/sessions \
  -v $(pwd)/workspace:/workspace \
  seepient

# Or start with Docker Compose
docker compose up -d
```

### Run CLI commands in containers

Use `--docker` for non-interactive execution inside containers:

```bash
docker run --rm \
  --env-file .env \
  -v $(pwd)/workspace:/workspace \
  seepient seepient chat "Check disk usage" --docker
```

When Seepient detects a container or non-interactive shell (or when passed `--docker`), it turns off interactive prompts and formats output cleanly for log streams.

### Shell approval in containers

Set `SEEPIENT_SHELL_APPROVE` to control command execution without interactive prompts:
- `auto`: Approve commands automatically (recommended for isolated containers)
- `deny`: Block all shell execution
- _(unset)_: Ask interactively (requires a TTY)

### Docker Compose setup

The repo includes [`docker-compose.yml`](./docker-compose.yml) configured with volume persistence, health checks, and non-root security options:

```yaml
services:
  seepient:
    build: .
    image: seepient:latest
    container_name: seepient-server
    restart: unless-stopped
    env_file:
      - path: .env
        required: false
    environment:
      - SEEPIENT_SESSION_DIR=/data/sessions
    ports:
      - "7337:7337"
    volumes:
      - seepient-sessions:/data/sessions
      - ./skills:/mnt/skills:ro
      - ./workspace:/workspace
    security_opt:
      - no-new-privileges:true

volumes:
  seepient-sessions:
    driver: local
```

### Built-in browser and font support

The production image comes with tools pre-installed for web workflows:
- **System Chromium**: Playwright uses system Chromium (`/usr/bin/chromium`) instead of downloading a separate browser binary.
- **CJK and emoji fonts**: `fonts-noto-cjk` and `fonts-noto-color-emoji` are baked into the image, so web page screenshots render Chinese, Japanese, Korean, and emoji glyphs properly without tofu boxes.
- **Native commit helper**: Compiles and installs `seepient-fs-commit` for exact atomic file operations.
- **Non-root user**: Runs under `appuser` (UID 1001) supervised by `dumb-init` for proper signal handling.

## License

Seepient is distributed under the **Business Source License 1.1 (BSL)** — a
source-available license.

- **Free for personal, non-commercial use** (including students, educators,
  and research), and for short evaluation/internal trial use.
- **Commercial / production use** (including offering Seepient as a managed
  service) requires a commercial license from the Licensor.
- On the **Change Date (2028-01-01)** the Licensed Work automatically becomes
  available under the Apache License 2.0.

See the full terms in [LICENSE](./LICENSE). To obtain a commercial license,
contact the maintainer.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1.  Fork the Project
2.  Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3.  Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4.  Push to the Branch (`git push origin feature/AmazingFeature`)
5.  Open a Pull Request

---
GitHub: [https://github.com/hashangit/seepient](https://github.com/hashangit/seepient)

---
