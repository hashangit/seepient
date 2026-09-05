---
title: How Seepient works
description: System architecture of Seepient across Surfaces, The Brain, The Hands, and Memory.
---

# How Seepient works

Seepient is built around a practical separation of concerns: how you interact with the agent, how the agent plans and decides, how it safely touches the host environment, and what it remembers.

Rather than running unchecked model code directly on your machine, Seepient organizes operations into four distinct functional regions:

<DiagramFlow
  :steps="[
    { title: 'Surfaces', tagline: 'Talk to it', chips: ['Terminal UI (TUI)', 'CLI & REPL', 'Server API', 'Worker SDK'] },
    { title: 'The Brain', tagline: 'Decides what happens', chips: ['Agent Loop', 'Model Router', 'Permission Engine', 'Approval Inbox', 'Skills', 'Secret Shield & Egress Gate'] },
    { title: 'The Hands', tagline: 'Acts on the world', chips: ['Sandboxed Execution (Seatbelt / Bubblewrap)', 'Rust Exact-Commit Broker', 'Built-in Tools', 'MCP Gateway'] },
    { title: 'Memory', tagline: 'What it keeps', chips: ['Session History', '0600 Audit Log', 'Settings', 'Vault'] }
  ]"
/>
You can view the <a href="/seepient/seepient-architecture.html" target="_blank" rel="noreferrer">interactive architecture diagram</a> in full screen.

---

## 1. Surfaces: talk to it from anywhere

Seepient exposes the same agent engine across four interfaces:

- **Terminal UI (TUI)**: A full-screen interactive interface built with Ink and React. It provides real-time streaming, interactive widgets, a diff viewer for proposed file edits, and an approval prompt for system actions.
- **Command-line (CLI)**: A streamlined interface for one-shot prompts, piped shell workflows (for example, `git diff | seepient`), and headless execution with the `-y` flag for automated CI runners.
- **Server API**: A standalone Node.js service offering an HTTP REST management API and a WebSocket streaming protocol for remote clients, web UIs, and containerized deployments.
- **Worker SDK**: A TypeScript client library allowing application developers to embed Seepient directly into existing backends, serverless workers, and distributed pipelines with custom storage adapters.

No matter which surface receives a request, the request flows into the same domain loop, enforces the same security policies, and records to the same audit log.

---

## 2. The brain: decides what happens

The Brain contains the coordination, reasoning, and policy logic.

- **Agent loop**: Orchestrates multi-step reasoning. It constructs context, prompts the language model, parses tool invocations, streams responses, and tracks turn status.
- **Model router**: Routes each task to the right model using the Purpose × Tier matrix (`text`, `commit`, `plan`, `vision`, `media` crossed with `standard`, `complex`, `efficient`). It handles provider discovery, circuit breaker cooldowns, and automatic fallback chains.
- **Permission engine**: Evaluates every requested action against active consent modes (`always-ask`, `ask-untrusted`, `autonomous-trusted`). It prevents privilege escalation and ensures no tool bypasses user intent.
- **Approval inbox**: A durable, file-locked store where pending permission requests wait for human confirmation. Pending requests survive process restarts and power cycles.
- **Skills registry**: Discovers local and workspace `SKILL.md` playbooks, injecting task-specific context and instructions on demand without permanently bloating the token budget.
- **Secret shield and egress gate**: Inspects tool inputs and model payloads to redact sensitive environment variables, API keys, and credential references before network transmission.
- **Self-change guard**: Prevents an agent from silently modifying its own security constraints, permission settings, or audit log paths without explicit external approval.
- **Hooks and middleware**: Extension points where developers can register pre-prompt and post-action handlers for logging, metric collection, and custom validation.

---

## 3. The hands: acts on the world

When the agent decides to act, it delegates the operation to protected capability boundaries rather than executing raw code directly.

- **Sandboxed execution**: On macOS, commands execute inside a restricted Seatbelt profile (`sandbox-exec`). On Linux, processes run inside an unprivileged Bubblewrap sandbox (`bwrap`). The sandbox restricts filesystem writes to the current project directory and blocks access to sensitive host directories like `~/.ssh` and `/etc`.
- **Rust exact-commit broker**: Model-authored file writes are handled by a dedicated native binary (`native/fs-commit`). The broker validates pre-image content hashes and line targets before writing. If a target file changed on disk or if the model's targeted lines do not match exactly, the write fails closed without modifying the file.
- **Built-in tools**: 15 integrated capabilities for reading files, editing code, running shell commands, querying web search, inspecting websites, and sending notifications. Effectful tools create `PreparedActionDraft` structures that must be approved before execution.
- **Media generators**: Direct integrations with Fal, Google Imagen, and OpenAI for generating and editing visual assets.
- **MCP and OpenAPI gateway**: Connects external Model Context Protocol (MCP) servers and OpenAPI endpoints, exposing third-party services as typed tools within the agent loop.

---

## 4. Memory: what it keeps

State in Seepient is structured, persistent, and verifiable.

- **Session history**: Stores conversation messages, reasoning tokens, tool invocations, and command outputs. Sessions can be listed, resumed, forked into alternate branches, or exported to markdown.
- **Tamper-evident audit log**: An append-only ledger recorded with strict `0600` filesystem permissions (readable only by the owner). Every tool call, approved action, rejected proposal, and sandbox violation is written using atomic fsync commits.
- **Settings manager**: Resolves and merges settings across global configuration (`~/.seepient/config.json`), workspace configuration, environment variables, and CLI overrides.
- **Credential vault**: Keeps API keys, tokens, and OAuth credentials isolated from model context. When supported by the host OS, secrets reside in the system keychain rather than plaintext files.
