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

For more control, use `configureProviders()`:

```typescript
import { configureProviders, generateText } from 'seepient'

// Configure all providers at once
configureProviders({
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-5.4'
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-6-20260320'
  },
  glm: {
    apiKey: process.env.GLM_API_KEY,
    model: 'opus'
  },
  default: 'openai'
})

// Use the configured provider
const result = await generateText('Hello!', {
  provider: 'openai' // Uses configured API key
})
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

### Custom Tool Configuration

```typescript
import { configureProviders } from 'seepient'

configureProviders({
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-5.4'
  },
  default: 'openai'
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

## Permission Levels

Control which tools auto-execute vs. require human approval using a risk-based permission matrix.

### Levels

| Level | Behavior |
|-------|----------|
| `strict` | All tools require approval |
| `moderate` | Safe tools auto-execute; edit, communications, and destructive tools require approval |
| `permissive` | Safe, edit, and communications tools auto-execute; destructive tools require approval |

### Tool Risk Categories

| Category | Examples | Auto in `moderate` |
|----------|----------|---------------------|
| `safe` | `read_file`, `get_current_datetime`, `web_search`, `read_website` | Yes |
| `edit` | `write_file`, `optimize_prompt`, `use_skill` | No |
| `communications` | `send_email`, `send_notification` | No |
| `destructive` | `execute_shell_command`, `take_screenshot`, `generate_image` | No |

Custom tools default to `destructive` (deny-by-default). Custom tools can specify a `risk` field when registered via `tool()`.

### CLI Flags

```bash
seepient --strict       # All tools require approval
seepient --moderate     # Safe tools auto-execute (default)
seepient --yolo         # Only destructive tools require approval
seepient --headless     # No approval prompts; denied tools fail silently
```

### Environment Variable

| Variable | Values | Default |
|----------|--------|---------|
| `SEEPIENT_PERMISSION` | `strict`, `moderate`, `permissive` | `moderate` |

### SDK Usage

```typescript
import { generateText } from 'seepient'

await generateText('List my files', {
  permissionLevel: 'strict' // All tools require approval callback
})
```

### Server Configuration

The server supports a `maxPermissionLevel` ceiling per connection. Clients can request a per-message level, but it is capped at the server-configured maximum:

```typescript
// Server startup
const server = createServer({
  maxPermissionLevel: 'moderate' // Clients cannot exceed moderate
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
