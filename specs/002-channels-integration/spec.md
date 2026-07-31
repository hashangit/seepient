---
description: "Design spec for 2-way messaging channels (WhatsApp, Telegram, Slack, Discord, Teams) on Seepient"
status: draft
round_deliverable: "Design spec only — no implementation this round. tasks.md follows after approval."
---

# 002 — Channels Integration: 2-Way Messaging for Seepient

**Status:** Draft
**Date:** 2026-06-14
**Predecessor:** `specs/001-tui-upgrade` (TUI upgrade)
**Companion:** `research.md` (Hermes/OpenClaw source notes)

## Approved scope decisions

| Decision | Choice |
|---|---|
| Deliverable this round | **Design spec only** (no code; `tasks.md` is a follow-up) |
| Reference platform | **Telegram** (grammY) |
| Deploy model | **Single `seepient-channels` binary** runs all enabled platforms |
| 2-way comms scope | **Full** — text + media + tool approval + proactive outbound |
| Session model | **B+C** — typed identity in core + `IdentityResolver` |

---

## 0. Executive summary

Seepient today has three **runtime adapters** (CLI, SDK, Server) that all delegate to one `runAgentLoop`. This spec adds a fourth adapter family — **Channels** — bringing 2-way messaging to WhatsApp, Telegram, Slack, Discord, and Microsoft Teams, including proactive (agent-initiated) outbound.

The work decomposes into four tracks, ordered by dependency:

1. **Cleanup & prerequisites** — fix a Server history bug; rename overloaded "gateway" terminology so the architecture is legible before we extend it.
2. **Identity & session foundation (B+C)** — typed identity on `Message`/`SessionData` plus `SessionRegistry` and `IdentityResolver` in core. The foundation for both Channels and the future memory layer.
3. **ChannelAdapter interface + ChannelGateway runtime** — the shared machinery every platform adapter reuses.
4. **Telegram reference adapter + `seepient-channels` binary** — validates the whole vertical with one working platform.

End state: `seepient-channels` runs Telegram 2-way (text + tool approval + proactive) with conversation history threaded; a second platform ships behind the same interface with no interface/core changes; CLI/SDK/Server are unchanged; no persisted-session migration.

---

## 1. Research summary (Hermes Agent & OpenClaw)

Full source notes in `research.md`. Distilled:

### 1.1 Where the two frameworks agree (the invariant pattern)

Both independently arrived at the same architecture:

- One **long-lived gateway process** connects to all platforms.
- The agent runtime is **single and platform-blind**; platforms are **thin adapters** that normalize inbound (platform → canonical) and outbound (canonical → platform API).
- A **per-channel allowlist** gates who can talk to the agent.
- Per-platform libraries are now industry-standard: **Baileys** (WhatsApp Web), **grammY** (Telegram), **Bolt** (Slack), **discord.js** (Discord), **Bot Framework** (Teams).
- Webhook vs. long-poll is a per-platform deploy decision, not an architectural one.

### 1.2 Where they differ (shapes our design)

| Dimension | Hermes | OpenClaw | Seepient choice |
|---|---|---|---|
| Adapter contract | Implicit (config-driven) | **Explicit typed `Channel` interface** in plugin-SDK | **OpenClaw's model** — matches Seepient's TypeScript-first, interface-driven style |
| Identity | Home channel + allowlist | `allow-from.ts` hash-based sender identity per channel | **Typed `IdentityResolver`** (richer than both — B+C) |
| Message lifecycle | Per-channel inbound/reply helpers | Refactoring toward one durable unified pipeline | **`ChannelGateway` owns one inbound pipeline + one outbox** |
| Multi-persona | `channel_prompt` per platform | Per-channel persona config | Per-channel `systemPromptOverride` on `ChannelAdapter` |

### 1.3 The 5 concerns every messaging adapter must solve

These are invariant across all 5 target platforms and drive the interface design:

1. **Inbound normalization** — platform event → canonical `InboundMessage`.
2. **Sender authorization** — allowlist/role check per channel.
3. **Conversation → session mapping** — platform chat/thread ID → Seepient session + identity.
4. **Outbound delivery** — agent response → platform API (chunking, format adaptation, rate-limit handling).
5. **Lifecycle** — connect/disconnect/reconnect; long-lived; graceful shutdown.

Plus cross-cutting: inbound media (voice/images), tool-approval UX (inline buttons where supported), and proactive outbound (agent-initiated messages).

---

## 2. Track 1a — Terminology refactor

### 2.1 Problem

"Gateway" is overloaded across 5 distinct things (verified in code):

