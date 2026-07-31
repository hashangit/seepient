---
description: "Research notes for spec 002: how Hermes Agent & OpenClaw integrate messaging platforms"
---

# Research: Hermes Agent & OpenClaw Messaging Integration

Notes gathered during the spec 002 planning round (2026-06-14). These informed the
design in `spec.md`. Sources are listed at the bottom; some are community/blog
sources dated 2026 and should be treated as directional rather than authoritative —
the github.com/NousResearch links are the primary references for Hermes.

## 1. Hermes Agent (Nous Research)

Hermes Agent is an open-source, self-improving AI assistant built by Nous Research.
Its tagline — "lives where you do" — captures the core design: one agent, many
messaging surfaces.

### 1.1 Architecture

- **Single gateway process.** A long-running gateway connects to 14–27 messaging
  platforms through a unified messaging subsystem. One process bridges to every
  connected channel.
- **Two entry points.** Either start the local terminal UI (`hermes`), or run the
  gateway and chat remotely from any connected messaging app.
- **Per-channel personas.** Each platform can inject a `channel_prompt`, giving
  different personas/behaviors per channel (e.g., terse on SMS, expansive on
  Discord).
- **Voice memo support.** Cross-platform voice transcription and replies.

### 1.2 Deploy

- Runs on a cheap VPS (a $5/month instance works).
- One-line curl install, or one-click VPS templates.
- Managed hosting options exist (e.g. flowengine.cloud) for one-click deploys with
  auto-SSL.

### 1.3 Per-channel overrides

- GitHub issue #1955 — "per-channel model and system prompt overrides for gateway"
  documents that the gateway originally used a single global model + system prompt
  for all channels; users who wanted per-channel differentiation had to run
  separate gateway instances. The fix introduces per-channel overrides.
- Issue #23735 — multi-profile deployments in a single gateway: "same personality,
  many endpoints" vs. multi-blueprint (multiple personas).

### 1.4 Allowlists

- Per-channel allowlist prevents unauthorized users from running up your LLM bill
  ("allowlist patterns that prevent randos from running up your LLM bill" — LumaDock
  Telegram guide).

### 1.5 Telegram specifics

- Polling vs. webhook. Webhook = Telegram pushes updates to your HTTPS endpoint for
  "sleep when idle" deployments.
