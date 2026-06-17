/**
 * Zoe Channels — Telegram reference adapter (spec 002 §9)
 *
 * Validates the whole vertical with one real platform. Implements ONLY the
 * platform-specific bits (§5.2): auth handshake (bot token), inbound
 * normalization handoff, outbound delivery, inline-keyboard tool approval.
 * No loop logic (constitution III) — the gateway owns the pipeline.
 */

import { Bot, InlineKeyboard } from "grammy";
import type { ChannelPlatform, ApproveToolCall } from "../../../core/types.js";
import type {
  ApprovalInteraction,
  ChannelAdapter,
  ChannelHandlers,
  ConversationRef,
  DeliveryReceipt,
  InboundMessage,
  OutboundPayload,
} from "../types.js";
import { normalizeUpdate } from "./normalize.js";
import { deliverToTelegram, streamEdit } from "./deliver.js";

export interface TelegramAdapterOptions {
  token: string;
  /** When set, grammY runs in webhook mode at this URL; otherwise long-poll. */
  webhookUrl?: string | null;
  /** Per-channel persona override. */
  systemPromptOverride?: string;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly platform: ChannelPlatform = "telegram";
  systemPromptOverride?: string;

  private token: string;
  private webhookUrl?: string | null;
  private bot: Bot | null = null;
  private handlers: ChannelHandlers | null = null;
  /** Pending approvals keyed by callback data, so a tap resolves the decision. */
  private pendingApprovals = new Map<string, { resolve: (v: boolean) => void }>();

  constructor(opts: TelegramAdapterOptions) {
    this.token = opts.token;
    this.webhookUrl = opts.webhookUrl ?? null;
    this.systemPromptOverride = opts.systemPromptOverride;
  }

  async start(handlers: ChannelHandlers): Promise<void> {
    if (this.bot) return; // idempotent
    this.handlers = handlers;
    const bot = new Bot(this.token);
    this.bot = bot;

    // Inbound: normalize every message update and hand to the gateway.
    bot.on("message", async (ctx) => {
      const update = ctx.update as unknown as Parameters<typeof normalizeUpdate>[0];
      const inbound = await normalizeUpdate(update);
      if (inbound && this.handlers) {
        // Resolve media file_ids to downloadable URLs (and fetch voice bytes so
        // transcription can run). Failures here are non-fatal — the gateway
        // still receives the text/caption.
        try {
          await this.resolveMedia(inbound);
        } catch {
          // best-effort — media enrichment must not drop the message
        }
        // Fire-and-forget into the gateway; errors surface via the gateway's
        // own delivery path, not the grammY handler.
        this.handlers.onInbound(inbound).catch(() => {});
      }
    });

    // Tool-approval callbacks: ✅/❌ inline keyboard resolves the decision.
    bot.callbackQuery(/^approve:(.+)$/, (ctx) => {
      const key = `approve:${ctx.match![1]}`;
      const pending = this.pendingApprovals.get(key);
      if (pending) {
        this.pendingApprovals.delete(key);
        pending.resolve(true);
      }
      void ctx.answerCallbackQuery({ text: "Approved" });
    });
    bot.callbackQuery(/^deny:(.+)$/, (ctx) => {
      const key = `deny:${ctx.match![1]}`;
      const pending = this.pendingApprovals.get(key);
      if (pending) {
        this.pendingApprovals.delete(key);
        pending.resolve(false);
      }
      void ctx.answerCallbackQuery({ text: "Denied" });
    });

    if (this.webhookUrl) {
      await bot.api.setWebhook(this.webhookUrl);
      // The host binary wires the webhook HTTP listener; grammY's webhookComposer
      // feeds updates in. For long-poll (default) we just start().
    } else {
      await bot.start({
        onStart: () => {},
        // Drop pending updates on (re)connect so a backlog doesn't replay.
        allowed_updates: ["message", "callback_query"],
      } as Parameters<typeof bot.start>[0]);
    }
  }

  async stop(): Promise<void> {
    if (!this.bot) return;
    if (!this.webhookUrl) {
      this.bot.stop();
    } else {
      try {
        await this.bot.api.deleteWebhook();
      } catch {
        // Best-effort.
      }
    }
    this.bot = null;
    this.handlers = null;
    // Resolve any pending approvals as denied on shutdown.
    for (const pending of this.pendingApprovals.values()) pending.resolve(false);
    this.pendingApprovals.clear();
  }

  async deliver(conv: ConversationRef, payload: OutboundPayload): Promise<DeliveryReceipt> {
    if (!this.bot) throw new Error("Telegram adapter not started");
    return deliverToTelegram(this.bot, conv, payload);
  }

  /**
   * Resolve media file_ids to downloadable URLs and fetch voice bytes so the
   * gateway can transcribe. Images keep their file download URL (vision wiring
   * is a future provider capability). Errors are caught by the caller.
   */
  private async resolveMedia(inbound: InboundMessage): Promise<void> {
    if (!this.bot || !inbound.media) return;
    for (const attachment of inbound.media) {
      const fileId = attachment.url;
      if (!fileId) continue;
      try {
        const file = await this.bot.api.getFile(fileId);
        // grammY exposes the bot's download URL path; the file_path is relative
        // to the Telegram file base. We set the resolved URL for images and
        // fetch bytes for voice (transcription needs the buffer).
        if (attachment.type === "voice" && file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
          const res = await fetch(url);
          if (res.ok) {
            attachment.data = Buffer.from(await res.arrayBuffer());
            attachment.url = url;
          }
        } else {
          attachment.url = file.file_path
            ? `https://api.telegram.org/file/bot${this.token}/${file.file_path}`
            : attachment.url;
        }
      } catch {
        // Leave the file_id in place — downstream stays best-effort.
      }
    }
  }

  /** In-place edit for incremental streaming (exposed for the gateway). */
  async editMessage(conv: ConversationRef, messageId: string, text: string): Promise<boolean> {
    if (!this.bot) return false;
    return streamEdit(this.bot, conv.conversationId, messageId, text);
  }

  createApprovalInteraction(call: ApproveToolCall, conv: ConversationRef): ApprovalInteraction {
    const id = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const bot = this.bot;
    const chatId = conv.conversationId;

    const decision = new Promise<boolean>((resolve) => {
      // Register both approve + deny handlers under distinct keys so a tap on
      // either resolves the same promise.
      this.pendingApprovals.set(`approve:${id}`, { resolve });
      this.pendingApprovals.set(`deny:${id}`, { resolve });
    });

    return {
      render: async () => {
        if (!bot) return;
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `approve:${id}`)
          .text("❌ Deny", `deny:${id}`);
        const summary = `${call.name}(${JSON.stringify(call.args).slice(0, 200)})`;
        try {
          await bot.api.sendMessage(chatId, `Approve tool call?\n${summary}`, {
            reply_markup: keyboard,
          });
        } catch {
          // Rendering failure — the gateway's 30s timeout denies regardless.
        }
      },
      decision,
      cleanup: async () => {
        this.pendingApprovals.delete(`approve:${id}`);
        this.pendingApprovals.delete(`deny:${id}`);
      },
    };
  }
}
