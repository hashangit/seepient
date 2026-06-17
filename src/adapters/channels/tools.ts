/**
 * Zoe Channels — Proactive outbound tools (spec 002 §7.1)
 *
 * `send_message` (immediate, `trigger:"event"`) and `schedule_message`
 * (deferred, `trigger:"scheduled"`) let the LLM proactively reach a
 * conversation. Both are role-gated: only `admin` may schedule; `member` may
 * send within the active turn. Enforced inside the handler by reading the role
 * + session from the per-turn context the gateway injects via
 * `config.channels`.
 *
 * Returned as `ToolModule[]` so the gateway injects them through the existing
 * `config.injectedTools` path (same as the semantic middleware) — no new tool
 * execution mechanism (constitution II). NOT added to the global registry
 * (constitution III).
 */

import type { ChannelPlatform, ToolResult } from "../../core/types.js";
import type { ToolModule } from "../../tools/interface.js";
import type { Outbox } from "./outbox.js";
import type { ConversationRef, OutboundPayload } from "./types.js";

/** Per-turn context the gateway injects so handlers can act. */
export interface ChannelsToolContext {
  role: "admin" | "member" | "guest";
  sessionId: string;
  platform: ChannelPlatform;
  conversation: ConversationRef;
}

const SCHEDULING_DENIED = "Scheduling messages requires the admin role.";
const SENDING_DENIED = "Sending messages is not permitted for your role.";

/**
 * Build the channels tool modules. Handlers close over the outbox and read the
 * per-turn context from `config.channels` (set by the gateway each turn).
 */
export function createChannelsTools(outbox: Outbox): ToolModule[] {
  const send_message: ToolModule = {
    name: "Channels — Send Message",
    risk: "communications",
    definition: {
      type: "function",
      function: {
        name: "send_message",
        description:
          "Send a message to the current conversation immediately (proactive outbound). Useful for tool-result-driven notifications or reminders within the active turn.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The message text to send." },
          },
          required: ["text"],
        },
      },
    },
    handler: async (args: any, config?: any): Promise<string | ToolResult> => {
      const ctx = readContext(config);
      if (ctx.role === "guest") return `Error: ${SENDING_DENIED}`;
      const text = String(args?.text ?? "");
      const payload: OutboundPayload = { text };
      await outbox.enqueue({
        sessionId: ctx.sessionId,
        platform: ctx.platform,
        conversation: ctx.conversation,
        payload,
        scheduledFor: Date.now(), // immediate
        trigger: "event",
      });
      return "Message sent.";
    },
  };

  const schedule_message: ToolModule = {
    name: "Channels — Schedule Message",
    risk: "communications",
    definition: {
      type: "function",
      function: {
        name: "schedule_message",
        description:
          "Schedule a message to be delivered to the current conversation at a future time. Requires the admin role.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The message text to send." },
            delayMs: {
              type: "number",
              description: "Milliseconds from now to wait before delivering.",
            },
          },
          required: ["text", "delayMs"],
        },
      },
    },
    handler: async (args: any, config?: any): Promise<string | ToolResult> => {
      const ctx = readContext(config);
      if (ctx.role !== "admin") return `Error: ${SCHEDULING_DENIED}`;
      const text = String(args?.text ?? "");
      const delayMs = Number(args?.delayMs ?? 0);
      const payload: OutboundPayload = { text };
      await outbox.enqueue({
        sessionId: ctx.sessionId,
        platform: ctx.platform,
        conversation: ctx.conversation,
        payload,
        scheduledFor: Date.now() + Math.max(0, delayMs),
        trigger: "scheduled",
      });
      return `Message scheduled to deliver in ${delayMs}ms.`;
    },
  };

  return [send_message, schedule_message];
}

function readContext(config: unknown): ChannelsToolContext {
  const cfg = (config ?? {}) as { channels?: ChannelsToolContext };
  const ctx = cfg.channels;
  if (!ctx || !ctx.role || !ctx.sessionId || !ctx.platform || !ctx.conversation) {
    throw new Error("Channels tools require channels context in ToolContext.config.channels.");
  }
  return ctx;
}