| Thing | Layer | File |
|---|---|---|
| `MCPGateway` class | Engine (target/proxy manager) | `src/gateway/gateway.ts` |
| `/gateway` CLI command | CLI management UI | `src/adapters/cli/commands/gateway.ts` |
| `/v1/gateway/*` REST routes | HTTP management API | `src/adapters/server/rest-gateway.ts` |
| `gatewayMiddleware` variable | Core middleware pipeline | `src/adapters/server/index.ts`, `src/adapters/cli/bootstrap.ts` |
| 10× `gateway_*` tools | Tool registry | `src/gateway/tool-factory.ts` |

The variable named `gatewayMiddleware` is the worst offender: it's a one-element array of `semanticToolInjectionMiddleware`, which makes "gateway" sound like a middleware layer. It isn't. The gateway is a target/proxy engine that *produces* a middleware.

### 2.2 Decision (confirmed)

- **`MCPGateway` → `ToolsGateway`** (class + `src/gateway/gateway.ts` + all import sites). The engine gateways to external *tool* servers (MCP + REST), so name it for what it gateways.
- **`gatewayMiddleware` variable → `semanticToolMiddleware`** everywhere it's wired (`cli/bootstrap.ts`, `server/index.ts`, SDK re-export).
- **Adapters (CLI/SDK/Server/Channels) → "Runtime Adapters"** in all docs (`ARCHITECTURE.md`, `AGENTS.md`). They are loop initiators.
- `/gateway` command and `/v1/gateway/*` routes keep their user-facing names (operators know them); the engine class and handler files get the rename. This keeps the operator surface stable while fixing internal terminology.

### 2.3 Architectural clarification this enshrines

```
Runtime Adapters (CLI / SDK / Server / Channels)
        │ *initiate* the loop — call runAgentLoop
        ▼
   runAgentLoop(options) ── options.middleware ──► semanticToolMiddleware
                                                        ▲
                                                        │ *feeds* the middleware
                                                 ToolsGateway (engine)
                                                 — target/proxy manager
                                                 — MCP clients + REST proxy
                                                 — audit + routes
```

Three distinct layers: **adapters initiate** the loop; **ToolsGateway feeds** a middleware that adapters **opt into**. "Gateway" is not a kind of adapter and never was.

### 2.4 Scope

Mechanical, low-risk rename. Touches: class name, import sites, the variable, docs. No behavior change. Lands as the very first commit so all subsequent work uses corrected names.

---

## 3. Track 1b — Server history bug fix (prerequisite)

### 3.1 Problem (verified)

`serverStreamText` / `serverGenerateText` in `src/adapters/server/server-core.ts:34-40, 107-113` build a **fresh `messages: [userMsg]` on every call**. The WS handler manages the session separately and only appends the final assistant message on `onDone`. Net effect: **each Server chat is processed with zero prior context** unless the client resends full history.

CLI and SDK do the right thing — they own `messages[]` and pass it in, giving multi-turn context:
- CLI (`agent.ts:50-56`): `Agent` instance holds `messages[]`, seeded with a system message.
- SDK (`sdk/agent.ts:97`): closure-scoped `messages[]`, optionally persisted via `PersistenceBackend`.

### 3.2 Fix

Bring Server to parity with CLI/SDK: in `handleChat` (`ws-handlers.ts`), load the session's history from `ServerSessionManager`, pass the full `messages[]` into `serverStreamText`, and let the loop mutate it. After the turn, persist the updated array back to the session.

Surgical and independent — no dependency on the channels work. Land it before or alongside Track 2.

### 3.3 Verify

- A two-turn WS conversation where turn 2 references turn 1 now works server-side.
- `pnpm test` green.
- Existing server tests updated to cover multi-turn context.

---

## 4. Track 2 — Identity & session foundation (B+C)

The load-bearing track. Creates the typed schema + resolver that Channels AND the future memory layer build on. **It must be done right, not fast.**

### 4.1 Why B+C (the chosen approach)

- **B (typed identity in core):** `Message` gains `authorId`/`authorName`/`authorRole`; `SessionData` gains `platform`/`conversationId`/`conversationType`/`botId`/`userId`. Gives the model structured author awareness in group chats (today impossible — every human speaker is an undifferentiated `role: "user"`), and gives sessions a real composite key.
- **C (IdentityResolver):** maps platform-scoped senders (`wa:447700900123`, `tg:12345`) → one canonical `userId`, resolves permissions, checks allowlist. Decouples "who is this" from "run the loop".

**B and C are not either/or** — C sits on top of B's schema. Both ship in this spec.

### 4.2 Forward-compatibility with the memory layer

The planned memory layer (conversation threads → graphs + vectors, cross-session, sessions stay separate) is **fully compatible, and B+C is a prerequisite**.

Cross-session memory needs a **stable canonical identity to join sessions by** — which does not exist today (`Message` has no `authorId`; `SessionData` has no `userId`). Five decisions are baked into B+C *now* so the memory layer slots in later without rework:

