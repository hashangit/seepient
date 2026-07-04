# Quick Start

Get up and running with Seepient Agent in under 5 minutes. This guide covers the essentials to start building AI-powered applications.

## Step 1: Set Up Your Provider API Key

First, get an API key from your preferred provider:

- **OpenAI**: [platform.openai.com](https://platform.openai.com/api-keys)
- **Anthropic**: [console.anthropic.com](https://console.anthropic.com/)
- **GLM**: [open.bigmodel.cn](https://open.bigmodel.cn/)

Then set it as an environment variable:

::: code-group

```bash [macOS/Linux]
export OPENAI_API_KEY=your-api-key-here
```

```bash [Windows CMD]
set OPENAI_API_KEY=your-api-key-here
```

```bash [Windows PowerShell]
$env:OPENAI_API_KEY="your-api-key-here"
```

:::

::: tip Other Providers
You can use provider-specific keys like `ANTHROPIC_API_KEY` or `GLM_API_KEY` instead. See [Configuration](/getting-started/configuration) for all options.
:::

## Step 2: Your First Generation

Create a file called `hello.js`:

```typescript
import { generateText } from 'seepient'

async function main() {
  const result = await generateText('Write a haiku about AI agents', {
    provider: 'openai',
    model: 'gpt-5.4'
  })

  console.log(result.text)
}

main()
```

Run it:

```bash
node hello.js
```

You should see a haiku printed to your console!

## Step 3: Use Tools

Seepient Agent includes 12 built-in tools. Let's use one:

```typescript
import { generateText } from 'seepient'

async function main() {
  const result = await generateText('List all files in the current directory', {
    provider: 'openai',
    model: 'gpt-5.4',
    tools: ['execute_shell_command'] // Enable shell tool
  })

  console.log(result.text)
}

main()
```

The agent can now execute shell commands to answer your question.

::: warning Security
Always validate tool usage in production. The shell tool can execute any command.
:::

## Step 4: Stream Responses

For a better user experience, stream responses in real-time:

```typescript
import { streamText } from 'seepient'

async function main() {
  const stream = await streamText('Explain quantum computing', {
    provider: 'openai',
    model: 'gpt-5.4'
  })

  for await (const chunk of stream.textStream) {
    process.stdout.write(chunk)
  }
}

main()
```

::: tip Interrupting Responses
Using the CLI? Press **ESC** at any time while the agent is responding to cancel mid-stream. The in-flight request is aborted, tool execution stops between steps, and your conversation context is preserved so you can continue chatting immediately.
:::

## Step 5: Switch Providers

Change providers with a single line:

::: code-group

```typescript [OpenAI]
const result = await generateText('Hello!', {
  provider: 'openai',
  model: 'gpt-5.4'
})
```

```typescript [Anthropic]
const result = await generateText('Hello!', {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6-20260320'
})
```

```typescript [GLM]
const result = await generateText('Hello!', {
  provider: 'glm',
  model: 'opus'
})
```

:::

All other code remains the same!

## Step 6: Create an Agent

For complex, multi-step tasks, use `createAgent`:

```typescript
import { createAgent } from 'seepient'

async function main() {
  const agent = await createAgent({
    provider: 'openai',
    model: 'gpt-5.4',
    tools: ['execute_shell_command', 'read_file', 'web_search']
  })

  const response = await agent.chat('Research the latest AI news and summarize it')

  console.log(response.text)
}

main()
```

The agent will automatically plan and execute multiple tool calls to complete the task.

## What's Next?

Congratulations! You've covered the basics. Here's what to explore next:

### Core Features

- **[Structured Output](/sdk/structured-output)** - Get type-safe JSON responses
- **[Custom Tools](/sdk/custom-tools)** - Build your own tools
- **[Skills System](/sdk/skills)** - Share reusable AI behaviors

### Server & Deployment

- **[REST API](/server/rest-api)** - Build HTTP endpoints
- **[WebSocket API](/server/websocket-api)** - Real-time streaming
- **[Deployment](/server/deployment)** - Deploy to production

### Guides

- **[Build Your Own UI](/guides/build-your-own-ui)** - Create custom interfaces
- **[Production Checklist](/guides/production-checklist)** - Best practices

::: info Need Help?
Check out our [GitHub Discussions](https://github.com/hashangit/seepient/discussions) or open an issue if you run into problems.
:::
