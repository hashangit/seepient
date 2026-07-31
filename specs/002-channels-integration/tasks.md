---
description: "Task list for the Channels Integration feature (2-way messaging on Seepient)"
---

# Tasks: Channels Integration (2-Way Messaging)

**Input**: Design spec from `specs/002-channels-integration/spec.md` (authoritative —
contains both user-story and plan-level content). Companion: `research.md`
(Hermes/OpenClaw source notes).

**Note on sources**: This feature has no separate `plan.md` — `spec.md` carries the
tech stack, project structure (§6.3), and phased implementation breakdown (§11).
Tasks derive from `spec.md`. Constitution: `.specify/memory/constitution.md`.

**Tests**: Vitest is the project suite. Test tasks are included where the spec
defines an explicit verify gate (Phase 2 schema is additive-but-core → unit tests
required; Phase 3 mock adapter → integration test required) or where a regression
risk exists (Phase 1 Server history fix → regression test). Smoke/verify tasks are
manual per the spec's acceptance criteria (§14). `pnpm test` is a HARD regression
gate after every core-touching phase.

**Organization**: Tasks grouped by Track → mapped to speckit phases. The spec's
four tracks become Phase 1 (Track 1 cleanup), Phase 2 (Track 2 identity — the
foundational, story-blocking phase), then user-story phases for the channels work
(Tracks 3+4), then platform expansion, then polish. Each user story is
independently testable.

## Format: `[ID] [P?] [Story?] Description with file path`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
  - Setup phase (Track 1 cleanup): NO story label
  - Foundational phase (Track 2 identity): NO story label
  - User Story phases: MUST have story label
  - Polish phase: NO story label
- Include exact file paths in descriptions

## Path Conventions

- Single project: `src/` at repository root.
- Channels code lives under `src/adapters/channels/`.
- New core modules live under `src/core/`.
- Identity/session schema touches `src/core/types.ts` (additive only).
- Tests: `src/**/__tests__/` (Vitest). Existing baseline: 161+ tests across 10
  files (snapshot — treat as "all pre-existing tests"; count drifts) — MUST stay
  green after every phase.
- Package manager: `pnpm` ONLY (constitution §Technology Stack).

## Constitution Check (from `.specify/memory/constitution.md` v1.0.0)

- **I. Single Execution Engine & Layered Boundaries** — Channels MUST delegate to
  the single `runAgentLoop`. No channels code may reimplement the agent loop. The
  `ChannelGateway` builds `AgentLoopOptions` and calls `runAgentLoop` exactly as
  CLI/SDK/Server do. Layering holds: `Adapters (channels) → Core → Infrastructure`.
- **II. Single Source of Truth** — Identity types (`AuthorRole`, `ChannelPlatform`,
  `ConversationType`) get ONE definition in `src/core/types.ts`. `SessionRegistry`
  and `IdentityResolver` are the single homes for session indexing and identity
  resolution. No channels-local duplicates of session/identity logic.
- **III. Simplicity First** — Per-platform adapters implement only the
  platform-specific bits (§5.2 of spec); everything shared lives in the
  `ChannelGateway`. No speculative config or unused flexibility. Built-in
  `AllowlistIdentityResolver` covers the baseline; richer resolvers are opt-in.
- **IV. Surgical Changes** — All schema additions to `Message`/`SessionData` are
  additive and optional (no migration, no legacy rewrite). The Tools Gateway rename
  touches only the class name + import sites + the one variable; no behavior change.
  The Server history fix is the minimum needed for parity with CLI/SDK.
- **V. Safe by Default & Verifiable** — Hook errors stay non-fatal. Channel errors
  surface through the existing `SeepientError` hierarchy with `code` + `retryable`.
  Every phase has an explicit verify gate; `pnpm test` is a hard regression gate;
  the failing test is written before the fix for the Server history bug.

---

## Phase 1: Setup (Track 1 — Cleanup & Prerequisites)

**Purpose**: Rename overloaded "gateway" terminology so the architecture is legible
before we extend it, and fix the Server history bug that all subsequent work
assumes is resolved. Each item in this phase is independently shippable.

**Constitution alignment**: IV (Surgical — rename is mechanical, no behavior
change; Server fix is minimum-for-parity). V (Verifiable — `pnpm test` gate, and
a failing test written before the bug fix).

### Track 1a — Terminology Refactor

