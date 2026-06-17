/**
 * Zoe Channels — Discord inbound normalization (spec 002 §10)
 *
 * Maps a discord.js `Message` to the canonical `InboundMessage`. Uses a minimal
 * local shape (mirroring discord.js's public `Message` surface) so it stays
 * unit-testable with plain fixtures.
 */

import type {
  ConversationType,
} from "../../../core/types.js";
import type {
  InboundMessage,
  MediaAttachment,
} from "../types.js";

export interface DjsAttachment {
  id: string;
  url: string;
  contentType?: string;
  name?: string;
}

export interface DjsChannel {
  id: string;
  isDMBased?: () => boolean;
  type?: number;
}

export interface DjsUser {
  id: string;
  username: string;
}

export interface DjsMessage {
  id: string;
  content: string;
  createdTimestamp: number;
  channelId: string;
  channel: DjsChannel;
  author: DjsUser;
  attachments: Map<string, DjsAttachment> | DjsAttachment[];
  reference?: { messageId?: string };
}

/**
 * Map a discord.js `Message` to the canonical `InboundMessage`.
 */
export function normalizeMessage(message: DjsMessage): InboundMessage | null {
  if (!message.author || !message.channel) return null;

  const conversationType: ConversationType = isDm(message.channel) ? "dm" : "channel";
  const media = extractMedia(message);

  // Drop messages with no text and no media.
  if (!message.content && media.length === 0) return null;

  return {
    conversationId: message.channel.id,
    conversationType,
    senderId: message.author.id,
    senderName: message.author.username,
    text: message.content ?? "",
    ...(media.length > 0 ? { media } : {}),
    timestamp: message.createdTimestamp,
    ...(message.reference?.messageId
      ? { replyTo: { messageId: message.reference.messageId, senderId: "" } }
      : {}),
    raw: message,
  };
}

function isDm(channel: DjsChannel): boolean {
  if (typeof channel.isDMBased === "function") return channel.isDMBased();
  // Fallback: discord.js channel type 1 = DM.
  return channel.type === 1;
}

function extractMedia(message: DjsMessage): MediaAttachment[] {
  const list = Array.isArray(message.attachments)
    ? message.attachments
    : Array.from(message.attachments.values());
  const media: MediaAttachment[] = [];
  for (const a of list) {
    const type = contentTypeToType(a.contentType);
    media.push({
      type,
      url: a.url,
      ...(a.contentType ? { mimeType: a.contentType } : {}),
      ...(a.name ? { caption: a.name } : {}),
    });
  }
  return media;
}

function contentTypeToType(contentType?: string): MediaAttachment["type"] {
  if (!contentType) return "file";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "voice";
  return "file";
}
