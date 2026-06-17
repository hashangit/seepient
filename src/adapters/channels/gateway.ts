/**
 * Zoe Channels — ChannelGateway runtime (spec 002 §6)
 *
 * The shared machinery. One instance per `zoe-channels` process. Receives
 * normalized inbound messages from any adapter and runs them through:
 * identity resolution → allowlist → session resolution → loop invocation →
 * outbound delivery. Delegates to the single `runAgentLoop` — no loop logic
 * is reimplemented here (constitution I).
 */

import type {
  ApproveToolFn,
  ApproveToolCall,
  AuthorRole,
  Message,
  PermissionLevel,
  SessionData,
} from "../../core/types.js";
import { runAgentLoop } from "../../core/agent-loop.js";
import type { AgentLoopOptions } from "../../core/agent-loop.js";
import { createHookExecutor } from "../../core/hooks.js";
import type { HookExecutor } from "../../core/hooks.js";
import { getAllToolDefinitions, resolveTools } from "../../core/tool-executor.js";
import type { ToolDefinition, ToolModule } from "../../tools/interface.js";
import { generateId, now } from "../../core/message-convert.js";
import type { LLMProvider } from "../../providers/types.js";
import type { IdentityResolver } from "../../core/identity-resolver.js";
import type { SessionRegistry } from "../../core/session-registry.js";
import { formatForPlatform } from "./formatter.js";
import { transcribeVoice } from "./transcribe.js";
import { createChannelsTools } from "./tools.js";
import type { ChannelsToolContext } from "./tools.js";
import type {
  ChannelAdapter,
  ConversationRef,
  DeliveryReceipt,
  InboundMessage,
  OutboundPayload,
} from "./types.js";
import type { Outbox } from "./outbox.js";

// Re-export for the binary's convenience.
export type { ChannelAdapter } from "./types.js";

export interface ChannelGatewayOptions {
  provider: LLMProvider;
  model: string;
  registry: SessionRegistry;
  resolver: IdentityResolver;
  adapters: ChannelAdapter[];
  outbox: Outbox;
  /** Max agent steps per turn (channels default). */
  maxSteps?: number;
  /** Tool names enabled for channels (default: all). */
  tools?: string[];
  /** Extra tool definitions to inject (e.g. send_message / schedule_message). */
  extraToolDefs?: ToolDefinition[];
  /** Stream mode: 'edit' (incremental) or 'single' (one message per turn). */
  streamMode?: "edit" | "single";
  /** System prompt prepended to every channels turn. */
  systemPrompt?: string;
  /** Permission ceiling applied to resolved roles. */
  defaultPermissionLevel?: PermissionLevel;
}

interface ConversationState {
  sessionId: string;
  abortController: AbortController;
  inFlight: Promise<void> | null;
  /** The platform-native ref, for outbound delivery + outbox. */
  conversation: ConversationRef;
  platform: string;
  /** Last assistant message id (for edit-stream mode). */
  lastMessageId?: string;
}

const APPROVAL_TIMEOUT_MS = 30_000;

export class ChannelGateway {
  private provider: LLMProvider;
  private model: string;
  private registry: SessionRegistry;
  private resolver: IdentityResolver;
  private adapters: ChannelAdapter[];
  private outbox: Outbox;
  private maxSteps: number;
  private tools?: string[];
  private extraToolDefs: ToolDefinition[];
  private channelsToolModules: ToolModule[];
  private channelsInjected: Map<string, ToolModule>;
  private streamMode: "edit" | "single";
  private systemPrompt?: string;
  private defaultPermissionLevel: PermissionLevel;
  private conversations = new Map<string, ConversationState>();
  private adapterByPlatform = new Map<string, ChannelAdapter>();