1. `Message.authorId` stores the **resolved canonical userId**, not the raw platform id. Raw id stored separately as `platformSenderId` for audit. (Memory keys embeddings by canonical identity.)
2. `SessionData.userId` is the resolved canonical user, populated by the resolver.
3. `SessionRegistry` **emits events** (`sessionSaved`, `messageAppended`) — the hook memory subscribes to for incremental indexing.
4. The resolver is **idempotent and cacheable** — memory can re-index transcripts without thrashing external lookups.
5. `Message.id` stays stable — memory keys per-message embeddings by `(sessionId, messageId)`.

Sessions stay separate (each conversation its own `SessionData`); memory reads across them by canonical `userId`. No conflict.

### 4.3 Where sessions live today, and what changes

**Today (verified):**

| Aspect | Mechanism |
|---|---|
| Interface | `PersistenceBackend`: `save(id, data)`, `load(id)`, `delete(id)`, `list()` — pure key-value |
| File backend | `~/.seepient/sessions/{sessionId}.json`, atomic writes (temp+rename). Default path. |
| Memory backend | `Map<string, SessionData>` |
| Session ID | Opaque UUID string, validated `/^[a-zA-Z0-9-]+$/` (no colons/slashes) |
| Indexing | **None.** `list()` returns all filenames. No query by user/platform/conversation. |
| Events | **None.** `save()` is fire-and-forget. No way to know when a session mutated. |
| TTL/ownership | Core has none. Server adapter layers TTL + `apiKeyHash` ownership on top. |

**What changes — and what does NOT:**

The `PersistenceBackend` interface is **unchanged**. The file backend is **unchanged**. Session IDs stay UUIDs. **No migration of existing sessions.** Additive layers above the KV backend:

```
┌──────────────────────────────────────────────────────────────┐
│  Memory Layer (FUTURE)                                       │
│  ─ subscribes to SessionRegistry.events                      │
│  ─ reads transcripts via PersistenceBackend                  │
│  ─ writes VectorStore (embeddings, keyed by userId/msgId)    │
│  ─ writes GraphStore (entities/relations, keyed by userId)   │
└──────────────────────────────▲───────────────────────────────┘
                               │ events: sessionSaved, messageAppended
┌──────────────────────────────┴───────────────────────────────┐
│  SessionRegistry (NEW — core)                                │
│  ─ indexes: (platform,conversationId,botId?) → sessionId    │
│             userId → sessionIds[]                            │
│  ─ resolveSession(identity) → SessionData (or creates one)   │
│  ─ delegates transcript save/load to PersistenceBackend      │
│  ─ emits mutation events                                     │
└──────────────────────────────▲───────────────────────────────┘
                               │ uses
┌──────────────────────────────┴───────────────────────────────┐
│  IdentityResolver (NEW — core, the "C")                      │
│  ─ allowlist check                                           │
│  ─ platform-scoped sender → canonical userId                 │
│  ─ per-sender permission/role                                │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  PersistenceBackend (EXISTING — UNCHANGED)                   │
│  ─ KV: save(id, SessionData) / load(id) / delete / list      │
│  ─ file (~/.seepient/sessions/{id}.json) + memory backends      │
│  ─ remains the transcript source of truth                    │
└──────────────────────────────────────────────────────────────┘
```

**Critical design point — why this needs no migration:** the composite identity lives in *typed fields*, NOT encoded in the session id string. Encoding (e.g. `tg:12345`) would collide, fight the `/^[a-zA-Z0-9-]+$/` regex, and require backend changes. Instead, the session ID stays a UUID and the composite identity lives in typed fields + a registry index. Existing UUID sessions keep working; new sessions just additionally populate the typed fields. The file backend is oblivious.

### 4.4 Schema additions (`src/core/types.ts`) — all optional, additive

**`Message`** (additive, all optional to avoid breaking existing persisted messages):

```ts
export interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  timestamp: number;
  // NEW (Track 2) — identity. Optional: omitted on legacy messages & system/tool roles.
  authorId?: string;         // canonical userId (post-resolution)
  authorName?: string;       // display name for prompt rendering
  authorRole?: AuthorRole;   // "admin" | "member" | "guest"
  platformSenderId?: string; // raw platform-scoped id (audit/debug)
}

export type AuthorRole = "admin" | "member" | "guest";
```

**`SessionData`** (additive):

