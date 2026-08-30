# Configuration

Configure Seepient Agent to work with your preferred LLM provider and customize behavior for your use case.

::: info Bring Your Own API Key
Seepient Agent does **not** provide LLM inference. You bring your own API keys from inference providers (OpenAI, Anthropic, GLM, or any OpenAI-compatible service). The minimum to get started is **one** provider API key (e.g., `OPENAI_API_KEY`).
:::

## Environment Variables

The easiest way to configure Seepient Agent is through environment variables.

### Required Variables

Set **at least one** provider-specific API key:

| Variable | Provider |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GLM_API_KEY` | GLM |
| `OPENAI_COMPAT_API_KEY` | OpenAI-compatible providers |

### Optional Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_PROVIDER` | Default provider to use | `openai` |
| `LLM_MODEL` | Override default model for any provider | Provider-specific |

::: tip
These are framework settings, not API keys. `LLM_PROVIDER` tells Seepient Agent which inference provider to route to. `LLM_MODEL` overrides the default model for the active provider. Provider-specific overrides (`OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GLM_MODEL`, `OPENAI_COMPAT_MODEL`) take priority over `LLM_MODEL`.
:::

### Provider-Specific Keys and Settings

| Variable | Provider | Notes |
|----------|----------|-------|
| `OPENAI_API_KEY` | OpenAI | Required for OpenAI provider |
| `OPENAI_MODEL` | OpenAI | Default model override (default: `gpt-5.4`) |
| `ANTHROPIC_API_KEY` | Anthropic | Required for Anthropic provider |
| `ANTHROPIC_MODEL` | Anthropic | Default model override (default: `claude-sonnet-4-6-20260320`) |
| `GLM_API_KEY` | GLM | Required for GLM provider |
| `GLM_MODEL` | GLM | Default model override (default: `opus`) |
| `OPENAI_COMPAT_API_KEY` | OpenAI-compatible | API key for your custom inference provider |
| `OPENAI_COMPAT_BASE_URL` | OpenAI-compatible | Base URL for your custom inference provider (required) |
| `OPENAI_COMPAT_MODEL` | OpenAI-compatible | Model name at your inference provider (default: `gpt-5.4`) |

### Example Configuration

::: code-group

```bash [macOS/Linux]
export OPENAI_API_KEY=sk-your-key-here
export LLM_PROVIDER=openai
export OPENAI_MODEL=gpt-5.4
```

```bash [Windows CMD]
set OPENAI_API_KEY=sk-your-key-here
set LLM_PROVIDER=openai
set OPENAI_MODEL=gpt-5.4
```

```bash [.env file]
OPENAI_API_KEY=sk-your-key-here
LLM_PROVIDER=openai
OPENAI_MODEL=gpt-5.4
```

:::

::: tip Using .env Files
The Seepient Agent **CLI** automatically loads `.env` files in your project root. If you are using the **SDK** in your own application, you must handle `.env` loading yourself (e.g., `import 'dotenv/config'` at the top of your entry file).
:::

## Programmatic Configuration

For programmatic control over accounts and catalogs in embedder environments, use `createSeepient`:

```typescript
import { createSeepient } from 'seepient'

// Instantiate an isolated Seepient instance with memory storage
const seepient = await createSeepient({
  overlayFile: ':memory:',
})

// Add provider accounts programmatically
await seepient.addProvider({
  id: 'team_anthropic',
  provider: 'anthropic',
  auth: { type: 'api_key', key: process.env.ANTHROPIC_API_KEY! },
})

// List available models across all configured providers
const catalog = await seepient.getCatalog()
const providers = await seepient.listProviders()
```

## Per-Request Overrides

Override configuration for individual requests:

```typescript
import { generateText } from 'seepient'

const result = await generateText('Hello!', {
  provider: 'anthropic', // Override default provider
  model: 'claude-opus-4-6-20260320' // Override default model
})
```

## Supported Providers

### OpenAI

```typescript
const result = await generateText('Hello!', {
  provider: 'openai',
  model: 'gpt-5.4' // Primary
  // Also available: 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
  //   'gpt-5.3-instant', 'gpt-5.3-codex', 'o3', 'o3-mini'
})
```

**Environment Variables:**
- `OPENAI_API_KEY` (required)

**Available Models:**
- `gpt-5.4` (primary, recommended)
- `gpt-5.4-pro` (advanced)
- `gpt-5.4-mini` (balanced)
- `gpt-5.4-nano` (fastest)
- `gpt-5.3-instant` (low-latency)
- `gpt-5.3-codex` (code-optimized)
- `o3` (reasoning)
- `o3-mini` (lightweight reasoning)

**Default model:** `gpt-5.4` (when no model is specified)

### Anthropic

```typescript
const result = await generateText('Hello!', {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6-20260320' // Primary
  // Also available: 'claude-opus-4-6-20260320', 'claude-haiku-4-5-20251001'
})
```

**Environment Variables:**
- `ANTHROPIC_API_KEY` (required)

**Available Models:**
- `claude-sonnet-4-6-20260320` (primary, balanced)
- `claude-opus-4-6-20260320` (most capable)
- `claude-haiku-4-5-20251001` (fastest)

**Default model:** `claude-sonnet-4-6-20260320` (when no model is specified)

### GLM