- [ ] T001 Rename `MCPGateway` class → `ToolsGateway` in src/gateway/gateway.ts (class declaration + all internal references in this file). Update the file header comment. No behavior change.
- [ ] T002 [P] Update `MCPGateway` import sites to `ToolsGateway` across src/gateway/index.ts, src/gateway/tool-factory.ts (type references), src/gateway/openapi-importer.ts, src/gateway/settings-adapter.ts. No logic change — symbol rename only.
- [ ] T003 [P] Update adapter import sites of `MCPGateway` → `ToolsGateway` in src/adapters/cli/commands/gateway.ts, src/adapters/cli/bootstrap.ts, src/adapters/server/index.ts, src/adapters/server/rest-gateway.ts. The user-facing `/gateway` command and `/v1/gateway/*` route names stay UNCHANGED (operator stability) — only the engine class reference is renamed.
- [ ] T004 Rename the `gatewayMiddleware` variable → `semanticToolMiddleware` in src/adapters/cli/bootstrap.ts and src/adapters/server/index.ts (declaration + the two assignment sites that build `[semanticToolInjectionMiddleware(...)]`). Update the SDK re-export comment in src/adapters/sdk/index.ts if it references the old variable name. No behavior change.
- [ ] T005 Verify (manual gate): `pnpm build` succeeds with zero `MCPGateway` / `gatewayMiddleware` references remaining in src/ (grep confirms only user-facing route/command strings remain); `pnpm test` green; behavior byte-identical (no logic touched).

### Track 1b — Server History Bug Fix

- [ ] T006 Write a failing Vitest test in src/adapters/server/__tests__/server-history.test.ts that sends two sequential `chat` WS messages on the SAME session where turn 2 references turn 1 (e.g. turn 1: "my name is Alice"; turn 2: "what's my name?"). Assert the turn-2 response references turn 1 — it will FAIL today because `serverStreamText` builds a fresh `messages:[userMsg]` each call (verified bug, spec §3.1). This test MUST fail before T007.
- [ ] T007 Fix the Server history bug in src/adapters/server/ws-handlers.ts (`handleChat`) and src/adapters/server/server-core.ts (`serverStreamText`, `serverGenerateText`): load the session's full `messages[]` from `ServerSessionManager` BEFORE calling the loop, pass the full array into `runAgentLoop` (let it mutate in place — same pattern as CLI `Agent` and SDK `SdkAgent`), then persist the updated array back to the session on turn completion. Do NOT change the `PersistenceBackend` interface. Do NOT add new options to `AgentLoopOptions`. Brings Server to parity with CLI/SDK. (depends on T006)
- [ ] T008 Verify (manual gate): the T006 test now PASSES; run the full `pnpm test` suite — all pre-existing server tests stay green (the fix is additive — existing single-turn tests still pass because a one-message session behaves identically whether or not history is loaded); a manual two-turn WS conversation retains context.

**Checkpoint**: Cleanup complete. "Gateway" unambiguously means `ToolsGateway`;
the middleware variable is `semanticToolMiddleware`; Server now threads history
like CLI/SDK. All independently shippable. `pnpm test` green. Foundation ready for
Track 2.

---

## Phase 2: Foundational (Track 2 — Identity & Session Foundation)

**Purpose**: Add typed identity to `Message`/`SessionData` and build the
`SessionRegistry` + `IdentityResolver` in core. This is the load-bearing phase —
both Channels (Phases 3+) and the future memory layer build on it. Per spec §4,
this phase ships B+C: typed schema (B) + resolver (C).

**⚠️ CRITICAL**: No user story work can begin until this phase is complete. All
schema additions are additive and optional (constitution IV) — existing tests stay
green by construction. But the schema must be RIGHT (constitution V) because it's
the memory layer's join key.

**Memory-layer compatibility (spec §4.2)**: Five decisions are baked in here so
the future memory layer slots in without rework — `authorId`/`userId` store
resolved canonical ids; `SessionRegistry` emits events; resolver is idempotent;
`Message.id` stays stable. These are load-bearing for memory; do not deviate.

### Foundational — Schema (Track 2, B)

- [ ] T009 Add identity types to src/core/types.ts: `AuthorRole = "admin" | "member" | "guest"`; `ChannelPlatform = "telegram" | "whatsapp" | "slack" | "discord" | "teams" | "cli" | "sdk" | "server"`; `ConversationType = "dm" | "group" | "channel"`. All three are new top-level exports — single source of truth (constitution II).
- [ ] T010 Add OPTIONAL identity fields to the `Message` interface in src/core/types.ts: `authorId?: string` (canonical resolved userId), `authorName?: string`, `authorRole?: AuthorRole`, `platformSenderId?: string` (raw platform-scoped id for audit). All optional → legacy messages render unchanged, no migration (constitution IV).
- [ ] T011 Add OPTIONAL conversation-identity fields to the `SessionData` interface in src/core/types.ts: `platform?: ChannelPlatform`, `conversationId?: string` (platform-native), `conversationType?: ConversationType`, `botId?: string` (multi-bot deploys), `userId?: string` (resolved canonical — the memory-layer join key). All optional → existing UUID sessions keep working unchanged. Composite identity lives in typed fields, NOT encoded in the id string (spec §4.3 — avoids collisions, respects the `/^[a-zA-Z0-9-]+$/` id regex, no backend changes).
- [ ] T012 [P] Add author-awareness to message rendering in src/core/message-convert.ts: when converting user messages for the provider, if `authorId` is present AND `conversationType !== "dm"` (group/channel), prefix content with `[authorName]: ` so the model can distinguish speakers. Suppress the prefix in DMs (single speaker = noise). Legacy sessions have no `conversationType` → unaffected. Gate this on a new optional `conversationType` param passed from the loop, NOT on global state.