```ts
export interface SessionData {
  id: string;              // stays a UUID — opaque, unchanged
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  provider?: ProviderType;
  model?: string;
  metadata?: Record<string, unknown>;
  // NEW (Track 2) — conversation identity. Optional on legacy sessions.
  platform?: ChannelPlatform;          // platform discriminator
  conversationId?: string;             // platform-native chat/channel/thread id
  conversationType?: ConversationType; // "dm" | "group" | "channel"
  botId?: string;                      // which bot account received this (multi-bot deploys)
  userId?: string;                     // resolved canonical user (join key for memory layer)
}

export type ChannelPlatform =
  | "telegram" | "whatsapp" | "slack" | "discord" | "teams"
  | "cli" | "sdk" | "server";

export type ConversationType = "dm" | "group" | "channel";
```

All new fields optional → no migration, legacy renders unchanged, existing tests green by construction.

### 4.5 Author-awareness in the loop

When the loop renders a user message for the LLM and `authorId` is present **and** `conversationType !== "dm"` (group/channel), prefix the content with the author name so the model can tell speakers apart:

```
[Alice]: what's the deploy command?
[Bob]: she means staging
```

In DMs, suppress the prefix (single speaker — noise). This is a small change in message-to-provider conversion (`src/core/message-convert.ts`) gated on `conversationType === "dm"`. Existing CLI/SDK/Server sessions have no `conversationType`, so they're unaffected.

### 4.6 `SessionRegistry` (new — `src/core/session-registry.ts`)

Wraps a `PersistenceBackend` and adds the two things channels and memory need that the raw backend lacks: **indexing** and **events**.

```ts
export interface SessionRegistry {
  /** Lookup by composite conversation identity (channels). Loads or creates. */
  resolveSession(identity: ConversationIdentity): Promise<SessionData>;
  /** Lookup by canonical user (memory layer, admin tools). */
  sessionsForUser(userId: string): Promise<SessionData[]>;
  /** Mutations (emit events). */
  save(session: SessionData): Promise<void>;
  appendMessage(sessionId: string, message: Message): Promise<void>;
  delete(sessionId: string): Promise<void>;
  /** Event subscription (memory layer hooks here). */
  on(event: "sessionSaved" | "messageAppended", handler: (payload: SessionEvent) => void): () => void;
}

export interface ConversationIdentity {
  platform: ChannelPlatform;
  conversationId: string;
  botId?: string;
}

export interface SessionEvent {
  type: "sessionSaved" | "messageAppended";
  sessionId: string;
  userId?: string;
  message?: Message;
  timestamp: number;
}
```

**Internals:**
- Delegates `save`/`load`/`delete` to the wrapped `PersistenceBackend` (unchanged interface).
- Maintains in-memory indexes: `(platform, conversationId, botId?)` → `sessionId`, and `userId` → `sessionId[]`.
- Indexes rebuild from `backend.list()` on startup (lazy, cached).
- Emits events *after* a successful backend write.
- The backend stays dumb KV — the registry owns the query/event layer above it.

### 4.7 `IdentityResolver` (new — `src/core/identity-resolver.ts`, the "C")

Channel adapters call it on every inbound message.

```ts
export interface IdentityResolver {
  resolve(input: ResolveInput): Promise<ResolvedIdentity>;
}

export interface ResolveInput {
  platform: ChannelPlatform;
  platformSenderId: string;   // raw, e.g. "447700900123", "U012ABCD"
  conversationId: string;     // platform-native chat id
  conversationType: ConversationType;
  senderName?: string;        // display name if the platform provides it
  botId: string;
}

export interface ResolvedIdentity {
  authorized: boolean;
  userId: string;             // canonical, stable across platforms
  role: AuthorRole;           // admin | member | guest
  displayName: string;
  reason?: string;            // why denied, if authorized=false
}
```

**Built-in `AllowlistIdentityResolver`:**
- Reads an allowlist from settings (`channels.<platform>.allowlist`, `channels.<platform>.admins`).
- Maps `platformSenderId` → canonical `userId` via a configurable strategy (default: `"${platform}:${senderId}"` — opaque but stable; advanced: a user-supplied mapping function or external directory).
- Returns `authorized: false` for non-allowlisted senders; the gateway then drops the message (optionally sends a polite refusal).
- This covers the Hermes/OpenClaw baseline (home channel + allowlist) and is richer (typed role + canonical id).

**Pluggable:** `registerIdentityResolver(name, factory)` — same registry pattern as `PersistenceBackend`. Operators can swap in an SSO-backed resolver, a Slack-org resolver, etc. The built-in covers the baseline; richer resolvers are config-driven, not code in the hot path.

**Idempotent + cacheable:** resolving the same `(platform, platformSenderId)` twice returns the same `userId`. Cache keyed by `(platform, platformSenderId)` with TTL. Memory layer can re-index transcripts without thrashing external identity lookups.

---

## 5. Track 3 — ChannelAdapter interface (new — `src/adapters/channels/types.ts`)