```typescript
const result = await generateText('Hello!', {
  provider: 'glm',
  model: 'opus' // GLM-5.1 (default)
  // Also available: 'haiku' (GLM-4.5 Air), 'sonnet' (GLM-4.7)
})
```

**Environment Variables:**
- `GLM_API_KEY` (required)

**Available Models:**
- `opus` (alias for GLM-5.1, recommended)
- `sonnet` (alias for GLM-4.7)
- `haiku` (alias for GLM-4.5 Air)

**Default model:** `opus` (when no model is specified)

### OpenAI-Compatible

Use any provider that speaks the OpenAI API format (Ollama, vLLM, Together AI, local models, self-hosted LLMs, third-party proxies, etc.):

```typescript
const result = await generateText('Hello!', {
  provider: 'openai-compatible',
  model: 'custom-model'
})
```

**Environment Variables:**
- `OPENAI_COMPAT_API_KEY` (required -- your inference provider's API key)
- `OPENAI_COMPAT_BASE_URL` (required -- your inference provider's base URL)
- `OPENAI_COMPAT_MODEL` (optional -- model name at your provider, default: `gpt-5.4`)

**Example with Ollama:**
```bash
export OPENAI_COMPAT_API_KEY=ollama
export OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1
```

**Example with Together AI:**
```bash
export OPENAI_COMPAT_API_KEY=your-together-api-key
export OPENAI_COMPAT_BASE_URL=https://api.together.xyz/v1
```

## Advanced Configuration

### Custom Tool Execution

```typescript
import { generateText, trustedHostTool } from 'seepient'

const pingTool = trustedHostTool({
  definition: {
    type: 'function',
    function: {
      name: 'ping',
      description: 'Ping health check',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  execute: async () => 'pong',
})

const result = await generateText('Ping server', {
  permissionPipeline: true,
  tools: [pingTool],
})
```

### Timeout and Abort

Use `AbortController` with the `signal` option for timeout control:

```typescript
const controller = new AbortController()
setTimeout(() => controller.abort(), 30000) // 30 seconds

const result = await generateText('Hello!', {
  provider: 'openai',
  signal: controller.signal
})
```

## TypeScript Configuration

Seepient Agent is fully typed. Import types for better developer experience:

```typescript
import type {
  ProviderType,
  GenerateTextOptions,
  StreamTextOptions,
  GenerateTextResult
} from 'seepient'

const options: GenerateTextOptions = {
  provider: 'openai',
  model: 'gpt-5.4'
}
```

## Skill Configuration

Environment variables for customizing skill discovery and behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `SEEPIENT_SKILLS_PATH` | *(none)* | Colon-separated list of additional skill directories |
| `SEEPIENT_NO_BUNDLED_SKILLS` | `false` | Set to `true` to disable built-in bundled skills |
| `SEEPIENT_SKILL_BODY_MAX_CHARS` | `32000` | Maximum skill body size in characters before truncation (~8k tokens) |
| `SEEPIENT_SKILL_BODY_WARN_CHARS` | `8000` | Warning threshold for skill body size in characters (~2k tokens) |
| `SEEPIENT_SKILLS_DEBUG` | *(none)* | Set to `true` to enable debug logging for skill discovery |

::: tip
Skills are discovered in priority order (last wins): built-in bundled skills, `~/.seepient/skills/`, `.seepient/skills/`, then `SEEPIENT_SKILLS_PATH` directories. See the [Skills documentation](/sdk/skills) for the full SKILL.md format and features.
:::

## Consent Modes & Permissions

Control which tools auto-execute vs. require human approval using Seepient's fail-closed Domain policy pipeline (`PolicyEngine` → `ApprovalBroker` → `ExecutionBoundary` → `AuditRecorder`).

### Consent Modes

| Mode | Behavior |
|------|----------|
| `edit-enabled` *(default)* | Workspace edits, reads, and normal operations are pre-approved; prompts for high-risk shell commands and outbound external communications |
| `ask-everything` | Prompts for human approval on every tool execution with side effects or model egress |
| `autonomous` | Automatically approves all actions permitted by the deployment ceiling without interactive prompts |

### CLI Flags & Commands

```bash
seepient --mode ask-everything   # Prompt for all side-effecting tools
seepient --mode edit-enabled     # Auto-approve edits/reads; prompt on high risk (default)
seepient --mode autonomous       # Zero interactive prompts (same as -y / --yes)
seepient -n                      # Headless mode (fails closed if unapproved)
```

In interactive TUI mode, you can type `/mode [mode]` or press `Shift+Tab` to cycle modes live.

### Environment Variable & Settings

| Setting | Values | Default |
|---------|--------|---------|
| `permissions.consentMode` / `SEEPIENT_CONSENT_MODE` | `ask-everything`, `edit-enabled`, `autonomous` | `edit-enabled` |

### SDK Usage

```typescript
import { generateText, createAgent } from 'seepient'

await generateText('Refactor codebase', {
  consentMode: 'autonomous' // Or 'edit-enabled' | 'ask-everything'
})

const agent = createAgent({
  consentMode: 'edit-enabled'
})
```

## Next Steps

- Explore [all available providers](/sdk/providers)
- Learn about [custom tools](/sdk/custom-tools)
- Learn about [skills](/sdk/skills)
- Check [production best practices](/guides/production-checklist)

::: info Configuration Priority
Seepient Agent resolves configuration in this order:
1. Per-request options
2. Programmatic configuration
3. Environment variables
4. Default values
:::