### Foundational — SessionRegistry (Track 2)

- [ ] T013 Create src/core/session-registry.ts exporting `SessionRegistry` interface + `createSessionRegistry(backend: PersistenceBackend)` factory. Interface per spec §4.6: `resolveSession(identity: ConversationIdentity)`, `sessionsForUser(userId)`, `save(session)`, `appendMessage(sessionId, message)`, `delete(sessionId)`, `on(event, handler)`. Delegates `save`/`load`/`delete` to the wrapped `PersistenceBackend` (UNCHANGED interface). Maintains in-memory indexes rebuilt lazily from `backend.list()` on startup: `(platform, conversationId, botId?) → sessionId` and `userId → sessionId[]`. Emits `"sessionSaved"` / `"messageAppended"` events AFTER successful backend writes. Does NOT touch the backend interface or file layout.
- [ ] T014 [P] Add unit tests in src/core/__tests__/session-registry.test.ts covering: resolveSession creates-then-loads on second call; sessionsForUser returns all sessions for a canonical userId; appendMessage emits `messageAppended`; index rebuild from backend.list() on startup; concurrent resolveSession calls for the same identity return the same session. Use the `MemoryPersistenceBackend` for isolation.
- [ ] T014b Follow-up: migrate the CLI TUI session selector (`listSessions()` in `src/adapters/cli/tui/index.tsx`, built standalone in 001/T049 on `PersistenceBackend`) to consume `registry.sessionsForUser(userId)` once T013 ships. The `SessionSelector` overlay component is data-source-agnostic (takes a plain `SessionListItem[]` prop), so ONLY the `listSessions()` closure changes — no TUI rework. The standalone implementation calls `backend.list()` + `load()` per id; the registry replaces that N+1 with an indexed query.

### Foundational — IdentityResolver (Track 2, C)

