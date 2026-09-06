---
title: Command-line interface
description: One-shot prompts, scriptable automation, and command-line execution with Seepient.
---

# Command-line interface

The Seepient CLI is designed for non-interactive automation, shell scripts, and CI/CD pipelines where a full-screen interactive interface is impractical.

## When to use CLI vs TUI vs SDK

- Use the **TUI** (`seepient`) when you are actively writing code, reviewing diffs, and collaborating interactively with the agent in a terminal.
- Use the **CLI** (`seepient "prompt"`) when you want a quick one-shot answer, need to pipe data through standard Unix streams, or want to run automated batch jobs in a shell script.
- Use the **SDK** (`createSeepient`) when you are embedding agent behavior into a Node.js web server, desktop app, or serverless worker.

---

## One-shot execution

To execute a task and exit immediately upon completion, pass the prompt string as an argument:

```bash
seepient "Find all TODO comments in src/ and output a prioritized markdown list"
```

Seepient initializes the agent loop, executes the necessary tool calls (such as searching files or reading code), prints the formatted response to standard output, and exits with code 0.

## Non-interactive automation (`-y`)

By default, effectful operations (like modifying files or running shell commands) prompt for confirmation. In automated environments where no human is present, use the `-y` or `--no-interactive` flag to auto-approve safe actions:

```bash
seepient -y "Update all dependencies in package.json to latest compatible versions"
```

When combined with sandboxed execution, `-y` runs commands safely inside the macOS Seatbelt or Linux Bubblewrap jail without human intervention.

## Overriding providers and models

You can override default configuration directly from the command line:

```bash
# Use a specific provider and model
seepient --provider anthropic --model claude-3-7-sonnet "Audit this codebase"

# Route to the high-reasoning complex tier
seepient --tier complex "Resolve the race condition in the worker scheduler"
```
