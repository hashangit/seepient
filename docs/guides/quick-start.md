---
title: Quick start
description: Get up and running with Seepient in under two minutes.
---

# Quick start

This guide walks through installing Seepient, configuring your first provider, and running a prompt across the interactive TUI, the CLI, and the TypeScript SDK.

## Step 1: Install Seepient

Install the package globally using your preferred package manager. Seepient requires Node.js 22.19 or higher.

::: code-group

```bash [Homebrew (macOS / Linux)]
brew tap hashangit/seepient
brew trust hashangit/seepient
brew install seepient
```

```bash [pnpm]
pnpm add -g seepient
```

```bash [npm]
npm install -g seepient
```

:::

Verify the installation:

```bash
seepient --version
```

## Step 2: Configure your providers

Run the interactive setup wizard:

```bash
seepient setup
```

The wizard discovers supported models from upstream catalogs, lets you input credentials (pasting an API key, linking an environment variable, or signing in via OAuth), and assigns default models for common tasks.

Alternatively, export your API key in your current shell environment:

::: code-group

```bash [OpenAI]
export OPENAI_API_KEY="sk-..."
```

```bash [Anthropic]
export ANTHROPIC_API_KEY="sk-ant-..."
```

```bash [Google Gemini]
export GEMINI_API_KEY="..."
```

:::

## Step 3: Run the interactive TUI

Run `seepient` without arguments to start the full-screen terminal interface:

```bash
seepient
```

You can type prompts in the input box at the bottom. The TUI streams the response token by token, renders markdown tables and code blocks, and shows an approval dialog when the model requests permission to execute a shell command or mutate a file.

Press `Ctrl+C` or type `/quit` to exit.

## Step 4: Run a one-shot command from the CLI

To run a prompt directly without opening the interactive interface, pass the prompt string as an argument:

```bash
seepient "Inspect this directory and list any package.json scripts"
```

For non-interactive automation in shell scripts or CI pipelines, add the `-y` flag to automatically approve actions:

```bash
seepient -y "Run test suites and print a failure summary if any fail"
```

You can also pipe standard input directly to the agent:

```bash
git diff | seepient "Review this diff for missing test cases and edge cases"
```

## Step 5: Use the TypeScript SDK

Install the SDK locally in your project:

```bash
pnpm add seepient
```

Create a file named `agent.ts`:

```typescript
import { createSeepient } from 'seepient'

const agent = await createSeepient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6-20260320',
})

const response = await agent.chat('Explain what this repository does based on its README.md')
console.log(response.text)
```

Run the script with Node.js or `tsx`:

```bash
npx tsx agent.ts
```

## Next steps

- Explore the [Terminal UI](/tui/overview) features, widgets, and keyboard shortcuts.
- Read about [headless automation](/cli/headless-and-piping) for shell scripts and CI.
- Learn how [model routing](/guides/model-routing) routes tasks across provider tiers.
- Understand how [exact commit protection](/security/exact-commit) keeps file writes safe.
