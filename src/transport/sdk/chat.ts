/**
 * Seepient SDK — `createChat` multi-turn front door (spec 027, D14/owner OQ-3).
 *
 * The one deliberate new API shape of the core split: a thin factory over the
 * stateless agent returning a session object that owns its message history —
 * exactly the app-managed-session pattern serverless consumers hand-roll
 * today. No engine machinery of its own: if a turn needs a seam, the seam
 * lives in the agent.
 */
import type {
  AgentResponse,
  AskSeepientStreamResult,
  CreateSeepientOptions,
  Message,
  Seepient,
} from "../../foundations/types.js";
import { createSeepient } from "./seepient.js";

/** One completed turn: the answer text, the tool calls made, and token usage. */
export type ChatTurnResult = AgentResponse;

/**
 * Per-stream-turn options — exactly the fields the streaming turn consumes
 * (review P3: the previous type advertised fields like model/tools/system
 * prompt that the instance ignores on a per-call basis).
 */
export interface ChatStreamOptions {
  purpose?: import("../../foundations/types.js").Purpose;
  tier?: import("../../foundations/types.js").Tier;
  temperature?: number;
  maxTokens?: number;
  onStep?: (step: import("../../foundations/types.js").StepResult) => void;
  onText?: (delta: string) => void;
  onToolCall?: (tool: { name: string; args: Record<string, unknown>; callId: string }) => void;
  onToolResult?: (result: { callId: string; output: string; success: boolean }) => void;
  onError?: (error: import("../../domain/agent-loop.js").AgentLoopError) => void;
}

/**
 * A multi-turn chat session created by `createChat`. The session owns its
 * message history across turns; durability comes from the injected stores,
 * not from this object.
 */
export interface ChatSession {
  /** Run one turn and await the complete result. */
  send(text: string): Promise<ChatTurnResult>;
  /** Run one streaming turn; resolves when the turn settles. */
  stream(text: string, callbacks?: ChatStreamOptions): Promise<AskSeepientStreamResult>;
  /** The history this session owns (assistant/user/tool/system rows). */
  readonly messages: readonly Message[];
  /** Abort the in-flight turn, if any. */
  abort(): void;
  /** Flush audit + abort (parity with the agent instance). */
  close(): Promise<void>;
}

/**
 * Create a multi-turn chat session.
 *
 * Options are the same family as `createSeepient` (providers/config store,
 * injectable stores, tools, middleware, system prompt, tenancy). Internally
 * this creates the stateless agent (no persistence of its own unless the
 * caller injects one) and delegates every turn to it.
 *
 * @example
 * ```ts
 * import { createChat } from "seepient-core";
 *
 * const chat = await createChat({ providers: [...], systemPrompt: "You are…" });
 * const first = await chat.send("Hello!");
 * for await (const delta of (await chat.stream("Go on")).textStream) { … }
 * ```
 */
export async function createChat(options?: CreateSeepientOptions): Promise<ChatSession> {
  const opts: CreateSeepientOptions = { ...(options ?? {}) };
  // Stateless by construction (no persistence of its own) unless the caller
  // explicitly injects durability or chooses a mode.
  if (opts.stateless === undefined && !opts.persist) {
    opts.stateless = true;
  }
  const agent: Seepient = await createSeepient(opts);
  return {
    send: (text: string) => agent.chat(text),
    stream: (text, callbacks) => agent.chatStream(text, callbacks),
    get messages(): readonly Message[] {
      return agent.getHistory();
    },
    abort: () => agent.abort(),
    close: () => agent.close(),
  };
}