- [ ] T015 Create src/core/identity-resolver.ts exporting `IdentityResolver` interface + `ResolveInput` + `ResolvedIdentity` types per spec §4.7. Add `registerIdentityResolver(name, factory)` + `createIdentityResolver(config)` registry/factory — SAME pattern as `registerBackend`/`createPersistenceBackend` in session-store.ts (constitution II — single canonical pattern).
- [ ] T016 Implement `AllowlistIdentityResolver` (the built-in, registered as `"allowlist"`) in src/core/identity-resolver.ts: reads `channels.<platform>.allowlist` + `channels.<platform>.admins` from config; maps `platformSenderId` → canonical `userId` (default `"${platform}:${senderId}"`); returns `authorized:false` for non-allowlisted senders with a `reason`; assigns `role:"admin"` for admins, `"member"` otherwise. Idempotent + cached by `(platform, platformSenderId)` with a TTL so the future memory layer can re-index without thrashing (spec §4.2 decision #4).
- [ ] T017 [P] Add unit tests in src/core/__tests__/identity-resolver.test.ts covering: allowlisted sender resolves to canonical userId + role; non-allowlisted sender returns `authorized:false`; admin list promotes role to `"admin"`; idempotency (same input → same userId across calls); cache hit path. Use an in-memory config object.

- [ ] T018 Verify (manual gate): `pnpm test` green — all new Phase 2 tests pass AND all pre-existing tests pass unchanged (additive schema means nothing existing breaks). Grep confirms NO new `userId`/`senderId`/`channelId` field was added anywhere except `src/core/types.ts` (constitution II — single source of truth). Confirm `Message`/`SessionData` additions are all optional (`?`).

**Checkpoint**: Identity & session foundation ready. Typed schema in place,
`SessionRegistry` indexes + emits events, `IdentityResolver` resolves canonical
identity. Nothing depends on a channel adapter yet — all testable via unit tests.
User story work (Channels) can begin.

---

## Phase 3: User Story 1 — ChannelAdapter Interface & ChannelGateway (Priority: P1) 🎯 MVP

**Goal**: The shared machinery every platform adapter reuses — the
`ChannelAdapter` interface, the `ChannelGateway` runtime that consumes the core
contract, the outbound formatter, and the proactive outbox. Validated end-to-end
with a mock adapter (no real platform yet). This is the MVP because it proves the
architecture before any platform SDK is wired.

**Independent Test**: A mock `ChannelAdapter` (in test code) sends an
`InboundMessage` through the `ChannelGateway` → the gateway resolves identity →
resolves session → calls `runAgentLoop` → streams the response back through
`adapter.deliver()`. A tool call triggers the mock's `createApprovalInteraction`
and the decision flows back. A scheduled outbox message fires `deliver()` after a
tick. No real platform involved.

**Constitution alignment**: I (gateway delegates to `runAgentLoop` — no loop
reimplementation), II (single `ChannelAdapter` interface definition), III (shared
machinery written once, platform adapters stay thin), V (mock-adapter integration
test is the verify gate).

### Implementation for User Story 1

- [ ] T019 [P] [US1] Create src/adapters/channels/types.ts exporting the channel contract per spec §5.1: `ChannelAdapter`, `ChannelHandlers`, `InboundMessage`, `OutboundPayload`, `ConversationRef`, `ApprovalInteraction`, `DeliveryReceipt`, `MediaAttachment`. Import `ApproveToolCall` from src/core/types.ts (reuse, do not redefine — constitution II). Import `ChannelPlatform`, `ConversationType` from src/core/types.ts.
- [ ] T020 [P] [US1] Create src/adapters/channels/formatter.ts — outbound formatting per platform: a `formatForPlatform(platform, text)` function that chunks long text to platform limits (Telegram 4096, Discord 2000, Slack 40000, etc. — start with a per-platform MAX map), strips Markdown for platforms that don't support it (WhatsApp → plain text), and returns an array of `OutboundPayload` chunks. Keep it data-driven (a per-platform config object), no speculative abstraction (constitution III).
- [ ] T021 [P] [US1] Create src/adapters/channels/allowlist.ts — thin delegator that wraps an `IdentityResolver` instance and exposes `isAuthorized(inbound): Promise<ResolvedIdentity>` for the gateway. Do NOT reimplement resolution logic (constitution II — delegate to core).
- [ ] T022 [US1] Create src/adapters/channels/outbox.ts — persisted proactive outbound queue per spec §7. `Outbox` class backed by a `PersistenceBackend` (survives restarts). `enqueue({sessionId, conversationRef, payload, scheduledFor, trigger})`, `due(now)`, `markDelivered(id)`. Scheduler: `start()` schedules due messages via `setTimeout`, fires `adapter.deliver()`, handles `"scheduled"` (absolute time) and `"event"` (tool-result/hook) triggers. `stop()` drains. Keep the scheduler minimal — `setTimeout`-based, no cron library unless a concrete need emerges (constitution III).
- [ ] T023 [US1] Create src/adapters/channels/gateway.ts — `ChannelGateway` class per spec §6. Constructor takes `{provider, model, registry: SessionRegistry, resolver: IdentityResolver, adapters: ChannelAdapter[], outbox: Outbox, config}`. Implements the inbound pipeline: `handleInbound(msg)` → resolver.resolve → allowlist check → registry.resolveSession → build `AgentLoopOptions` (full `messages[]` from session, hooks via `createHookExecutor()`, `approveTool`, `permissionLevel` from resolved role, `signal` from a per-conversation `AbortController`) → `runAgentLoop` (THE single engine — constitution I). `onStep` handler routes `text`/`text_delta`/`tool_call` to `adapter.deliver()` via the formatter (chunked). `approveTool` routes to `adapter.createApprovalInteraction()` with a 30s timeout → auto-deny. Per-concurrency: `Map<sessionId, {messages, abortController, inFlight}>`. MUST NOT reimplement any loop logic.
- [ ] T024 [US1] Create src/adapters/channels/index.ts — barrel exporting types, `createChannelGateway()` factory, and (later) per-platform adapter factories. For now, exports the interface + factory only.
- [ ] T025 [US1] Create the mock-adapter integration test in src/adapters/channels/__tests__/gateway.test.ts: a `MockChannelAdapter` implementing `ChannelAdapter` in-memory (records `deliver()` calls, simulates `createApprovalInteraction` with a controllable `decision` promise). Test the full pipeline: inbound → loop (use a stub provider that returns a canned response) → outbound delivered; a tool call triggers approval and the decision flows back; an outbox scheduled message fires `deliver()` after a fake tick. Use `MemoryPersistenceBackend` + `MemorySessionRegistry`. This test MUST pass before Phase 4.
- [ ] T026 [US1] Register the `send_message` and `schedule_message` tools (per spec §7.1) in src/adapters/channels/tools.ts — only registered when channels mode is active (passed via the gateway's `toolDefs`). `send_message` enqueues to the outbox with `trigger:"event"`; `schedule_message` enqueues with `trigger:"scheduled"`. Both gated by the resolved role: only `admin` may schedule; `member` may only reply within the active turn (enforced inside the tool's `execute` by reading role from `ToolContext.config`).

**Checkpoint**: ChannelAdapter interface + ChannelGateway runtime validated
end-to-end with a mock adapter. The architecture is proven before any platform SDK
is touched. The same `runAgentLoop` powers channels as CLI/SDK/Server
(constitution I). This is the MVP — the rest is platform wiring.

---

## Phase 4: User Story 2 — `seepient-channels` Binary & Telegram Reference (Priority: P1)

**Goal**: A runnable `seepient-channels` binary that connects to Telegram via grammY
and delivers real 2-way messaging: text in → text out, tool approval via inline
keyboard, and one proactive scheduled message. Validates the whole vertical against
a real platform. Per spec §8–9.

**Independent Test**: Configure a real Telegram bot token; run `seepient-channels`;
send a message from a Telegram client → get a streamed reply; trigger a
destructive tool → inline ✅/❌ keyboard appears, tapping approves/denies; the
`schedule_message` tool fires and a message arrives at the scheduled time.
Conversation history threads across turns (not the Phase 1 Server bug).

**Constitution alignment**: I (binary delegates to `runAgentLoop` via the gateway),
III (Telegram adapter implements ONLY platform-specific bits — spec §5.2), IV
(new settings keys are additive to the existing schema).

### Implementation for User Story 2

- [ ] T027 [P] [US2] Add channels settings keys to src/core/settings-schema.ts: `channels.enabled` (string[]), `channels.telegram.token` (secret), `channels.telegram.webhookUrl` (string|null), `channels.telegram.allowlist` (string[]), `channels.telegram.admins` (string[]), `channels.telegram.systemPromptOverride` (string), `channels.outbox.enabled` (boolean), `channels.outbox.pollIntervalMs` (number). Follow the existing schema metadata shape (type, secret, restart-required, category). Secrets masked by existing settings masking (constitution V). Category: `"channels"` (new — extend the category list).
- [ ] T028 [P] [US2] Run `pnpm add grammy` to add the grammY Telegram framework to package.json (do NOT use npm — constitution §Technology Stack).
- [ ] T029 [P] [US2] Create src/adapters/channels/telegram/normalize.ts — `normalizeUpdate(update: Update): InboundMessage | null` mapping a grammY/Telegram `Update` to the canonical `InboundMessage`: `conversationId = String(chat.id)`, `conversationType = chat.type === "private" ? "dm" : "group"`, `senderId = String(from.id)`, `senderName = from.first_name`, `text = message.text || ""`, `media = []` populated from `message.photo`/`message.voice`/etc, `timestamp = message.date * 1000`, `replyTo` from `message.reply_to_message`. Return `null` for updates with no message text and no media (drops non-text non-media noise).
- [ ] T030 [P] [US2] Create src/adapters/channels/telegram/deliver.ts — `deliverToTelegram(bot: Bot, conv: ConversationRef, payload: OutboundPayload): Promise<DeliveryReceipt>` that chunks via the formatter (T020), calls `bot.api.sendMessage` (or `sendPhoto`/`sendVoice` for media), respects the Telegram 30-messages-per-minute-to-same-chat rate limit with a minimal per-chat throttle (no library unless needed), returns the `message_id` as the receipt. For streaming edits: a `streamEdit(bot, chatId, messageId, text)` helper that calls `editMessageText` rate-limited.
- [ ] T031 [US2] Create src/adapters/channels/telegram/adapter.ts — `TelegramChannelAdapter implements ChannelAdapter` per spec §9.1. Constructor takes `{token, webhookUrl|null, config}`. `start(handlers)`: creates a grammY `Bot`, registers an `on("message")` handler that calls `handlers.onInbound(normalizeUpdate(update))`, starts polling OR sets a webhook based on `webhookUrl`. `stop()`: stops the bot. `deliver()`: delegates to deliver.ts. `createApprovalInteraction()`: sends an inline keyboard (✅ Approve / ❌ Deny) via `sendMessage` with `reply_markup`, returns an `ApprovalInteraction` whose `decision` promise resolves on the matching `callback_query` (30s timeout → deny + cleanup). `systemPromptOverride` from config. Platform-specific ONLY — no loop logic (constitution III). (depends on T029, T030)
- [ ] T032 [US2] Create the `seepient-channels` binary entry at src/adapters/channels/bin.ts per spec §8.2: load merged config (`loadMergedConfig()` — reuse), resolve provider+model (`getProvider()` — reuse), build `ToolsGateway` + `semanticToolMiddleware` (reuse — same as CLI/Server bootstrap), build `PersistenceBackend` (reuse) + `SessionRegistry` (T013) + `IdentityResolver` (T015), instantiate enabled adapters from config (`channels.enabled`), build `ChannelGateway` (T023), `gateway.start()` all adapters, run until SIGINT/SIGTERM → graceful `stop()`. Optional minimal `/_health` HTTP endpoint. Wire it as a `seepient-channels` binary in package.json `bin`.
- [ ] T033 [US2] Add a Vitest test in src/adapters/channels/telegram/__tests__/normalize.test.ts covering: private chat → `conversationType:"dm"`; group chat → `"group"`; media extraction from photo/voice updates; `null` return for empty updates. Use canned Telegram `Update` fixtures (no network).
- [ ] T034 [US2] Verify (manual gate): with a real Telegram bot token in settings, run `seepient-channels`; send a text message from Telegram → streamed reply arrives (sendMessage then editMessageText); a destructive-tool prompt shows the inline keyboard, ✅ approves and ❌ denies; `schedule_message` delivers a message at the scheduled time; a two-turn conversation on Telegram retains context (history threaded via the SessionRegistry, not the Phase 1 bug); `pnpm test` green.

**Checkpoint**: `seepient-channels` runs Telegram 2-way end-to-end. The whole
vertical — binary → gateway → resolver → registry → `runAgentLoop` → adapter →
Telegram API — is proven against a real platform. Acceptance criteria #1 (spec
§14) met.