The contract every platform implements. Sits at the same architectural layer as CLI/SDK/Server — a runtime adapter that initiates the loop — but specialized for push-based, multi-conversation messaging.

### 5.1 Interface

```ts
export interface ChannelAdapter {
  readonly platform: ChannelPlatform;

  /** Connect to the platform and begin receiving. Idempotent. */
  start(handlers: ChannelHandlers): Promise<void>;

  /** Disconnect gracefully. In-flight outbound drains. */
  stop(): Promise<void>;

  /** Deliver an outbound message to a conversation. Handles chunking + format. */
  deliver(conv: ConversationRef, payload: OutboundPayload): Promise<DeliveryReceipt>;

  /** Per-channel persona/system prompt override. Optional. */
  systemPromptOverride?: string;

  /** Native tool-approval UX, if the platform supports it (buttons/etc). */
  createApprovalInteraction?(call: ApproveToolCall, conv: ConversationRef): ApprovalInteraction;
}

export interface ChannelHandlers {
  /** Called by the adapter for every normalized inbound message. */
  onInbound(msg: InboundMessage): Promise<void>;
}

export interface InboundMessage {
  conversationId: string;       // platform-native
  conversationType: ConversationType;
  senderId: string;             // platform-scoped raw id
  senderName?: string;
  text: string;
  media?: MediaAttachment[];    // images, voice, files
  timestamp: number;
  replyTo?: { messageId: string; senderId: string };  // for threaded/quoted replies
  raw: unknown;                 // platform payload, for advanced adapter logic
}

export interface OutboundPayload {
  text?: string;
  media?: MediaAttachment[];
  replyToMessageId?: string;    // thread the reply
}

export interface ConversationRef {
  conversationId: string;
  conversationType: ConversationType;
}

export interface ApprovalInteraction {
  /** Render inline buttons (or equivalent). Resolves when rendered. */
  render(): Promise<void>;
  /** The promise that resolves to the user's decision. */
  decision: Promise<boolean>;
  /** Clean up the UI after resolution or abort. */
  cleanup(): Promise<void>;
}

export interface DeliveryReceipt {
  messageId: string;            // platform-native message id (for edits/replies)
  deliveredAt: number;
}

export interface MediaAttachment {
  type: "image" | "voice" | "file";
  url?: string;                 // remote URL or local path
  data?: Buffer;                // inline bytes
  mimeType?: string;
  caption?: string;
}
```

### 5.2 What each platform implements (the genuinely platform-specific bits)

- **Auth handshake + connection** — bot token connect (Telegram), gateway WebSocket (Discord), oauth + event subscription (Slack), QR pairing (WhatsApp), app credentials (Teams).
- **`deliver()`** — call the platform's send API, with platform-specific chunking (Telegram 4096 chars, Slack blocks, WhatsApp Baileys message objects), Markdown adaptation (Discord supports it; WhatsApp doesn't — strip to plain/rich text), and rate-limit handling (Slack tier-based, Telegram 30/min to same chat).
- **Inbound normalization** — map the platform's webhook/poll event to `InboundMessage`.
- **`createApprovalInteraction()`** — inline keyboard (Telegram), buttons (Discord/Slack), adaptive cards (Teams). Platforms without buttons fall back to a text prompt ("reply 'yes' to approve").

Everything else — allowlist, session resolution, loop invocation, streaming, abort, proactive outbox — lives in the shared `ChannelGateway` and is written once.

---

## 6. Track 3 — ChannelGateway runtime (`src/adapters/channels/gateway.ts`)

The shared machinery. One instance per `seepient-channels` process.

### 6.1 Responsibilities (written once, reused by all adapters)

1. **Inbound pipeline** — receives `InboundMessage` from any adapter, runs it through: identity resolution → allowlist check → session resolution → loop invocation → outbound delivery.
2. **Loop invocation** — builds `AgentLoopOptions` (provider, model, resolved `messages[]` from the session, toolDefs, hooks, `approveTool`, `permissionLevel` from the resolved role, `signal`), calls `runAgentLoop`. **Same contract as CLI/SDK/Server — no new core API.**
3. **Streaming** — `onStep` handler accumulates `text`/`text_delta` and calls `adapter.deliver()` with chunked output. Configurable: per-message (complete text) for platforms with poor streaming UX, or incremental edits for platforms that support it (Telegram `editMessageText`, Discord message edits).
4. **Tool approval** — `approveTool` callback routes to `adapter.createApprovalInteraction()`; falls back to auto-deny on timeout. Resolved role gates which tools even prompt (admins can approve destructive tools; members cannot — enforced via `permissionLevel`).
5. **Proactive outbound** — owns the outbox + scheduler (§7).
6. **Concurrency** — one in-flight loop per conversation; interleaved inbound from different conversations multiplexed across separate loop invocations. Same per-key concurrency pattern as the Server adapter.
7. **Abort** — one `AbortController` per conversation; platform disconnect signal aborts in-flight loops for that conversation.