  constructor(opts: ChannelGatewayOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.registry = opts.registry;
    this.resolver = opts.resolver;
    this.adapters = opts.adapters;
    this.outbox = opts.outbox;
    this.maxSteps = opts.maxSteps ?? 10;
    this.tools = opts.tools;
    this.extraToolDefs = opts.extraToolDefs ?? [];
    this.channelsToolModules = createChannelsTools(this.outbox);
    this.channelsInjected = new Map(
      this.channelsToolModules.map((m) => [m.definition.function.name, m]),
    );
    this.streamMode = opts.streamMode ?? "single";
    this.systemPrompt = opts.systemPrompt;
    this.defaultPermissionLevel = opts.defaultPermissionLevel ?? "moderate";

    for (const adapter of this.adapters) {
      this.adapterByPlatform.set(adapter.platform, adapter);
    }

    // Wire the outbox delivery to the right adapter per platform.
    this.outbox.setDeliverFn(async (platform, conversation, payload) => {
      const adapter = this.adapterByPlatform.get(platform);
      if (!adapter) throw new Error(`No adapter registered for platform "${platform}"`);
      await adapter.deliver(conversation, payload);
    });
  }

  /** Start all adapters, routing inbound into the gateway pipeline. */
  async start(): Promise<void> {
    await this.outbox.start();
    await Promise.all(
      this.adapters.map((adapter) =>
        adapter.start({
          onInbound: (msg) => this.handleInbound(adapter.platform, adapter, msg),
        }),
      ),
    );
  }

  /** Stop all adapters and drain. */
  async stop(): Promise<void> {
    await Promise.all(this.adapters.map((adapter) => adapter.stop()));
    await this.outbox.stop();
    for (const state of this.conversations.values()) {
      state.abortController.abort();
    }
  }

  // ── Inbound pipeline ────────────────────────────────────────────────

  async handleInbound(
    platform: string,
    adapter: ChannelAdapter,
    msg: InboundMessage,
  ): Promise<void> {
    // 0. Inbound media normalization (spec 002 §9.2): transcribe voice and
    //    fold it into the text; note images as content references. Runs before
    //    identity resolution so an unauthorized sender's media isn't processed.
    msg = await this.normalizeInboundMedia(msg);

    // 1. Identity resolution + allowlist.
    const identity = await this.resolver.resolve({
      platform: adapter.platform,
      platformSenderId: msg.senderId,
      conversationId: msg.conversationId,
      conversationType: msg.conversationType,
      senderName: msg.senderName,
      botId: "default",
    });
    if (!identity.authorized) {
      // Optionally send a polite refusal, then drop.
      try {
        await adapter.deliver(
          { conversationId: msg.conversationId, conversationType: msg.conversationType },
          { text: `Sorry, you're not authorized to use this bot.${identity.reason ? ` (${identity.reason})` : ""}` },
        );
      } catch {
        // Best-effort.
      }
      return;
    }

    // 2. Session resolution (load-or-create). Stamp the resolved userId +
    //    conversation type so the registry indexes them.
    const session = await this.registry.resolveSession({
      platform: adapter.platform,
      conversationId: msg.conversationId,
    });
    if (session.userId !== identity.userId || session.conversationType !== msg.conversationType) {
      session.userId = identity.userId;
      session.conversationType = msg.conversationType;
      await this.registry.save(session);
    }

    // 3. Per-conversation state + concurrency gate.
    const state = this.getOrCreateState(session.id, adapter.platform, {
      conversationId: msg.conversationId,
      conversationType: msg.conversationType,
    });
    // Queue turns within a conversation so they serialize.
    const run = (async () => {
      await state.inFlight;
      await this.runTurn(adapter, msg, session, state, identity.role, identity.displayName, identity.userId);
    })();
    state.inFlight = run.catch(() => { /* errors surface via adapter.deliver */ });
    await state.inFlight;
  }

  /**
   * Normalize inbound media into text content (spec 002 §9.2):
   *  - voice → transcribe and append to (or replace) the text
   *  - image → attach a content-reference note so the model knows one was sent
   *    (no core multimodal today; vision wiring is a future provider capability)
   */
  private async normalizeInboundMedia(msg: InboundMessage): Promise<InboundMessage> {
    if (!msg.media || msg.media.length === 0) return msg;

    let text = msg.text;
    for (const attachment of msg.media) {
      if (attachment.type === "voice") {
        const transcript = await transcribeVoice(attachment);
        if (transcript) {
          text = text ? `${text}\n[voice] ${transcript}` : transcript;
        }
      } else if (attachment.type === "image") {
        const note = `[image attached: ${attachment.caption ?? attachment.mimeType ?? "image"}]`;
        text = text ? `${text}\n${note}` : note;
      }
    }
    return { ...msg, text };
  }