---

## Phase 5: User Story 3 — Inbound Media & Outbound Media (Priority: P2)

**Goal**: Full media support on Telegram — inbound voice transcription, inbound
image to vision-capable models, outbound agent-generated images/screenshots
delivered as Telegram photos. Exercises the `MediaAttachment` contract from T019
on a real platform. Per spec §9.2.

**Independent Test**: Send a voice memo to the Telegram bot → transcribed → agent
responds to the transcribed text. Send a photo → agent describes it (vision model).
Trigger `generate_image` → result arrives as a Telegram photo. `pnpm test` green.

**Constitution alignment**: III (media handling is platform-specific — lives in
the Telegram adapter + a thin transcription helper; no core changes for media
routing — it flows through the existing `Message` content).

### Implementation for User Story 3

- [ ] T035 [P] [US3] Extend src/adapters/channels/telegram/normalize.ts to populate `InboundMessage.media` from `message.voice` (type `"voice"`, fetch file → buffer), `message.photo` (type `"image"`, largest size), `message.document` (type `"file"`). Use `bot.api.getFile` + a download helper. Keep the fetch async; normalize.ts may return a `Promise<InboundMessage>`.
- [ ] T036 [P] [US3] Add a transcription helper at src/adapters/channels/transcribe.ts — `transcribeVoice(media: MediaAttachment): Promise<string>` using an existing transcription capability if present in the repo (grep for `whisper`/`transcri`); otherwise a thin adapter that calls a configured transcription endpoint. Idempotent + cached by media hash. Configurable to a no-op (return empty string) when no transcription is configured — fail safe (constitution V).
- [ ] T037 [US3] Wire inbound media into the `ChannelGateway.handleInbound` path in src/adapters/channels/gateway.ts: if `msg.media` contains voice, call `transcribeVoice` and append the transcript to `msg.text` (or replace if text was empty); if image, attach as content reference for vision-capable providers (the provider's `chat()` already accepts multimodal content — confirm via the provider interface before wiring). No core changes — media flows as message content. (depends on T036)
- [ ] T038 [US3] Extend src/adapters/channels/telegram/deliver.ts to send media: if `OutboundPayload.media` is present, call `bot.api.sendPhoto`/`sendVoice` instead of `sendMessage`. Map agent tool results from `generate_image` (T039) and `take_screenshot` to outbound media in the gateway's `onStep` handler — when a tool result carries image bytes, attach them to the next outbound payload.
- [ ] T039 [US3] Verify (manual gate): send a voice memo to the bot → transcribed → agent responds to the transcript; send a photo → agent describes it (on a vision-capable model); trigger `generate_image` → the image arrives as a Telegram photo; `pnpm test` green.

**Checkpoint**: Full media 2-way on Telegram. The `MediaAttachment` contract is
exercised on a real platform. Voice synthesis (outbound voice) remains out of scope
(spec §13).

---

## Phase 6: User Story 4 — Discord Platform Expansion (Priority: P3)

**Goal**: A second platform — Discord via discord.js — ships behind the SAME
`ChannelAdapter` interface with NO changes to the interface, gateway, registry, or
resolver. Proves the interface generalizes. Per spec §10. Acceptance criterion #2
(spec §14).

**Independent Test**: Run `seepient-channels` with `channels.enabled: ["telegram",
"discord"]`; both platforms work concurrently; a Discord DM and a Discord channel
both reach the agent; tool approval via Discord button components; no code changes
to `ChannelAdapter`/`ChannelGateway`/core. `pnpm test` green.

**Constitution alignment**: II (reuses the single interface — no fork), III (only
platform-specific bits implemented), IV (no changes to shared machinery).

### Implementation for User Story 4

- [ ] T040 [P] [US4] Run `pnpm add discord.js` to add the Discord library.
- [ ] T041 [P] [US4] Add Discord settings keys to src/core/settings-schema.ts: `channels.discord.token` (secret), `channels.discord.allowlist` (string[] — Discord user IDs), `channels.discord.admins` (string[]), `channels.discord.systemPromptOverride`. Same shape as the Telegram keys (T027).
- [ ] T042 [P] [US4] Create src/adapters/channels/discord/normalize.ts — map a discord.js `Message` to `InboundMessage`: `conversationId = message.channel.id`, `conversationType = message.channel.isDMBased() ? "dm" : "channel"`, `senderId = message.author.id`, `senderName = message.author.username`, `text = message.content`, `media` from attachments, `timestamp = message.createdTimestamp`, `replyTo` from `message.reference`.
- [ ] T043 [P] [US4] Create src/adapters/channels/discord/deliver.ts — `deliverToDiscord(channel, payload)` that chunks to the Discord 2000-char limit (via formatter T020), sends as `channel.send(text)` or rich embeds for media, returns the message id. Discord supports Markdown natively — no stripping.
- [ ] T044 [US4] Create src/adapters/channels/discord/adapter.ts — `DiscordChannelAdapter implements ChannelAdapter`. `start()`: creates a discord.js `Client`, registers `client.on("messageCreate")` → `handlers.onInbound(normalize(message))`, logs in with the token. `stop()`: destroys the client. `deliver()`: delegates to deliver.ts. `createApprovalInteraction()`: sends a message with ✅/❌ button components (`ActionRowBuilder`+`ButtonBuilder`), listens for `interactionCreate` on those custom ids, 30s timeout → deny. NO changes to `ChannelAdapter`/`ChannelGateway`/core — if a change is needed, STOP and propose an interface revision instead of forking (constitution II). (depends on T042, T043)
- [ ] T045 [US4] Wire the Discord adapter into the binary in src/adapters/channels/bin.ts: when `channels.enabled` includes `"discord"`, instantiate `DiscordChannelAdapter` from config and pass to `createChannelGateway`. Reuse ALL existing bootstrap (provider, registry, resolver, outbox).
- [ ] T046 [US4] Verify (manual gate): run `seepient-channels` with both Telegram and Discord enabled; both work concurrently; Discord DM and channel both reach the agent with history threaded; tool approval via Discord buttons; proactive scheduled message delivered to Discord; NO changes were needed to `ChannelAdapter`/`ChannelGateway`/`SessionRegistry`/`IdentityResolver` (grep the diff to confirm); `pnpm test` green.

**Checkpoint**: A second platform ships behind the unchanged interface. Acceptance
criterion #2 (spec §14) met. The architecture is proven to generalize.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Hardening that spans all user stories. Per spec §12–14.

- [ ] T047 [P] Add a CI assertion that `seepient-channels` does not leak platform SDKs into headless/server builds when channels are disabled — assert `dist/adapters/cli/repl.js` and `dist/adapters/server/index.js` contain no `grammy`/`discord.js` reference (mirror the T055 JSX-leak assertion from spec 001). Add to the GitHub Actions workflow file.
- [ ] T048 [P] Add per-conversation rate limiting to the proactive outbox in src/adapters/channels/outbox.ts — a per-`conversationRef` token bucket (configurable via `channels.outbox.maxPerConversationPerMin`, default 10) to prevent agent-initiated spam. Admin-gated tools already (T026); this is defense-in-depth (constitution V). Log every outbox fire for observability.
- [ ] T049 [P] Update ARCHITECTURE.md to (a) rename the Gateway section to "Tools Gateway" and use `ToolsGateway`/`semanticToolMiddleware` terminology throughout; (b) add Channels as a fourth Runtime Adapter family with a diagram; (c) document the `SessionRegistry` + `IdentityResolver` in the Core layer; (d) note the memory-layer compatibility (the 5 decisions from spec §4.2).
- [ ] T050 [P] Update AGENTS.md "Adapters" section to add Channels as a fourth runtime adapter, and update the "Known Gaps" / architectural notes to reflect the Tools Gateway rename and the new identity/session types.
- [ ] T051 [P] Add VitePress docs in docs/ for channels: a getting-started guide (configure `channels.telegram.token`, run `seepient-channels`), a per-platform page for Telegram, and an architecture page summarizing the ChannelAdapter contract + ChannelGateway.
- [ ] T052 Run the full `pnpm test` suite; confirm all pre-existing (161+) plus new Phase 2–6 tests pass. Run `pnpm build` and confirm zero type errors.
- [ ] T053 Run the spec.md acceptance scenarios (spec §14) as a final validation pass: (1) Telegram 2-way + approval + proactive with history threaded; (2) Discord ships behind the unchanged interface; (3) `Message.authorId` + `SessionData.{platform,conversationId,userId}` queryable via `SessionRegistry.sessionsForUser()`; (4) CLI/SDK/Server unchanged; (5) "gateway" terminology unambiguous.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup — Track 1)**: No dependencies — start immediately. T001–T005
  (rename) and T006–T008 (Server fix) are independent of each other and can land
  as separate commits. T006 (failing test) MUST precede T007 (fix) — constitution V.
