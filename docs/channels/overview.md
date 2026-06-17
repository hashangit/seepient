# Channels

Zoe's **Channels** adapter family brings 2-way messaging to the agent — Telegram, Discord, Slack, WhatsApp, and Teams — including proactive (agent-initiated) outbound. A single `zoe-channels` binary runs all enabled platforms concurrently, sharing one session registry, identity resolver, and outbox.

Channels is a fourth runtime adapter alongside CLI, SDK, and Server. Like them, it delegates to the single `runAgentLoop` — it contains no loop logic of its own.

## Architecture

```
ChannelAdapter (Telegram / Discord / …)
        │ onInbound(normalized message)
        ▼
   ChannelGateway ── IdentityResolver ── SessionRegistry
        │
        ▼ runAgentLoop(...)   ← the same engine CLI/SDK/Server use
        │
        ▼ adapter.deliver(chunked reply)
```

- **`ChannelAdapter`** — the per-platform contract (`start`/`stop`/`deliver` + optional `createApprovalInteraction`). Telegram (grammY) and Discord (discord.js) ship today.
- **`ChannelGateway`** — the shared runtime: identity resolution → allowlist → session → `runAgentLoop` → outbound delivery. One per process.
- **`IdentityResolver`** — maps a platform-scoped sender to a canonical `userId` + role. The built-in `AllowlistIdentityResolver` reads `channels.<platform>.allowlist` / `admins` from settings.
- **`SessionRegistry`** — indexes sessions by `(platform, conversationId)` and `userId`, persists transcripts, and emits events for the future memory layer.
- **`Outbox`** — persisted proactive-outbound queue with a scheduler and per-conversation rate limiting.

## Quick start (Telegram)

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Configure settings (`~/.zoe/setting.json`):

   ```json
   {
     "channels": {
       "enabled": "telegram",
       "telegram": {
         "token": "<bot token>",
         "allowlist": ["<your telegram user id>"],
         "admins": ["<your telegram user id>"]
       }
     }
   }
   ```

3. Run the binary:

   ```bash
   pnpm dev:channels
   # or, after build:
   zoe-channels
   ```

4. Message your bot on Telegram. Replies stream back; destructive tools prompt an inline ✅/❌ keyboard; `schedule_message` delivers a message at a future time.

## Proactive outbound

The agent can message a conversation outside a direct reply. The `send_message` tool fires immediately (`trigger: "event"`); `schedule_message` defers to a future time (`trigger: "scheduled"`, admin-only). Both flow through the rate-limited outbox.

## Adding a platform

Implement `ChannelAdapter` for your platform (normalize inbound, deliver outbound, render approval UX). Register it with `registerPlatformBinary(name, factory)` in the binary — no changes to the gateway, registry, resolver, or interface.
