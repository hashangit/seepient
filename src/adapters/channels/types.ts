/**
 * Zoe Channels — ChannelAdapter interface (spec 002 §5.1)
 *
 * The contract every platform implements. Sits at the same architectural layer
 * as CLI/SDK/Server — a runtime adapter that initiates the loop — but
 * specialized for push-based, multi-conversation messaging.
 *
 * Identity types (ChannelPlatform, ConversationType, ApproveToolCall) are
 * imported from core — this file defines ONLY the channel contract (constitution
 * II: single source of truth).
 */

import type {
  ApproveToolCall,
  ChannelPlatform,
  ConversationType,
} from "../../core/types.js";

// ── Adapter contract ───────────────────────────────────────────────────

export interface ChannelAdapter {
  readonly platform: ChannelPlatform;

  /** Connect to the platform and begin receiving. Idempotent. */
  start(handlers: ChannelHandlers): Promise<void>;

  /** Disconnect gracefully. In-flight outbound drains. */
  stop(): Promise<void>;

  /** Deliver an outbound message to a conversation. Handles chunking + format. */
  deliver(conv: ConversationRef, payload: OutboundPayload): Promise<DeliveryReceipt>;

  /** Per-channel persona/system prompt override. Optional. */
  systemPromptOverride?: string;

  /** Native tool-approval UX, if the platform supports it (buttons/etc). */
  createApprovalInteraction?(call: ApproveToolCall, conv: ConversationRef): ApprovalInteraction;
}

export interface ChannelHandlers {
  /** Called by the adapter for every normalized inbound message. */
  onInbound(msg: InboundMessage): Promise<void>;
}

// ── Inbound ────────────────────────────────────────────────────────────

export interface InboundMessage {
  /** Platform-native chat/channel/thread id. */
  conversationId: string;
  conversationType: ConversationType;
  /** Platform-scoped raw sender id. */
  senderId: string;
  senderName?: string;
  text: string;
  media?: MediaAttachment[];
  timestamp: number;
  /** For threaded/quoted replies. */
  replyTo?: { messageId: string; senderId: string };
  /** Platform payload, for advanced adapter logic. */
  raw: unknown;
}

// ── Outbound ───────────────────────────────────────────────────────────

export interface OutboundPayload {
  text?: string;
  media?: MediaAttachment[];
  /** Thread the reply to this platform message id. */
  replyToMessageId?: string;
}

export interface ConversationRef {
  conversationId: string;
  conversationType: ConversationType;
}

export interface DeliveryReceipt {
  /** Platform-native message id (for edits/replies). */
  messageId: string;
  deliveredAt: number;
}

// ── Tool approval UX ───────────────────────────────────────────────────

export interface ApprovalInteraction {
  /** Render inline buttons (or equivalent). Resolves when rendered. */
  render(): Promise<void>;
  /** The promise that resolves to the user's decision. */
  decision: Promise<boolean>;
  /** Clean up the UI after resolution or abort. */
  cleanup(): Promise<void>;
}

// ── Media ──────────────────────────────────────────────────────────────

export interface MediaAttachment {
  type: "image" | "voice" | "file";
  /** Remote URL or local path. */
  url?: string;
  /** Inline bytes. */
  data?: Buffer;
  mimeType?: string;
  caption?: string;
}
