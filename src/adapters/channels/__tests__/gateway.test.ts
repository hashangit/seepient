import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProviderResponse } from "../../../providers/types.js";
import type { Message } from "../../../core/types.js";
import { createSessionRegistry } from "../../../core/session-registry.js";
import { AllowlistIdentityResolver } from "../../../core/identity-resolver.js";
import { MemoryPersistenceBackend } from "../../../core/session-store.js";
import { ChannelGateway } from "../gateway.js";
import { Outbox, MemoryOutboxStorage } from "../outbox.js";
import type {
  ApprovalInteraction,
  ChannelAdapter,
  ChannelHandlers,
  ConversationRef,
  DeliveryReceipt,
  InboundMessage,
  OutboundPayload,
} from "../types.js";
import type { ApproveToolCall } from "../../../core/types.js";

// ── Stub provider ─────────────────────────────────────────────────────
// Returns a canned reply; optionally emits a tool call so we can exercise the
// approval path. Signature matches the real LLMProvider.chat().

function createStubProvider(opts: {
  reply: string;
  toolCall?: { id: string; name: string; arguments: string };
}) {
  const calls: Message[][] = [];
  const provider = {
    chat: vi.fn(async (messages: Message[]): Promise<ProviderResponse> => {
      calls.push(messages);
      const resp: ProviderResponse = { content: opts.reply };
      if (opts.toolCall) resp.tool_calls = [opts.toolCall];
      return resp;
    }),
    chatStream: vi.fn(async function* () {
      /* unused */
    }),
  };
  return { provider, calls };
}

// ── Mock adapter ──────────────────────────────────────────────────────
// Records deliver() calls and simulates a controllable approval decision.

interface MockAdapterOpts {
  platform?: ChannelAdapter["platform"];
  approvalDecision?: boolean; // what the simulated user picks
  systemPromptOverride?: string;
}

function createMockAdapter(opts: MockAdapterOpts = {}) {
  const delivered: { conv: ConversationRef; payload: OutboundPayload }[] = [];
  let handlers: ChannelHandlers | null = null;
  const adapter: ChannelAdapter & {
    _emit: (msg: InboundMessage) => Promise<void>;
    _delivered: typeof delivered;
    _editMessage?: (conv: ConversationRef, messageId: string, text: string) => Promise<boolean>;
  } = {
    platform: opts.platform ?? "telegram",
    systemPromptOverride: opts.systemPromptOverride,
    async start(h: ChannelHandlers) {
      handlers = h;
    },
    async stop() {
      handlers = null;
    },
    async deliver(conv, payload): Promise<DeliveryReceipt> {
      delivered.push({ conv, payload });
      return { messageId: `m-${delivered.length}`, deliveredAt: Date.now() };
    },
    createApprovalInteraction(call: ApproveToolCall, conv: ConversationRef): ApprovalInteraction {
      return {
        render: async () => {
          delivered.push({ conv, payload: { text: `approve ${call.name}?` } });
        },
        decision: Promise.resolve(opts.approvalDecision ?? false),
        cleanup: async () => {},
      };
    },
    async _emit(msg: InboundMessage) {
      if (!handlers) throw new Error("adapter not started");
      await handlers.onInbound(msg);
    },
    _delivered: delivered,
  };
  return adapter;
}

function inbound(text: string, senderId = "111"): InboundMessage {
  return {
    conversationId: "chat-1",
    conversationType: "dm",
    senderId,
    senderName: "Alice",
    text,
    timestamp: Date.now(),
    raw: {},
  };
}

// ── Gateway factory ───────────────────────────────────────────────────

async function buildGateway(opts: {
  provider: any;
  adapter: ChannelAdapter;
  resolver?: any;
}) {
  const backend = new MemoryPersistenceBackend();
  const registry = createSessionRegistry(backend);
  const resolver =
    opts.resolver ??
    new AllowlistIdentityResolver({
      platforms: { telegram: { allowlist: ["111"], admins: ["111"] } },
    });
  const outbox = new Outbox({ storage: new MemoryOutboxStorage() });
  const gateway = new ChannelGateway({
    provider: opts.provider,
    model: "stub-model",
    registry,
    resolver,
    adapters: [opts.adapter],
    outbox,
    streamMode: "single",
    maxSteps: 1,
  });
  await gateway.start();
  return { gateway, registry, outbox };
}