- Per-channel model and system prompt overrides (post-#1955).

## 2. OpenClaw (formerly Clawdbot)

OpenClaw is an open-source, self-hosted personal AI agent framework. Its organizing
principle is "one brain, many surfaces."

### 2.1 Architecture (4 layers)

| Layer | Responsibility | Key Pattern |
|-------|---------------|-------------|
| **Gateway** | Connection management | Single long-lived process |
| **Integration** | Platform adapters | Protocol-specific libraries |
| **Execution** | Agent runtime | Owns built-in agent runtime (`src/agents/`) |
| **Intelligence** | LLM providers | Model helpers (`src/llm/`) |

The Gateway is a WebSocket server that connects to messaging platforms and control
interfaces, dispatching each routed message to the Agent runtime.

### 2.2 Channel Adapter interface (the model we adopt)

- **Explicit typed `Channel` interface** in the plugin-SDK. You implement a class.
- Bundled adapters live under `src/channels/` (e.g. `src/channels/whatsapp`,
  `src/channels/telegram`), with extension code under `extensions/<name>/`.
- Channels are **inbound message sources**. Each adapter polls or receives webhook
  events, authorizes the sender against per-channel allowlists
  (`src/channels/allow-from.ts`), and computes a hash-based identity.
- The agent runtime is **channel-agnostic**: "the agent doesn't know or care which
  messaging platform a message came from. Channels are adapters that normalize
  inbound/outbound messages." (HackMD deep dive)

### 2.3 Platform libraries

- **WhatsApp** — **Baileys**, a TypeScript library that speaks the WhatsApp Web
  WebSocket protocol. QR-based pairing (no Twilio API required).
- **Telegram** — Bot API via **grammY**.
- **Slack** — Workspace apps via **Bolt** (Slack's official Node.js framework).
- **Discord** — **discord.js** (servers, channels, DMs).
- **Microsoft Teams** — Referenced in the integrations list, less documented.
- **Signal, iMessage, WebChat** — Also supported in the unified Gateway.

### 2.4 Message lifecycle

- Refactoring toward **one durable unified pipeline** (the "message-lifecycle-
  refactor" doc). The target replaces scattered channel inbound, reply dispatch,
  preview streaming, and outbound delivery helpers with a single pipeline.

### 2.5 Security

- Per-channel allowlist via higher-order functions and generics for unified
  security policies across platforms.
- A published security analysis (arXiv 2603.27517) notes each adapter polls or
  receives webhook events, authorizes senders against per-channel allowlists, and
  computes a hash-based identity.

## 3. Comparison: Hermes vs OpenClaw

| Dimension | Hermes | OpenClaw |
|---|---|---|
| Adapter contract | Implicit (config-driven) | Explicit typed `Channel` interface in plugin-SDK |
| Identity | Home channel + allowlist | `allow-from.ts` hash-based sender identity per channel |
| Message lifecycle | Per-channel inbound/reply helpers | Refactoring toward one durable unified pipeline |
| WhatsApp | Multi-provider (Cloud API + others) | Baileys (WhatsApp Web, QR pairing) |
| Telegram | Polling or webhook | grammY |
| Slack | Bolt-based | Bolt |
| Discord | discord.js | discord.js |
| Teams | Referenced, less documented | Referenced in integrations list |
| Multi-persona | Per-channel `channel_prompt` (#1955) | Per-channel persona config |
| Deploy | $5 VPS, one-line install | Self-hosted/local-first |
| Extensibility | Config + personas | Plugin SDK (write a channel class, register in-process) |

### 3.1 What we adopt from each

- **From OpenClaw:** the explicit typed Channel interface (matches Seepient's
  TypeScript-first, interface-driven style); the channel-agnostic runtime
  principle; the `src/channels/` directory layout.
- **From Hermes:** the single long-lived gateway process model (one process, many
  platforms); the per-channel allowlist as a first-class concern; the "lives where
  you do" framing for the agent identity.
- **Industry-standard libraries:** Baileys (WhatsApp), grammY (Telegram), Bolt
  (Slack), discord.js (Discord), Bot Framework (Teams).

## 4. The 5 invariant concerns

Distilled from both frameworks, these are the concerns every messaging adapter must
solve. They drive the `ChannelAdapter` interface design in `spec.md` §5.

1. **Inbound normalization** — platform event (webhook/poll) → canonical message.
2. **Sender authorization** — allowlist/denylist per channel; identity hashing for
   audit.
3. **Conversation → session mapping** — platform chat/channel/thread ID → agent
   session (history + state).
4. **Outbound delivery** — agent response → platform API call, with chunking (size
   limits), format adaptation (Markdown support varies), rate-limit handling.
5. **Lifecycle** — connect/disconnect/reconnect; long-lived process; graceful
   shutdown.

Plus cross-cutting: media (voice memos, images), tool-approval UX (inline buttons
where supported), proactive outbound (agent-initiated, not just replies).

## 5. How this maps onto Seepient

Seepient's existing adapter architecture already centralizes the agent loop in one
`runAgentLoop` consumed by three runtime adapters (CLI, SDK, Server). Adding
messaging channels is a natural fourth adapter family — they all consume the same
core contract.

The two things Seepient must add that its current adapters don't need:

1. **A shared `ChannelGateway` runtime** that owns the 5 invariant concerns once,
   so each platform adapter only implements the genuinely platform-specific bits.
   This avoids the "scatter" OpenClaw is mid-refactor to escape (their
   message-lifecycle-refactor).
2. **Typed identity + resolver (the B+C session model)** because messaging is
   inherently multi-conversation, multi-sender, and multi-platform — concerns that
   CLI/SDK/Server don't have but messaging channels cannot avoid.

See `spec.md` §4 (identity & sessions), §5–6 (ChannelAdapter + ChannelGateway) for
the concrete design.

## Sources

### Hermes Agent (primary)
- Official docs — Messaging Gateway: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
- Integrations overview: https://hermes-agent.nousresearch.com/docs/integrations/
- GitHub repository: https://github.com/nousresearch/hermes-agent
- Gateway internals (developer guide): https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/gateway-internals.md
- Per-channel model and system prompt overrides (issue #1955): https://github.com/NousResearch/hermes-agent/issues/1955
- Multi-profile deployments in a single gateway (issue #23735): https://github.com/NousResearch/hermes-agent/issues/23735
- Telegram-specific guide: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram

### Hermes Agent (community/secondary)
- LumaDock — Hermes Telegram bot setup and reliability (allowlist patterns): https://lumadock.com/tutorials/hermes-telegram-gateway-setup
- MarkTechPost — Nous Research Ships Hermes Agent Profile Builder: https://www.marktechpost.com/2026/06/11/nous-research-ships-hermes-agent-profile-builder-identity-model-skills-and-mcp-servers-in-one-dashboard-flow/
- dev.to — Nous Research Hermes Agent Setup and Tutorial Guide: https://dev.to/paimon_573760ccaa1b3492b4/nous-research-hermes-agent-setup-and-tutorial-guide-2glg

### OpenClaw
- Architecture overview: https://ppaolo.substack.com/p/openclaw-system-architecture-overview
- Dissecting OpenClaw (Sau Sheong): https://sausheong.com/dissecting-openclaw-733213e9c853
- Architecture deep dive (HackMD): https://hackmd.io/Z39YLHZoTxa7YLu_PmEkiA
- Message lifecycle refactor: https://docs.openclaw.ai/concepts/message-lifecycle-refactor
- Agent runtime architecture: https://docs.openclaw.ai/agent-runtime-architecture
- Building channel plugins: https://docs.openclaw.ai/plugins/sdk-channel-plugins
- Plugin internals: https://docs.openclaw.ai/plugins/architecture
- OpenClaw Architecture Explained (Easton Dev): https://eastondev.com/blog/en/posts/ai/20260205-openclaw-architecture-guide/
- Lessons from OpenClaw's Architecture for Agent Builders (Ali Ibrahim): https://techwithibrahim.medium.com/lessons-from-openclaws-architecture-for-agent-builders-243921dcbbad
- A Security Analysis of the OpenClaw AI Agent Framework (arXiv): https://arxiv.org/html/2603.27517v3
- OpenClaw Journey: Building Unified Message Models (tonylixu): https://tonylixu.medium.com/openclaw-journey-four-how-to-build-unified-message-models-and-universal-socket-for-agents-b2b494219a0d

> Note: several OpenClaw sources (arXiv paper, some blog posts) are dated 2026 and
> may be speculative or community-generated rather than authoritative. The official
> docs.openclaw.ai links and the Substack/Medium architecture overviews are the
> most reliable; specific code-path details should be verified against the
> OpenClaw source before being relied upon. For Seepient's purposes the *architectural
> patterns* (channel-agnostic runtime, unified message model, per-channel
> allowlist) are well-corroborated across sources and are what we adopted.