- **Phase 2 (Foundational — Track 2)**: Depends on Phase 1 completion (the
  `semanticToolMiddleware` rename must land first so Phase 2+ code uses the new
  name). BLOCKS all user stories. T009–T011 (schema) before T012 (rendering) and
  before T013/T015 (registry/resolver consume the types).
- **User Stories (Phase 3+)**: All depend on Phase 2 completion.
  - US1 (Phase 3) is the MVP — proves the architecture with a mock adapter. No real
    platform SDK needed. The `ChannelGateway` delegates to the single `runAgentLoop`
    (constitution I).
  - US2 (Phase 4) builds on US1's interface + gateway; wires Telegram + the binary.
    This is where acceptance criterion #1 is met.
  - US3 (Phase 5) adds media to US2's Telegram adapter; depends on US2.
  - US4 (Phase 6) adds Discord; depends on US1 (interface + gateway) but is
    independent of US2/US3 except for sharing the binary bootstrap.
- **Polish (Phase 7)**: T047 (CI) lands alongside the first platform commit;
  T048–T051 are independent of which platforms shipped; T052–T053 run after the
  stories they cover.

### User Story Dependencies

- **US1 (P1)**: Starts after Phase 2. No dependencies on other stories. FOUNDATIONAL
  to all subsequent platform work — defines the interface.
