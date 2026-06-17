/**
 * Zoe Channels — Telegram outbound delivery (spec 002 §9.1 / §5.2)
 *
 * Chunks via the shared formatter, calls the Telegram send API, respects the
 * 30-messages-per-minute-to-same-chat limit with a minimal per-chat throttle,
 * and provides a `streamEdit` helper for incremental edits during streaming.
 */

import type { Bot } from "grammy";
import { formatForPlatform } from "../formatter.js";
import type {
  ConversationRef,
  DeliveryReceipt,
  MediaAttachment,
  OutboundPayload,
} from "../types.js";

// Telegram allows ~30 messages/sec overall, but 30/min to the SAME chat.
// A 2-second spacing between sends to one chat stays safely under the limit.
const PER_CHAT_MIN_INTERVAL_MS = 2_000;
const lastSentByChat = new Map<string, number>();

async function throttle(chatId: string): Promise<void> {
  const last = lastSentByChat.get(chatId) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < PER_CHAT_MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, PER_CHAT_MIN_INTERVAL_MS - elapsed));
  }
  lastSentByChat.set(chatId, Date.now());
}

/**
 * Deliver an outbound payload to a Telegram chat. Returns the last message's
 * receipt (its `message_id`) — callers use it to thread or edit subsequent
 * sends.
 */
export async function deliverToTelegram(
  bot: Bot,
  conv: ConversationRef,
  payload: OutboundPayload,
): Promise<DeliveryReceipt> {
  const chatId = conv.conversationId;

  // Media-first: if the payload carries image bytes/url, send as a photo.
  if (payload.media && payload.media.length > 0) {
    let receipt: DeliveryReceipt = { messageId: "0", deliveredAt: Date.now() };
    for (const attachment of payload.media) {
      await throttle(chatId);
      receipt = await sendMedia(bot, chatId, attachment, payload.text);
    }
    return receipt;
  }

  const text = payload.text ?? "";
  if (!text) return { messageId: "0", deliveredAt: Date.now() };

  const chunks = formatForPlatform("telegram", text);
  let receipt: DeliveryReceipt = { messageId: "0", deliveredAt: Date.now() };
  for (const chunk of chunks) {
    await throttle(chatId);
    const sent = await bot.api.sendMessage(chatId, chunk.text ?? "", {
      ...(payload.replyToMessageId
        ? { reply_parameters: { message_id: Number(payload.replyToMessageId) } }
        : {}),
    });
    receipt = { messageId: String(sent.message_id), deliveredAt: Date.now() };
  }
  return receipt;
}

async function sendMedia(
  bot: Bot,
  chatId: string,
  attachment: MediaAttachment,
  caption?: string,
): Promise<DeliveryReceipt> {
  const source = attachment.url ?? attachment.data;
  if (attachment.type === "image" && source) {
    const sent = await bot.api.sendPhoto(chatId, source as any, {
      ...(caption ? { caption } : {}),
    });
    return { messageId: String(sent.message_id), deliveredAt: Date.now() };
  }
  if (attachment.type === "voice" && source) {
    const sent = await bot.api.sendVoice(chatId, source as any);
    return { messageId: String(sent.message_id), deliveredAt: Date.now() };
  }
  // Files and anything else — fall back to a document send.
  if (source) {
    const sent = await bot.api.sendDocument(chatId, source as any);
    return { messageId: String(sent.message_id), deliveredAt: Date.now() };
  }
  // No source bytes — nothing to send.
  return { messageId: "0", deliveredAt: Date.now() };
}

/**
 * Edit an existing Telegram message in place (for incremental streaming).
 * Returns false when the edit fails (e.g. content unchanged, message too old)
 * so callers can fall back to a fresh message.
 */
export async function streamEdit(
  bot: Bot,
  chatId: string,
  messageId: string,
  text: string,
): Promise<boolean> {
  try {
    await bot.api.editMessageText(chatId, Number(messageId), text);
    return true;
  } catch {
    return false;
  }
}
