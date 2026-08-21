# Seepient Agent 🦞

[![NPM Version](https://img.shields.io/npm/v/seepient.svg?style=flat-square)](https://www.npmjs.com/package/seepient)
[![NPM Downloads](https://img.shields.io/npm/dm/seepient.svg?style=flat-square)](https://www.npmjs.com/package/seepient)
[![GitHub Release](https://img.shields.io/github/v/tag/hashangit/seepient?style=flat-square&label=release)](https://github.com/hashangit/seepient/releases)
[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-blue.svg?style=flat-square)](https://github.com/hashangit/seepient/blob/main/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)

**The Engineering-First Headless Agent Framework: CLI, SDK, and Server. Stable, Scalable Automation for the Post-Vision Era.**

---

🔗 **GitHub Repository**: [https://github.com/hashangit/seepient](https://github.com/hashangit/seepient)

---

Seepient Agent is a high-stability, open-source automation framework specifically engineered for **headless systems**.

Unlike "screen-seeing" agents (such as OpenClaw) that rely on visual interpretation, Seepient Agent is built on a foundation of precise command-driven execution. This makes it significantly more **stable**, **robust from an engineering perspective**, and **easier to scale** across complex environments—whether it's a local server, a CI/CD pipeline, or thousands of containerized nodes.

## Why Seepient Agent?
- 🐳 **Docker Native**: Built to run safely inside containers. Minimal footprint (Node.js/Alpine friendly).
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
- 📦 **TypeScript SDK v2**: Programmatic access via `createSeepient`, `createAgent`, `streamText`, `generateText`.
- 🖥 **Server Mode**: Standalone HTTP/WebSocket server with REST v2 management API (`/v1/providers`, `/v1/models` with ETag/If-Match), API key auth, and session management.
- 🛠 **Skills System**: Loadable skill packs from directories with `@path` file references, turn-scoped skill switching, and custom tool creation.
- 🛡️ **Security & Permission Pipeline**: Single Domain-owned enforcement pipeline (`PolicyEngine` → `ApprovalBroker` → `ExecutionBoundary` → `AuditRecorder`) default-on across CLI, TUI, SDK, and HTTP/WebSocket server.
- 🔒 **Fail-Closed Isolation & SSRF Defense**: Process containment (macOS Seatbelt / Linux Bubblewrap) and exact-file write helpers fail closed; SSRF guards prevent metadata reflection.
- 💾 **Durable Approvals & 0600 Audit**: File-locked atomic NDJSON stores and append-only `0600` audit logs (`~/.seepient/audit.log`) with fsync before mutation commits.
- 🐳 **Server Worker Backend**: ephemeral Docker worker container scheduler with mTLS transport, Ed25519/HMAC signed dispatches, and secret-free worker execution environments.
- 🖥️ **Interactive TUI**: In a TTY, a full-screen Ink/React UI — bordered always-on input, streaming feed, session manager, message queue/`/steer`, and inline `write_file` diffs (atomic, crash-safe writes).
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
// Main exports
import { createAgent, streamText, generateText } from 'seepient';
// Server utilities
import { createServer } from 'seepient/server';
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

1.  **Setup**: Run the interactive setup wizard to configure your API keys and integrations.
    ```bash
    seepient setup
    ```
    The wizard now supports configuring multiple providers (OpenAI, Anthropic, GLM) in a single session.

2.  **Run**: Start the agent in interactive mode.
    ```bash
    seepient
    ```

## Usage

### Interactive Mode
Simply run `seepient` to enter the chat loop.
```bash
seepient
> List all TypeScript files in the src folder.
```

### Interactive TUI

In a terminal (TTY), `seepient` launches a full-screen Ink/React TUI instead of the readline loop: a bordered always-visible input, a streaming message feed, a persistent task panel (`manage_todos`), session list/resume/export, and inline diffs for `write_file`. File writes are atomic (same-dir temp + `fs.rename`, so a crash never corrupts the file) and render as a green/red unified diff in the tool block; Ctrl+O expands collapsed blocks, and `/clear` starts a fresh session. It falls back to the readline REPL when piped or run with `--no-interactive`.

### Headless Mode (One-Shot)
Run a single command and exit.
```bash
seepient "Check disk usage and save the report to usage.txt" --no-interactive
```

### Auto-Confirm (CI/CD)
Automatically approve all tool executions (dangerous, use with caution or in sandboxes).
```bash
seepient "Refactor src/index.ts to use ES modules" -y
```

### Provider Selection
Use a specific provider for a single command:
```bash
seepient -p anthropic "Analyze this code for security issues"
```

### Switch Providers Mid-Conversation
In interactive mode, type `/models` to switch between configured providers:
```bash
seepient
> /models  # Select Anthropic from the list
> Now analyze this with Claude...
```

### CLI Options
- `-m, --model <model>`: Specify the LLM model (default: `gpt-4o`).
- `-p, --provider <provider>`: Specify the LLM provider (`openai-compatible`, `openai`, `anthropic`, `glm`).
- `-n, --no-interactive`: Exit after processing the initial query (Headless mode).
- `-y, --yes`: Auto-confirm all tool executions (e.g., shell commands).
- `--docker`: Run in Docker-optimized non-interactive mode (auto-detected in containers).
- `--generate-api-key`: Generate an API key for server mode (use with `seepient-server`).

### Interactive Commands
- `/models`: Switch between configured providers during a conversation.
- `/exit` or `/quit`: End the session.

## Configuration

Seepient Agent uses a hierarchical configuration system.

**Priority Order (Highest to Lowest):**
1.  **CLI Arguments**: (e.g., `-m gpt-4o`)
2.  **Environment Variables**: (`OPENAI_API_KEY`, `.env` file)
3.  **Project Config**: (`./.seepient/setting.json` in current directory)
4.  **Global Config**: (`~/.seepient/setting.json`)

### Supported Configuration Keys (JSON)

**Environment Variables:**
- `SEEPIENT_SHELL_APPROVE`: Shell command approval mode (`auto`, `deny`, or unset for interactive)
- `SEEPIENT_SKILLS_PATH`: Colon-separated list of additional skill directories
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GLM_API_KEY`: Provider API keys
- `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL`: OpenAI-compatible provider settings

### Provider Management (v2 Architecture)

Seepient Agent v0.4.4 features unified Provider Management with purpose × tier routing, dynamic upstream catalog discovery, multi-target automatic fallback, circuit-breaker cooldowns, and credential stores:

**Configuration (`~/.seepient/setting.json` or `.seepient/setting.json`):**
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

### CLI Commands for Models & Providers
- `seepient models list`: List configured model assignments across purposes and tiers.
- `seepient models browse [query] [--json] [--reachable-only]`: Search catalog models with reachability, context window, and pricing.
- `seepient models resolve <purpose.tier> [--json]`: Dry-run resolution preview with active target, fallback chain, and unresolvables.
- `seepient models set <purpose.tier> <account/model>`: Update an assignment (e.g. `seepient models set text.standard anthropic/claude-sonnet-5`).
- `seepient models fallback <purpose.tier> <account/model>,...`: Configure ordered fallback candidates.
- `seepient models status`: Display live status and thinking levels for active assignments.
- `seepient models probe <provider>`: Test provider connectivity and credentials.
- `seepient models discover <account>`: Discover available models from the account's `/models` endpoint.
- `seepient providers add/edit/remove/list`: Manage configured provider accounts (supports `--credential env:NAME|none`).
- `seepient auth login/logout/issue-token`: Manage credentials, OAuth device-code flows, and scoped management tokens.

### Interactive TUI & Slash Commands
- `/models`: Open the Model Manager dock to manage purpose assignments, test accounts, and browse the model catalog.
- `/login [provider]`: Start an OAuth sign-in flow directly from the conversation composer.
- `/logout [account]`: Log out of a provider account and remove cached credentials.
- `/setup`: Launch the first-run onboarding setup wizard.

> **⚠️ Security Note**: Never commit API keys or secrets in plaintext into git repositories. Use environment variables (e.g., `OPENAI_API_KEY`), `seepient auth login` with system keychain storage, or OAuth device sign-in.

## Integrations

### Gateway (MCP Client + REST Proxy + OpenAPI Adapter)

Seepient Agent v0.3.0 introduces a universal API gateway that connects to downstream MCP servers and REST APIs:

- **Semantic Injection**: Middleware scores your message against all discovered tools and injects the top-K most relevant directly into the agent's tool context. Zero context pollution.
- **Proxy Pattern**: Generic tools (`gateway_route`, `gateway_call_tool`, etc.) let the agent navigate targets when semantic injection finds no match.
- **OpenAPI Import**: Import any OpenAPI spec (JSON/YAML) and auto-register all operations as a REST target.
- **Credential Trust Guard**: Admin-registered targets can resolve stored credentials; agent-registered targets cannot — preventing credential exfiltration.
- **Audit Logging**: Ring-buffer audit logs with per-target usage summaries for debugging and self-healing.

**Configuration** (`~/.seepient/setting.json` or env vars):
```json
{
  "gatewayEnabled": true,
  "gatewaySemanticTopK": 3,
  "gatewayRateLimit": 60,
  "gatewayMaxAuditLogs": 1000
}
```

**CLI Commands**: `/gateway list|add|remove|toggle|routes|credentials|audit|usage`

**REST API**: `GET/POST/PATCH/DELETE /v1/gateway/*` (admin scope required for mutations)

**SDK**:
```ts
import { gateway } from 'seepient';
const gw = await gateway.createGateway({ enabled: true, semanticTopK: 3, defaultRateLimitPerMin: 60, maxAuditLogsInMemory: 1000 });
```

### Multi-Provider LLM Support
Seepient Agent supports multiple AI providers with seamless switching:
- **OpenAI**: GPT-4, GPT-3.5-turbo, and latest models
- **Anthropic**: Claude Sonnet, Haiku, Opus models
- **GLM**: Z.ai GLM-4.5, GLM-4.7, GLM-5.1 models
- **OpenAI-Compatible**: DeepSeek, LocalLLM, Ollama, LM Studio, and any OpenAI-compatible endpoint

Configure multiple providers during setup and switch between them using `/models` command or `-p` flag.

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

## SDK & Programmatic Usage

Seepient Agent provides a TypeScript SDK for building agent-powered applications.

### Basic Agent
```ts
import { createAgent } from 'seepient';

const agent = await createAgent({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
});

const result = await agent.chat('List all running Docker containers');
console.log(result.text);
```

### Streaming
```ts
import { streamText } from 'seepient';

const stream = await streamText('Analyze the logs for errors', {
  provider: 'openai',
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

### Structured Output
```ts
import { generateText } from 'seepient';

const result = await generateText('Extract the top 3 issues from these logs', {
  provider: 'anthropic',
});
console.log(result.text);
```

### Programmatic Instance (SDK v2)

Use `createSeepient` for instance-scoped lifecycle control, custom tool registration, and stream handling:

```ts
import { createSeepient } from 'seepient';

// Initialize with automatic settings resolution (~/.seepient/setting.json or env vars)
const seepient = await createSeepient();

// One-shot generation with purpose/tier routing
const response = await seepient.generateText('Explain quantum computing in three bullet points');
console.log(response.text);

// Clean disposal of runtime resources
await seepient.dispose();
```

### Custom Tools
```ts
import { createAgent, tool } from 'seepient';

const agent = await createAgent({
  provider: 'openai',
  tools: [
    tool({
      name: 'check_disk',
      description: 'Check disk usage',
      parameters: {},
      execute: async () => {
        const usage = await getDiskUsage();
        return JSON.stringify(usage);
      },
    }),
  ],
});
```

### Session Persistence
```ts
const agent = await createAgent({
  provider: 'anthropic',
  persist: 'my-session',          // Resume a previous session
});
```

## Server Mode

Run Seepient Agent as a standalone HTTP/WebSocket server for remote agent access.

### Starting the Server
```bash
# Start with default settings
seepient-server

# Generate an API key
seepient-server --generate-api-key

# Custom port
seepient-server --port 8080
```

### REST API
```bash
# Send a prompt
curl -X POST http://localhost:7337/api/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "Check disk usage", "provider": "openai"}'

# List sessions
curl http://localhost:7337/api/sessions \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### WebSocket Streaming
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

## Docker Support

Seepient Agent includes a production-ready [`Dockerfile`](./Dockerfile) (Node 22.19 Slim) and [`docker-compose.yml`](./docker-compose.yml) for containerized deployment.

### Quick Start with Docker

```bash
# Clone and build
git clone https://github.com/hashangit/seepient.git
cd seepient
docker build -t seepient-server .

# Run the server
docker run -d -p 7337:7337 \
  -e OPENAI_API_KEY=sk-... \
  seepient-server

# Or use Docker Compose
docker compose up -d
```

### Docker-Optimized CLI Mode
Use `--docker` for non-interactive execution inside containers:
```bash
docker run --rm \
  -e OPENAI_API_KEY=sk-... \
  -e SEEPIENT_SHELL_APPROVE=auto \
  seepient-server seepient "Check disk usage" --docker
```

Seepient Agent auto-detects Docker and non-interactive environments. When running in a container, it adjusts behavior accordingly (no interactive prompts, streamlined output).

### Shell Approval in Containers
Set `SEEPIENT_SHELL_APPROVE` to control how shell commands are approved without interactive prompts:
- `auto`: Automatically approve all commands (use in trusted/sandboxed environments)
- `deny`: Deny all shell command execution
- _(unset)_: Interactive prompt (default, requires a TTY)

```yaml
# docker-compose.yml example
services:
  seepient:
    build: .
    ports:
      - "7337:7337"
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - SEEPIENT_SHELL_APPROVE=auto
      - SEEPIENT_SKILLS_PATH=/app/skills
```

### Non-Latin Font Issues in Screenshots
When running Seepient Agent inside a Docker container (especially Alpine or Debian Slim), screenshots of websites with non-Latin text (e.g., CJK characters) may display text as square boxes ("tofu") due to missing fonts. Emojis (e.g., 🔥) may also appear as squares.

**Solution:** Install CJK (Chinese/Japanese/Korean) and Emoji fonts in your container.

**For Debian/Ubuntu:**
```bash
apt-get update && apt-get install -y fonts-noto-cjk fonts-wqy-zenhei fonts-noto-color-emoji
```

**For Alpine Linux:**
```apk add font-noto-cjk font-noto-emoji```

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