  private getOrCreateState(
    sessionId: string,
    platform: string,
    conversation: ConversationRef,
  ): ConversationState {
    let state = this.conversations.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        abortController: new AbortController(),
        inFlight: Promise.resolve(),
        conversation,
        platform,
      };
      this.conversations.set(sessionId, state);
    }
    return state;
  }

  // ── One agent turn ──────────────────────────────────────────────────

  private async runTurn(
    adapter: ChannelAdapter,
    msg: InboundMessage,
    session: SessionData,
    state: ConversationState,
    role: AuthorRole,
    displayName: string,
    userId: string,
  ): Promise<void> {
    // Build the user message with resolved identity.
    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content: msg.text,
      timestamp: now(),
      authorId: userId,
      authorName: displayName,
      authorRole: role,
      platformSenderId: msg.senderId,
    };
    session.messages.push(userMessage);

    const hooks: HookExecutor = createHookExecutor();
    const toolDefs = this.resolveToolDefs();
    const permissionLevel = this.roleToPermission(role);

    // Per-turn context the channels tools read from config.channels, plus the
    // injected-tool map so the loop finds the send_message/schedule_message
    // handlers (same path as the semantic middleware).
    const channelsCtx: ChannelsToolContext = {
      role,
      sessionId: state.sessionId,
      platform: adapter.platform,
      conversation: state.conversation,
    };

    // 4. Loop invocation — THE single engine (constitution I).
    const result = await runAgentLoop({
      provider: this.provider,
      model: this.model,
      messages: session.messages,
      toolDefs,
      maxSteps: this.maxSteps,
      hooks,
      systemPrompt: adapter.systemPromptOverride ?? this.systemPrompt,
      conversationType: msg.conversationType,
      permissionLevel,
      approveTool: this.createApproveTool(adapter, state.conversation),
      signal: state.abortController.signal,
      config: {
        agentName: `channels:${adapter.platform}`,
        channels: channelsCtx,
        injectedTools: this.channelsInjected,
      },
      onStep: (step) => this.handleStep(adapter, state, step),
    } as AgentLoopOptions);

    // Persist the updated transcript (the loop mutated session.messages).
    await this.registry.save({
      ...session,
      id: state.sessionId,
      messages: result.messages,
      updatedAt: now(),
    } as SessionData);

    // 5. Outbound delivery of the final text (single-message mode).
    if (this.streamMode === "single") {
      const lastAssistant = [...result.messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.content);
      if (lastAssistant?.content) {
        await this.deliverChunked(adapter, state.conversation, lastAssistant.content);
      }

      // 5b. Deliver images produced by generate_image / take_screenshot this
      // turn as platform media (spec §9.2 outbound media).
      await this.deliverImageResults(adapter, state.conversation, result.steps);
    }
  }

  /**
   * Scan a turn's tool-call steps for image/screenshot results and push them
   * as outbound media. The reference tools return a file path in their result
   * text; we read it into bytes and attach as a photo. Failures are best-effort
   * (a missing/unreadable path is skipped, not fatal).
   */
  private async deliverImageResults(
    adapter: ChannelAdapter,
    conv: ConversationRef,
    steps: { type: string; toolCall?: { name: string; result: string } }[],
  ): Promise<void> {
    const IMAGE_TOOLS = new Set(["generate_image", "take_screenshot"]);
    for (const step of steps) {
      if (step.type !== "tool_call" || !step.toolCall) continue;
      if (!IMAGE_TOOLS.has(step.toolCall.name)) continue;
      const filePath = extractFilePath(step.toolCall.result);
      if (!filePath) continue;
      try {
        const { readFile } = await import("node:fs/promises");
        const data = await readFile(filePath);
        await adapter.deliver(conv, {
          media: [{ type: "image", data, mimeType: "image/png", caption: step.toolCall.name }],
        });
      } catch {
        // best-effort — unreadable or missing file is skipped
      }
    }
  }

  // ── Streaming step handler ──────────────────────────────────────────

  private async handleStep(
    adapter: ChannelAdapter,
    state: ConversationState,
    step: { type: string; content?: string },
  ): Promise<void> {
    if (this.streamMode !== "edit") return;
    if (step.type !== "text" || !step.content) return;

    // Edit-stream mode: first chunk sends, subsequent chunks edit.
    const chunks = formatForPlatform(adapter.platform, step.content);
    for (const chunk of chunks) {
      if (!state.lastMessageId) {
        const receipt = await adapter.deliver(state.conversation, chunk);
        state.lastMessageId = receipt.messageId;
      } else {
        // Adapter must expose an edit primitive for true streaming; the
        // reference Telegram adapter provides `streamEdit`. For platforms
        // without edit, fall back to a fresh message.
        const edited = await this.tryEdit(adapter, state.conversation, state.lastMessageId, chunk.text ?? "");
        if (!edited) {
          const receipt = await adapter.deliver(state.conversation, chunk);
          state.lastMessageId = receipt.messageId;
        }
      }
    }
  }

  private async tryEdit(
    adapter: ChannelAdapter,
    conv: ConversationRef,
    messageId: string,
    text: string,
  ): Promise<boolean> {
    // Optional `editMessage` capability — present on adapters that support
    // in-place edits (Telegram). Falls back to false (new message) otherwise.
    const anyAdapter = adapter as ChannelAdapter & {
      editMessage?(conv: ConversationRef, messageId: string, text: string): Promise<boolean>;
    };
    if (typeof anyAdapter.editMessage === "function") {
      try {
        return await anyAdapter.editMessage(conv, messageId, text);
      } catch {
        return false;
      }
    }
    return false;
  }

  private async deliverChunked(
    adapter: ChannelAdapter,
    conv: ConversationRef,
    text: string,
  ): Promise<DeliveryReceipt | undefined> {
    const chunks = formatForPlatform(adapter.platform, text);
    let last: DeliveryReceipt | undefined;
    for (const chunk of chunks) {
      last = await adapter.deliver(conv, chunk);
    }
    return last;
  }

  // ── Tool approval ───────────────────────────────────────────────────

  private createApproveTool(adapter: ChannelAdapter, conv: ConversationRef): ApproveToolFn {
    return async (call: ApproveToolCall) => {
      // Platforms without native approval UX fall back to a text prompt.
      if (!adapter.createApprovalInteraction) {
        await adapter.deliver(conv, {
          text: `Tool "${call.name}" requires approval. Reply "yes" to approve (default: deny).`,
        });
        return false; // text-prompt fallback auto-denies (no reply parsing in v1).
      }
      const interaction = adapter.createApprovalInteraction(call, conv);
      try {
        await interaction.render();
      } catch {
        return false;
      }
      return await Promise.race([
        interaction.decision,
        timeoutDeny(APPROVAL_TIMEOUT_MS),
      ]).finally(() => {
        void interaction.cleanup();
      });
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private resolveToolDefs(): ToolDefinition[] {
    const base = this.tools ? resolveTools(this.tools) : getAllToolDefinitions();
    const channelsDefs = this.channelsToolModules.map((m) => m.definition);
    return [...base, ...this.extraToolDefs, ...channelsDefs];
  }

  private roleToPermission(role: AuthorRole): PermissionLevel {
    // Admins run permissive; members/guests are capped at the configured default.
    if (role === "admin") return "permissive";
    return this.defaultPermissionLevel;
  }

  /** Expose for the binary / tests. */
  getOutbox(): Outbox {
    return this.outbox;
  }
}

function timeoutDeny(ms: number): Promise<boolean> {
  return new Promise((resolve) => setTimeout(() => resolve(false), ms));
}

/**
 * Extract a file path from a tool result string. The reference image tools
 * embed the saved path in their output (e.g. "Image saved to /path/x.png").
 * Returns the first quoted or bare path ending in an image extension, or null.
 */
function extractFilePath(result: string): string | null {
  const match = result.match(/([\w./~\-]+\.(?:png|jpe?g|webp|gif))/i);
  return match ? match[1] : null;
}