- **US2 (P1)**: Starts after US1. Wires the binary + Telegram. Acceptance #1.
- **US3 (P2)**: Starts after US2 (extends the Telegram adapter). Independent of US4.
- **US4 (P3)**: Starts after US1. Independent of US2/US3 (different platform). Can
  run in parallel with US3 if staffed.

### Within Each Phase

- Schema types (T009–T011) before consumers (T012 rendering, T013 registry, T015 resolver).
- Interface (T019) before gateway (T023); gateway before mock test (T025).
- Failing test (T006) before fix (T007) — constitution V.
- Telegram normalize/deliver (T029/T030) before Telegram adapter (T031); adapter
  before binary wiring (T032); all before manual verify (T034).
- Verify gate LAST in every story.

### Parallel Opportunities

- **Phase 1**: T001–T005 (rename — sequential within the rename but the Server
  fix T006–T008 is independent and parallel). T002/T003/T004 are different files
  once T001 lands.
- **Phase 2**: T014 (registry tests) and T017 (resolver tests) parallel once
  T013/T015 land. T009/T010/T011 are the same file (types.ts) — sequential.
- **US1**: T019/T020/T021 (types, formatter, allowlist) all different files —
  parallel. T022 (outbox) parallel with T019–T021.
- **US2**: T027 (settings) / T028 (grammy install) / T029 (normalize) / T030
  (deliver) all parallel — different files.
