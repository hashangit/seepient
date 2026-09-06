---
title: Introduction
description: Architecture and design principles of the Seepient headless AI agent framework.
---

# Introduction

Seepient is an automation framework for headless environments. It provides a terminal user interface (TUI), a scripted command-line tool (CLI), a TypeScript SDK, and a standalone server daemon with REST and WebSocket APIs.

## Why headless execution

Many modern AI agent frameworks rely on computer vision: taking screenshots of desktops or browsers, estimating cursor coordinates, and clicking simulated buttons. While useful for legacy desktop software, vision-driven control introduces failure modes:

- Display resolution and DPI scaling changes break click coordinates.
- Operating system dialog popups and window focus steals cause misclicks.
- Network latency during video streaming degrades agent responsiveness.
- Containerized and cloud deployment requires running virtual X11 or Wayland servers, consuming gigabytes of memory for window compositing.

Seepient operates directly against system interfaces: POSIX shell environments, language runtimes, file systems, network sockets, and structured APIs. This approach delivers deterministic execution, low resource consumption, and predictable operation inside automated environments like Docker containers and CI/CD runners.

## Core design principles

### Strict responsibility boundaries

Seepient organizes internal components into unidirectional layers:

- **UI**: Terminal user interface, REPL, and CLI output formatters.
- **Transport**: Authentication, protocol translation, and HTTP/WebSocket adapters.
- **Domain**: Agent execution loops, session lifecycles, and policy evaluation.
- **Capabilities**: Tool implementations, sandbox isolation, and skill registries.
- **Vendors**: Third-party API wrappers for upstream LLM providers.
- **Foundations**: Core contracts, error types, and shared persistence schemas.

User interfaces do not make policy decisions, and transport handlers do not execute shell commands directly.

### Monotonic permission pipeline

Automated agents that write code or run shell commands need guardrails. Seepient enforces a four-stage pipeline:

1. **Policy engine**: Computes the effective permission ceiling across system policies, session settings, and user consent modes.
2. **Approval broker**: Intercepts actions requiring elevation. Approvals can be interactive through the TUI or pre-authorized through CLI flags.
3. **Execution boundary**: Runs the action within an isolated OS jail (macOS Seatbelt or Linux Bubblewrap).
4. **Audit recorder**: Writes every attempted action and its outcome to an append-only file with restricted filesystem permissions.

### Exact file mutations

When language models modify files, they often miscalculate line numbers, truncate surrounding blocks, or hallucinate unrelated changes. 

Seepient rejects fuzzy or unguarded file overwrites. All model-authored file mutations are processed by an atomic commit broker backed by a compiled native helper (`native/fs-commit`). The broker checks pre-image content hashes, matches exact search blocks, and applies atomic replacements. If the file state on disk does not match the model's assumed state, the mutation is refused before disk modification.

## Supported surfaces

You can interact with Seepient through four complementary interfaces:

| Surface | Best for | Primary entrypoint |
|---|---|---|
| **Terminal UI (TUI)** | Daily interactive work, coding sessions, diff reviews | `seepient` |
| **Command-line (CLI)** | Shell scripts, CI pipelines, one-shot questions | `seepient "prompt"` |
| **TypeScript SDK** | Embedding agents into Node.js apps and worker jobs | `import { createSeepient } from 'seepient'` |
| **Server daemon** | Centralized agent backend, Docker containers, multi-client webhooks | `seepient-server --port 7337` |

## Platform support

- **macOS (arm64 and x64)**: Full support including Seatbelt sandboxing and native atomic commits.
- **Linux (x64 and arm64)**: Full support including Bubblewrap container sandboxing and native atomic commits.
- **Windows**: Chat, planning, and file reading work normally. Model-authored file writes are refused before approval because the native atomic commit helper does not yet have a win32 build. File writes require running inside WSL2 or a Linux container.