### 6.2 Per-conversation agent state

The gateway holds a `Map<sessionId, { messages, abortController, inFlight }>`. This mirrors how CLI holds `messages[]` on the `Agent` instance and how SDK holds it in a closure — same pattern, generalized to N conversations. The `SessionRegistry` is the source of truth; the in-memory map is the live cache.

### 6.3 Directory layout (mirrors `src/adapters/{cli,sdk,server}/` — a fourth sibling)

```
src/adapters/channels/
├── types.ts              # ChannelAdapter, InboundMessage, OutboundPayload, etc.
├── gateway.ts            # ChannelGateway — the shared runtime
├── allowlist.ts          # (delegates to IdentityResolver; thin)
├── formatter.ts          # Outbound chunking + Markdown adaptation per platform
├── outbox.ts             # Proactive outbound queue + scheduler
├── index.ts              # Barrel + createChannelGateway()
├── telegram/             # grammY adapter (reference)
│   ├── adapter.ts
│   ├── normalize.ts      # Telegram Update → InboundMessage
│   └── deliver.ts        # OutboundPayload → Telegram sendMessage (chunked)
├── discord/              # discord.js (follow-on phase)
├── slack/                # Bolt (follow-on phase)
├── whatsapp/             # Baileys (follow-on phase)
└── teams/                # Bot Framework (follow-on phase)
```

---

## 7. Proactive outbound (required by scope decision)

Scope decision: **full 2-way incl. proactive.** The agent can send messages not in direct reply to an inbound — scheduled messages, tool-result-driven notifications ("your deploy finished"), reminders.

### 7.1 Mechanism

- **`Outbox`** (`src/adapters/channels/outbox.ts`) — a persisted queue of pending outbound deliveries: `{ sessionId, conversationRef, payload, scheduledFor, trigger }`. Backed by `PersistenceBackend` (reuse the registry) so it survives restarts.
- **Scheduler** — on startup and on enqueue, schedules due messages via `setTimeout`; on fire, calls `adapter.deliver()`. Trigger types: `"scheduled"` (cron/absolute time), `"event"` (fired by a tool result or hook — e.g. a long-running tool resolves and pushes the result to the originating conversation).
- **Agent-facing tool** — a `send_message` / `schedule_message` tool registered when channels mode is active, so the LLM can proactively message a conversation. Scoped by permission: only `admin` role can schedule; `member` can only reply within the active turn.

### 7.2 Why it's in scope

Exercises the outbound path independent of inbound (proving `deliver()` works standalone), and it's the differentiator vs. a pure request/response bot. Cost: ~1 persisted queue + 1 scheduler + 1 tool. Bounded.

---

## 8. Track 4 — `seepient-channels` binary

### 8.1 Deploy model (decided)

**Single channels binary** — one `seepient-channels` process runs all enabled platforms concurrently, sharing one `SessionRegistry`, one `IdentityResolver`, one `PersistenceBackend`, one outbox. This is the Hermes/OpenClaw model and matches the "platforms as adapters" framing: a fourth sibling binary alongside `seepient` (CLI) and `seepient-server`.

Rejected alternatives:
- **Per-platform processes** — more ops overhead, no benefit given the shared registry.
- **Embedded in server** — couples channels to the server adapter's connection-based auth/session model, which is wrong for conversation-based messaging.

### 8.2 Binary responsibilities

- Load merged config (`loadMergedConfig()` — reuse existing).
- Resolve provider + model (`getProvider()` — reuse).
- Build `ToolsGateway` + `semanticToolMiddleware` (reuse — same as CLI/Server bootstrap).
- Build `PersistenceBackend` (reuse), `SessionRegistry` (new), `IdentityResolver` (new).
- Instantiate enabled `ChannelAdapter`s from config (`channels.telegram.enabled`, etc.).
- Build `ChannelGateway`, start adapters, run until SIGINT/SIGTERM → graceful stop.
- Health endpoint (optional): a small HTTP server for uptime checks / `/_health`.

### 8.3 Config shape (new settings keys, schema in `src/core/settings-schema.ts`)

```
channels.enabled: ["telegram", "discord", ...]
channels.telegram.token: "<bot token>"
channels.telegram.webhookUrl: "https://..." | null   # null = long-poll
channels.telegram.allowlist: ["12345", "67890"]      # platform sender ids
channels.telegram.admins: ["12345"]
channels.telegram.systemPromptOverride: "..."         # optional persona
channels.<platform>.{token|allowlist|admins|...}      # per-platform
channels.outbox.enabled: true
channels.outbox.pollIntervalMs: 5000
```

