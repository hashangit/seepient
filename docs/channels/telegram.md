# Telegram Channel

Telegram is the reference channels platform, built on [grammY](https://grammy.dev/). It validates the full 2-way vertical: text in → text out, inline-keyboard tool approval, proactive scheduled messages, inbound voice transcription, and outbound image delivery.

## Configure

```json
{
  "channels": {
    "enabled": "telegram",
    "telegram": {
      "token": "123456:ABC-DEF...",
      "webhookUrl": null,
      "allowlist": ["111111111"],
      "admins": ["111111111"],
      "systemPromptOverride": "You are Zoe on Telegram. Be concise."
    }
  }
}
```

| Key | Description |
|---|---|
| `token` | Bot token from [@BotFather](https://t.me/BotFather) (secret, restart-required) |
| `webhookUrl` | Set to a URL for webhook mode; `null` uses long-polling (default) |
| `allowlist` | Telegram user IDs permitted to talk to the bot (comma-separated or array) |
| `admins` | Telegram user IDs promoted to the `admin` role (permissive tool gating) |
| `systemPromptOverride` | Optional per-channel persona |

The `TELEGRAM_BOT_TOKEN` env var overrides `channels.telegram.token`.

## Run

```bash
pnpm dev:channels
# or
zoe-channels
```

## Behavior

- **Inbound:** grammY receives an `Update`; the adapter normalizes it (private chat → `dm`, group → `group`), resolves voice/photo media, and hands the canonical `InboundMessage` to the gateway.
- **Identity:** your Telegram user id is checked against the allowlist and mapped to a canonical `userId` (`telegram:<id>`).
- **Reply:** the gateway streams the reply; long text is chunked to Telegram's 4096-char limit with a 2s per-chat throttle (the 30-msg/min limit).
- **Tool approval:** destructive tools prompt an inline ✅/❌ keyboard; a tap resolves the decision (30s timeout → deny).
- **Media inbound:** voice memos are transcribed (fail-safe: empty string when no transcription backend is configured) and folded into the message; images are noted as content references.
- **Media outbound:** `generate_image` / `take_screenshot` results are delivered as Telegram photos.

## Running alongside Discord

Both platforms share one process and one session registry:

```json
{
  "channels": {
    "enabled": "telegram, discord",
    "telegram": { "token": "...", "allowlist": ["111"] },
    "discord": { "token": "...", "allowlist": ["222"] }
  }
}
```
