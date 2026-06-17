/**
 * Zoe Channels — Discord adapter (spec 002 §10)
 *
 * A second platform shipping behind the SAME ChannelAdapter interface with NO
 * changes to the interface, gateway, registry, or resolver (constitution II).
 * Acceptance criterion #2 (spec §14). Implements ONLY the platform-specific
 * bits (§5.2): gateway WebSocket connection, normalization handoff, delivery,
 * button-component tool approval.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message as DjsMessage,
  type TextChannel,
  type DMChannel,
  type Interaction,
} from "discord.js";
import type { ChannelPlatform, ApproveToolCall } from "../../../core/types.js";
import type {
  ApprovalInteraction,
  ChannelAdapter,
  ChannelHandlers,
  ConversationRef,
  DeliveryReceipt,
  OutboundPayload,
} from "../types.js";
import { normalizeMessage } from "./normalize.js";
import { deliverToDiscord, streamEdit } from "./deliver.js";

export interface DiscordAdapterOptions {
  token: string;
  systemPromptOverride?: string;
}

type SendableChannel = TextChannel | DMChannel;

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly platform: ChannelPlatform = "discord";
  systemPromptOverride?: string;

  private token: string;
  private client: Client | null = null;
  private handlers: ChannelHandlers | null = null;
  /** Pending approvals keyed by customId → resolve. */
  private pendingApprovals = new Map<string, { resolve: (v: boolean) => void }>();

  constructor(opts: DiscordAdapterOptions) {
    this.token = opts.token;
    this.systemPromptOverride = opts.systemPromptOverride;
  }

  async start(handlers: ChannelHandlers): Promise<void> {
    if (this.client) return; // idempotent
    this.handlers = handlers;
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
    this.client = client;

    client.on("messageCreate", (msg: DjsMessage) => {
      // Ignore our own messages.
      if (msg.author.id === client.user?.id) return;
      const inbound = normalizeMessage(msg as unknown as Parameters<typeof normalizeMessage>[0]);
      if (inbound && this.handlers) {
        this.handlers.onInbound(inbound).catch(() => {});
      }
    });

    // Button-component tool approval: ✅/❌ resolves the decision.
    client.on("interactionCreate", async (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      const pending = this.pendingApprovals.get(interaction.customId);
      if (pending) {
        this.pendingApprovals.delete(interaction.customId);
        const approved = interaction.customId.startsWith("approve:");
        pending.resolve(approved);
      }
      try {
        await interaction.update({ components: [] });
      } catch {
        // best-effort — the interaction may have expired
      }
    });

    await client.login(this.token);
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    this.client.destroy();
    this.client = null;
    this.handlers = null;
    for (const pending of this.pendingApprovals.values()) pending.resolve(false);
    this.pendingApprovals.clear();
  }

  async deliver(conv: ConversationRef, payload: OutboundPayload): Promise<DeliveryReceipt> {
    const channel = await this.resolveChannel(conv.conversationId);
    return deliverToDiscord(channel, conv, payload);
  }

  async editMessage(conv: ConversationRef, messageId: string, text: string): Promise<boolean> {
    const channel = await this.resolveChannel(conv.conversationId);
    return streamEdit(channel, messageId, text);
  }

  createApprovalInteraction(call: ApproveToolCall, conv: ConversationRef): ApprovalInteraction {
    const id = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const approveId = `approve:${id}`;
    const denyId = `deny:${id}`;
    const chatId = conv.conversationId;

    const decision = new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(approveId, { resolve });
      this.pendingApprovals.set(denyId, { resolve });
    });

    return {
      render: async () => {
        const channel = await this.resolveChannel(chatId);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(approveId).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(denyId).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
        );
        const summary = `${call.name}(${JSON.stringify(call.args).slice(0, 200)})`;
        try {
          await channel.send({ content: `Approve tool call?\n${summary}`, components: [row] });
        } catch {
          // The gateway's 30s timeout denies regardless.
        }
      },
      decision,
      cleanup: async () => {
        this.pendingApprovals.delete(approveId);
        this.pendingApprovals.delete(denyId);
      },
    };
  }

  /** Resolve a channel id to a sendable channel via the client cache + fetch. */
  private async resolveChannel(channelId: string): Promise<SendableChannel> {
    if (!this.client) throw new Error("Discord adapter not started");
    const channel = (this.client.channels.cache.get(channelId) ??
      (await this.client.channels.fetch(channelId))) as SendableChannel | null;
    if (!channel) throw new Error(`Discord channel ${channelId} not found`);
    return channel;
  }
}