- **US3**: T035 (normalize media) / T036 (transcribe) parallel.
- **US4**: T040 (discord.js install) / T041 (settings) / T042 (normalize) / T043
  (deliver) all parallel.

---

## Parallel Example: User Story 2

```bash
# Launch the Telegram leaf modules together (different files):
Task: "Add channels settings keys in src/core/settings-schema.ts"
Task: "Run pnpm add grammy"
Task: "Create normalize.ts in src/adapters/channels/telegram/normalize.ts"
Task: "Create deliver.ts in src/adapters/channels/telegram/deliver.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only — Mock Adapter)

1. Complete Phase 1: Setup (T001–T008) — rename + Server fix
2. Complete Phase 2: Foundational (T009–T018) — schema + registry + resolver
3. Complete Phase 3: User Story 1 (T019–T026) — interface + gateway + mock test
4. **STOP and VALIDATE**: run the T025 mock-adapter integration test; confirm the
   gateway delegates to `runAgentLoop` (no reimplementation); `pnpm test` green
5. The architecture is proven — proceed to platform wiring

### Incremental Delivery

1. Phase 1 (rename + Server fix) → ship independently; `pnpm test` green
2. Phase 2 (identity + sessions) → ship; additive, existing tests green
3. Phase 3 US1 (gateway + mock) → validate architecture
4. Phase 4 US2 (Telegram + binary) → ship first real platform (acceptance #1)
5. Phase 5 US3 (media) → ship full media on Telegram
6. Phase 6 US4 (Discord) → ship second platform (acceptance #2)
7. Phase 7 (polish) → docs, CI, hardening, final validation

### Fallback (per spec §12 — Phase 2 is riskiest)

If Phase 2 (schema changes) surfaces unexpected breakage, fall back to: keep the
identity/session fields in `SessionData.metadata` (the existing untyped escape
hatch, used today by the server's `apiKeyHash`) instead of typed top-level fields.
This unblocks Phases 3+ while deferring the typed schema. The cost: weaker type
safety and no compile-time enforcement; revisit the typed schema once the
channel adapters are working. Document this deviation in the plan's complexity
tracking (constitution §Governance).

---

## Notes

- `[P]` tasks = different files, no dependencies on incomplete tasks
- `[Story]` label maps a task to its user story for traceability
- Every user story ends with a manual verify gate (T026-area, T034, T039, T046) —
  these map to spec §14 acceptance criteria, not optional
- `pnpm test` (T005, T008, T018, T025, T034, T039, T046, T052) is a HARD regression
  gate after every core-touching phase — the pre-existing suite MUST stay green
- Constitution check: Phase 1 (IV — surgical rename + verifiable bug fix); Phase 2
  (II single source, IV additive, V verifiable); Phase 3 (I single engine, III
  simplicity); Phases 4–6 (II interface reuse, III thin adapters); Phase 7 (V safe)
- The future memory layer is NOT built here — Phase 2 ENABLES it via the 5 decisions
  in spec §4.2 (canonical `authorId`/`userId`, registry events, idempotent resolver,
  stable `Message.id`). The memory layer is a separate spec.
- Out of scope (spec §13): per-platform adapters beyond Telegram+Discord (Slack,
  WhatsApp, Teams are follow-on phases reusing the validated interface); WhatsApp
  Cloud API; outbound voice synthesis; channels admin web UI.
- Commit after each task or logical group; stop at any checkpoint to validate a
  story independently
- Avoid: vague tasks, same-file parallel conflicts, cross-story dependencies that
  break independence, any loop reimplementation in channels (constitution I)