Allowlist/admins feed `AllowlistIdentityResolver`. Secrets handled by the existing settings masking.

---

## 9. Track 4 — Telegram reference adapter

Validates the whole vertical. grammY. Chosen first: simplest auth (bot token), webhook or long-poll, inline keyboard for tool approval, good Markdown, most documented in Hermes/OpenClaw.

### 9.1 End-to-end flow

1. **Inbound:** grammY receives an `Update` (webhook or poll). `normalize.ts` maps it to `InboundMessage`: `conversationId = chat.id`, `conversationType = chat.type === "private" ? "dm" : "group"`, `senderId = from.id`, `senderName = from.first_name`, `text = message.text`, `media = [photo|voice|...]`.
2. **Gateway:** `IdentityResolver.resolve({platform:"telegram", platformSenderId: from.id, ...})` → `{authorized, userId, role}`. If not authorized, optionally reply "not allowed" and stop.
3. **Session:** `SessionRegistry.resolveSession({platform:"telegram", conversationId: chat.id, botId})` → loads/creates `SessionData` with `messages[]`, `userId`, `conversationType`.
4. **Loop:** build `AgentLoopOptions` (full `messages[]`, `approveTool`, `permissionLevel` from role), call `runAgentLoop`.
5. **Streaming:** `onStep` accumulates text; for Telegram, send the first chunk via `sendMessage`, subsequent deltas via `editMessageText` (rate-limited), final commit on turn end. Configurable to "single message" mode for simpler UX.
6. **Tool approval:** `adapter.createApprovalInteraction()` sends an inline keyboard (✅ Approve / ❌ Deny); grammY callback query resolves the `decision` promise; 30s timeout → deny.
7. **Proactive:** `send_message` tool enqueues to `Outbox`; scheduler fires `adapter.deliver()`.

### 9.2 Media

- **Inbound voice** → transcription (reuse existing transcription if present; otherwise add a thin transcription step) → text in the message. Reply can be text or voice (synthesize if outbound voice is supported — out of scope for v1, text-only outbound).
- **Inbound image** → attached as content reference; the provider's vision capability handles it if the model supports images.
- **Outbound media** (full scope) → agent `generate_image` / `take_screenshot` results delivered as Telegram photos.

---

## 10. Other platforms (follow Telegram, stubbed in this spec)

Same interface, platform-specific implementation:

| Platform | Library | Inbound | Outbound quirks | Approval UX |
|---|---|---|---|---|
| **Discord** | discord.js | Gateway WebSocket (no public HTTPS) | Rich embeds; 2000-char limit per message → chunk | Button components |
| **Slack** | Bolt | Event subscription (webhook) + oauth | Block Kit; per-channel rate limits | Block Kit buttons |
| **WhatsApp** | Baileys | WhatsApp Web WebSocket, QR pairing | No Markdown — plain text; Baileys message objects | Text prompt fallback (no native buttons on all clients) |
| **Teams** | Bot Framework | App credentials + webhook | Adaptive Cards | Adaptive Card actions |

Each adapter is ~200-400 lines once the gateway/registry/resolver exist. The interface contract is fixed by Telegram's reference implementation.

---

## 11. Implementation phases (high-level ordering — detailed tasks in a follow-up `tasks.md`)

