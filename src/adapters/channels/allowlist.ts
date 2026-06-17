/**
 * Zoe Channels — Allowlist delegator (spec 002 §6.3)
 *
 * Thin adapter-side wrapper that hands an `InboundMessage` to the core
 * `IdentityResolver` and returns the resolved identity. Does NOT reimplement
 * resolution logic (constitution II — delegate to core). The gateway knows
 * which adapter produced a message (it owns the adapter), so it supplies the
 * platform explicitly.
 */

import type { ChannelPlatform } from "../../core/types.js";
import type { IdentityResolver, ResolvedIdentity } from "../../core/identity-resolver.js";
import type { InboundMessage } from "./types.js";

export class ChannelAllowlist {
  constructor(private resolver: IdentityResolver) {}

  async authorize(
    platform: ChannelPlatform,
    msg: InboundMessage,
    botId: string,
  ): Promise<ResolvedIdentity> {
    return this.resolver.resolve({
      platform,
      platformSenderId: msg.senderId,
      conversationId: msg.conversationId,
      conversationType: msg.conversationType,
      senderName: msg.senderName,
      botId,
    });
  }
}
