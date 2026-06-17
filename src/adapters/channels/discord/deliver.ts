/**
 * Zoe Channels — Discord outbound delivery (spec 002 §10)
 *
 * Chunks to the Discord 2000-char limit (via the shared formatter) and sends
 * via the channel's send API. Discord renders Markdown natively — no stripping.
 */

import type { TextChannel, DMChannel, Message as DjsMessage } from "discord.js";
import { formatForPlatform } from "../formatter.js";
import type {
  ConversationRef,
  DeliveryReceipt,
  MediaAttachment,
  OutboundPayload,
} from "../types.js";

type SendableChannel = TextChannel | DMChannel;

/**
 * Deliver an outbound payload to a Discord channel. Returns the last message's
 * id for threading/editing.
 */
export async function deliverToDiscord(
  channel: SendableChannel,
  conv: ConversationRef,
  payload: OutboundPayload,
): Promise<DeliveryReceipt> {
  // Media-first.
  if (payload.media && payload.media.length > 0) {
    let receipt: DeliveryReceipt = { messageId: "0", deliveredAt: Date.now() };
    for (const attachment of payload.media) {
      receipt = await sendMedia(channel, attachment, payload.text);
    }
    return receipt;
  }

  const text = payload.text ?? "";
  if (!text) return { messageId: "0", deliveredAt: Date.now() };

  const chunks = formatForPlatform("discord", text);
  let receipt: DeliveryReceipt = { messageId: "0", deliveredAt: Date.now() };
  for (const chunk of chunks) {
    const sent: DjsMessage = await channel.send({
      content: chunk.text ?? "",
      ...(payload.replyToMessageId
        ? { reply: { messageReference: payload.replyToMessageId } }
        : {}),
    });
    receipt = { messageId: sent.id, deliveredAt: Date.now() };
  }
  return receipt;
}

async function sendMedia(
  channel: SendableChannel,
  attachment: MediaAttachment,
  caption?: string,
): Promise<DeliveryReceipt> {
  const source = attachment.url ?? attachment.data;
  if (!source) return { messageId: "0", deliveredAt: Date.now() };
  const sent = await channel.send({
    content: caption ?? undefined,
    files: [source as any],
  });
  return { messageId: sent.id, deliveredAt: Date.now() };
}

/** Edit a Discord message in place (for incremental streaming). */
export async function streamEdit(
  channel: SendableChannel,
  messageId: string,
  text: string,
): Promise<boolean> {
  try {
    const msg = await channel.messages.fetch(messageId);
    await msg.edit(text);
    return true;
  } catch {
    return false;
  }
}