This spec is design-only. A `specs/002-channels-integration/tasks.md` (mirroring 001's format) follows after approval. Phase shape:

- **Phase 1 — Cleanup & prerequisites (Track 1):** Tools Gateway rename; `semanticToolMiddleware` rename; Server history bug fix. Each independently shippable. Verify: `pnpm test` green, no behavior change except the bug fix.
- **Phase 2 — Identity & session foundation (Track 2):** `Message`/`SessionData` schema additions (additive); `SessionRegistry`; `IdentityResolver` + `AllowlistIdentityResolver` + registry. Core only — no adapters yet. Verify: new unit tests; existing tests unchanged (additive fields).
- **Phase 3 — ChannelAdapter interface + ChannelGateway (Track 3):** `types.ts`, `gateway.ts`, `formatter.ts`, `outbox.ts`, scheduler, `send_message` tool. No platform yet — tested with a mock adapter. Verify: mock adapter round-trips a conversation end-to-end.
- **Phase 4 — `seepient-channels` binary + Telegram (Track 4):** binary bootstrap; Telegram adapter; settings keys. Verify: real Telegram bot 2-way conversation incl. tool approval + one proactive scheduled message.
- **Phase 5 — Platform expansion:** Discord, Slack, WhatsApp, Teams, each independently shippable behind the validated interface.

Each phase is independently testable. Phase 2 is the riskiest (touches core types) and gets the most scrutiny; Phases 4-5 are mechanical given the contract.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Schema changes ripple through message-convert, all 3 adapters' call sites, persisted messages** | All new fields optional. No migration. Legacy messages/sessions render unchanged. Existing tests stay green by construction. |
| **`SessionRegistry` indexes grow unbounded** | Indexes are in-memory and rebuild from `backend.list()` on startup. For very large deployments, a SQL backend can push indexes into the DB — interface unchanged. |
| **Identity resolver becomes a bottleneck on every inbound** | Cache by `(platform, senderId)`. Built-in allowlist resolver is O(1) map lookup. |
| **Proactive outbound abuse (agent spams a channel)** | `send_message`/`schedule_message` gated by `admin` role; configurable rate limit per conversation; outbox is observable (logged). |
| **WhatsApp ToS (Baileys is unofficial)** | Document the risk; provide Cloud API adapter as a config alternative later. Not blocking for Telegram reference. |
| **Teams adapter complexity (Bot Framework is heavy)** | Stubbed in spec; implement last. Telegram/Discord/Slack cover the common cases first. |

### Open questions for follow-up (not blocking this spec)

- **Cross-platform identity:** do we ship an account-linking flow (user pairs their Telegram + WhatsApp) or keep canonical userIds opaque by default? Recommend: opaque default, linking as a future resolver plugin.
- **Outbound media synthesis (voice replies)** — defer to post-v1.
- **Rate-limit strategy per platform** — refine during each platform's implementation.

---

## 13. Out of scope (this spec)

- Implementation tasks / line counts (follow-up `tasks.md`).
- The memory layer itself (B+C *enables* it; building it is a separate spec).
- Per-platform adapters beyond Telegram (interface + stubs only; Discord/Slack/WhatsApp/Teams are follow-on phases).
- WhatsApp Cloud API adapter (Baileys first; Cloud API as alternative later).
- Outbound voice synthesis.
- A web UI for managing channels (the `/gateway` CLI command pattern extends to `/channels`; full admin UI is separate).

---

## 14. Acceptance criteria (end state of the full effort)

1. `seepient-channels` binary runs Telegram 2-way: text in → text out, tool approval via inline buttons, one proactive scheduled message — all with conversation history threaded (not the Server bug).
2. A second platform (Discord or Slack) ships behind the same `ChannelAdapter` interface with no changes to the interface or core.
3. `Message.authorId` and `SessionData.{platform, conversationId, userId}` are populated and queryable via `SessionRegistry.sessionsForUser()` — proving the memory-layer join key exists.
4. Existing CLI/SDK/Server behavior unchanged; `pnpm test` green throughout; no persisted-session migration required.
5. "Gateway" in code/docs unambiguously means `ToolsGateway` (the engine); the middleware is `semanticToolMiddleware`; adapters are "runtime adapters".

---

## Appendix A — How existing adapters call the core (reference)

All three existing adapters delegate to one `runAgentLoop` with the same irreducible shape:

```ts
runAgentLoop({
  provider,         // resolved LLMProvider
  model,            // string
  messages,         // Message[] (the adapter owns this array's lifecycle)
  toolDefs,         // ToolDefinition[]
  maxSteps,         // number
  hooks,            // HookExecutor (wrap raw Hooks via createHookExecutor())
  // ...optional: systemPrompt, skillCatalog, signal, config, metadata,
  //              onStep, stream, providerFactory, middleware, approveTool,
  //              permissionLevel, autoConfirm
}) → Promise<AgentLoopResult>
```

Streaming flows through `onStep` (`text_delta` / `text` / `tool_call` steps). Abort flows through `signal`. Approval flows through `approveTool: (call) => Promise<boolean>`. **History is owned by the adapter, not the core** — the core just mutates the `messages[]` you hand it.

The `ChannelGateway` follows this exact contract. No new core API is introduced by this spec.

### Per-adapter asymmetries (factual; this spec preserves them except the Server bug)

| Concern | CLI | SDK | Server | Channels (new) |
|---|---|---|---|---|
| History lifecycle | in-memory on `Agent` instance | closure + optional backend | **fresh array per call (BUG — Track 1b fixes)** | `SessionRegistry`-backed, per-conversation |
| Streaming | `stream:true` in TUI only | `stream:true` in chatStream | not set | configurable per platform |
| Approval UX | inquirer / React prompt | user callback | WS round-trip | platform-native (buttons/text) |
| Session store | none (process-lifetime) | optional `PersistenceBackend` | `ServerSessionManager` (TTL + apiKeyHash) | `SessionRegistry` over `PersistenceBackend` |
| Identity | none | none | API key (connection-level) | `IdentityResolver` (per-sender, canonical) |
| `maxSteps` default | 30 | 10 | 5 | configurable (channels default TBD) |
