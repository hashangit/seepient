/**
 * Zoe Channels — Telegram inbound normalization (spec 002 §9.1)
 *
 * Maps a Telegram Bot API `Update` to the canonical `InboundMessage`. Kept
 * decoupled from grammY's concrete types so it stays unit-testable with plain
 * fixture objects (the Telegram payload shape is stable across the official
 * API and grammY, which wraps it verbatim).
 */

import type {
  InboundMessage,
  MediaAttachment,
} from "../types.js";

// ── Minimal Telegram Bot API shapes (subset we consume) ───────────────
// These mirror the official Telegram Bot API object graph. grammY's `Update`
// is a thin TS wrapper over the same shape, so a plain object works for both
// live grammY updates and test fixtures.

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  voice?: { file_id: string; duration?: number; mime_type?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string };
  reply_to_message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  edited_message?: TgMessage;
}

// ── Normalization ─────────────────────────────────────────────────────

/**
 * Map a Telegram `Update` to the canonical `InboundMessage`, or `null` when
 * the update carries no text and no media (drops non-text non-media noise).
 *
 * Returns the async form so callers that need to fetch media bytes can do so
 * (T035 wires the file download); here media is captured by file id only.
 */
export async function normalizeUpdate(update: TgUpdate): Promise<InboundMessage | null> {
  const msg = update.message ?? update.channel_post ?? update.edited_message;
  if (!msg || !msg.chat || !msg.from) return null;

  const text = msg.text ?? msg.caption ?? "";
  const media = extractMedia(msg);

  // Drop updates with neither text nor media.
  if (!text && media.length === 0) return null;

  const conversationType = msg.chat.type === "private" ? "dm" : "group";

  return {
    conversationId: String(msg.chat.id),
    conversationType,
    senderId: String(msg.from.id),
    senderName: msg.from.first_name ?? msg.from.username ?? String(msg.from.id),
    text,
    ...(media.length > 0 ? { media } : {}),
    timestamp: msg.date * 1000,
    ...(msg.reply_to_message
      ? {
          replyTo: {
            messageId: String(msg.reply_to_message.message_id),
            senderId: String(msg.reply_to_message.from?.id ?? ""),
          },
        }
      : {}),
    raw: update,
  };
}

/** Extract media attachments from a Telegram message (largest photo, voice, doc). */
export function extractMedia(msg: TgMessage): MediaAttachment[] {
  const media: MediaAttachment[] = [];

  if (msg.photo && msg.photo.length > 0) {
    // Telegram sends multiple sizes; pick the largest (last) by dimensions.
    const largest = msg.photo.reduce((a, b) =>
      (b.width ?? 0) * (b.height ?? 0) > (a.width ?? 0) * (a.height ?? 0) ? b : a,
    );
    media.push({ type: "image", url: largest.file_id, mimeType: "image/jpeg" });
  }

  if (msg.voice) {
    media.push({
      type: "voice",
      url: msg.voice.file_id,
      ...(msg.voice.mime_type ? { mimeType: msg.voice.mime_type } : {}),
    });
  }

  if (msg.document) {
    media.push({
      type: "file",
      url: msg.document.file_id,
      ...(msg.document.mime_type ? { mimeType: msg.document.mime_type } : {}),
      ...(msg.document.file_name ? { caption: msg.document.file_name } : {}),
    });
  }

  return media;
}