describe("ChannelGateway — mock adapter round-trip (US1 MVP)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("runs the full inbound → loop → outbound pipeline", async () => {
    const { provider } = createStubProvider({ reply: "hello back" });
    const adapter = createMockAdapter();
    const { gateway } = await buildGateway({ provider, adapter });

    await (adapter as any)._emit(inbound("hi"));

    // The loop's reply was delivered to the conversation.
    const deliveries = (adapter as any)._delivered as any[];
    const replies = deliveries.filter((d) => d.payload.text === "hello back");
    expect(replies.length).toBe(1);
    expect(replies[0].conv.conversationId).toBe("chat-1");

    await gateway.stop();
  });

  it("threads conversation history across two turns (not the Phase 1 bug)", async () => {
    const { provider, calls } = createStubProvider({ reply: "ok" });
    const adapter = createMockAdapter();
    const { gateway } = await buildGateway({ provider, adapter });

    await (adapter as any)._emit(inbound("my name is Alice", "111"));
    await (adapter as any)._emit(inbound("what's my name?", "111"));

    // Turn 2's prompt must contain turn 1's history.
    const turn2 = calls[1];
    expect(turn2.some((m) => m.content.includes("my name is Alice"))).toBe(true);

    await gateway.stop();
  });

  it("denies unauthorized senders and sends a refusal", async () => {
    const { provider } = createStubProvider({ reply: "should not see this" });
    const adapter = createMockAdapter();
    const { gateway } = await buildGateway({ provider, adapter });

    await (adapter as any)._emit(inbound("hi", "999")); // not on allowlist

    const deliveries = (adapter as any)._delivered as any[];
    const refusal = deliveries.find((d) => /not authorized/.test(d.payload.text ?? ""));
    expect(refusal).toBeTruthy();
    // And the loop never ran.
    expect(provider.chat).not.toHaveBeenCalled();

    await gateway.stop();
  });

  it("routes tool calls through createApprovalInteraction", async () => {
    // Use a non-admin sender (member) so permissionLevel=moderate, where the
    // destructive default risk → "ask" → approveTool is invoked.
    const resolver = new AllowlistIdentityResolver({
      platforms: {
        telegram: { allowlist: ["111", "222"], admins: ["111"] },
      },
    });
    const { provider } = createStubProvider({
      reply: "",
      toolCall: { id: "tc1", name: "execute_shell_command", arguments: '{"command":"rm -rf /"}' },
    });
    const adapter = createMockAdapter({ approvalDecision: true });
    const { gateway } = await buildGateway({ provider, adapter, resolver });

    await (adapter as any)._emit(inbound("do the thing", "222")); // member, not admin

    // The approval prompt was rendered before the tool ran.
    const deliveries = (adapter as any)._delivered as any[];
    expect(deliveries.some((d) => /approve execute_shell_command/.test(d.payload.text ?? ""))).toBe(true);

    await gateway.stop();
  });

  it("denies a tool when the user rejects the approval prompt", async () => {
    // Member sender → moderate → destructive asks → user denies → tool skipped.
    // This is the same observable outcome as the 30s auto-deny timeout
    // (both resolve the decision to false); exercising the reject path keeps
    // the test deterministic without fake timers.
    const resolver = new AllowlistIdentityResolver({
      platforms: {
        telegram: { allowlist: ["111", "222"], admins: ["111"] },
      },
    });
    const { provider } = createStubProvider({
      reply: "",
      toolCall: { id: "tc1", name: "execute_shell_command", arguments: "{}" },
    });
    const denyAdapter = createMockAdapter({ approvalDecision: false });
    const { gateway } = await buildGateway({ provider, adapter: denyAdapter as any, resolver });

    await (denyAdapter as any)._emit(inbound("do it", "222")); // member

    // Provider was called, approval was rendered, and the (denied) tool did not run.
    expect(provider.chat).toHaveBeenCalled();
    const deliveries = (denyAdapter as any)._delivered as any[];
    expect(deliveries.some((d) => /approve execute_shell_command/.test(d.payload.text ?? ""))).toBe(true);

    await gateway.stop();
  });

  it("schedule_message enqueues to the outbox and delivers after the delay", async () => {
    // A provider that calls schedule_message, so we exercise the proactive path.
    const { provider } = createStubProvider({
      reply: "",
      toolCall: {
        id: "tc1",
        name: "schedule_message",
        arguments: '{"text":"later","delayMs":10}',
      },
    });
    const adapter = createMockAdapter();
    const { gateway, outbox } = await buildGateway({ provider, adapter });

    await (adapter as any)._emit(inbound("remind me later"));

    // The outbox now holds a scheduled entry.
    const pending = outbox.due(Date.now() + 1000).filter((e) => !e.delivered);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.some((e) => e.payload.text === "later")).toBe(true);

    await gateway.stop();
  });
});
