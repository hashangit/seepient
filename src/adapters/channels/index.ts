/**
 * Zoe Channels — Public API barrel (spec 002 §6.3)
 *
 * Exports the channel contract, the `ChannelGateway` runtime + factory, and
 * (later) per-platform adapter factories. For now, the interface + factory.
 */

export type {
  ChannelAdapter,
  ChannelHandlers,
  InboundMessage,
  OutboundPayload,
  ConversationRef,
  DeliveryReceipt,
  ApprovalInteraction,
  MediaAttachment,
} from "./types.js";

export { ChannelGateway } from "./gateway.js";
export type { ChannelGatewayOptions } from "./gateway.js";

export { ChannelAllowlist } from "./allowlist.js";
export { Outbox, MemoryOutboxStorage } from "./outbox.js";
export type { OutboxEntry, OutboxStorage, OutboxTrigger, OutboxDeliverFn, OutboxOptions } from "./outbox.js";
export { formatForPlatform, chunkText, stripMarkdown } from "./formatter.js";

import { ChannelGateway } from "./gateway.js";
import type { ChannelGatewayOptions } from "./gateway.js";

/**
 * Create and start a `ChannelGateway`. Returns the started gateway; callers
 * should `await gateway.stop()` on shutdown.
 */
export async function createChannelGateway(
  options: ChannelGatewayOptions,
): Promise<ChannelGateway> {
  const gateway = new ChannelGateway(options);
  await gateway.start();
  return gateway;
}
