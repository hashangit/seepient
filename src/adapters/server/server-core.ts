import type { ProviderType, GenerateTextResult, Usage, Message, PermissionLevel, ApproveToolFn } from "../../core/types.js";
import { runAgentLoop } from "../../core/agent-loop.js";
import { createHookExecutor } from "../../core/hooks.js";
import { resolveTools, getAllToolDefinitions } from "../../core/tool-executor.js";
import { generateId, now } from "../../core/message-convert.js";
import { getProvider } from "../../core/provider-resolver.js";
import type { Middleware } from "../../core/middleware.js";

/**
 * Server-side generateText using core agent loop directly.
 *
 * Callers may seed `options.messages` with prior conversation history (loaded
 * from the session) so multi-turn context threads like CLI/SDK — fixing the
 * Server history bug (spec 002 §3.1). When omitted, the turn starts fresh
 * (backward compatible with single-turn callers).
 */
export async function serverGenerateText(
  options: {
    message: string;
    /** Prior conversation history. When provided, the new user turn is appended to it. */
    messages?: Message[];
    model?: string;
    provider?: ProviderType;
    tools?: string[];
    maxSteps?: number;
    skills?: string[];
  },
  permissionLevel: PermissionLevel,
  middleware?: Middleware[],
): Promise<GenerateTextResult> {
  // Resolve provider
  const { provider: llmProvider, model } = await getProvider(options.provider);

  // Resolve tools
  const toolDefs = options.tools ? resolveTools(options.tools) : getAllToolDefinitions();

  // Hooks
  const hooks = createHookExecutor();

  // Build message list — seed with prior history if provided (parity with
  // CLI `Agent` and SDK `SdkAgent`, which own messages[] across turns).
  const messages: Message[] = options.messages ? [...options.messages] : [];
  messages.push({
    id: generateId(),
    role: "user",
    content: options.message,
    timestamp: now(),
  });

  // Run the agent loop
  const result = await runAgentLoop({
    provider: llmProvider,
    model: options.model ?? model,
    messages,
    toolDefs,
    maxSteps: options.maxSteps ?? 5,
    hooks,
    permissionLevel,
    middleware,
    config: { agentName: "server" },
  });

  // Extract final text from last assistant message
  const lastAssistant = [...result.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  const text = lastAssistant?.content ?? "";

  return {
    text,
    steps: result.steps,
    toolCalls: result.toolCalls,
    usage: result.usage,
    finishReason: result.finishReason as GenerateTextResult["finishReason"],
    messages: result.messages,
  };
}

/**
 * Server-side streamText using core agent loop directly.
 */
export async function serverStreamText(
  opts: {
    message: string;
    /** Prior conversation history. When provided, the new user turn is appended to it. */
    messages?: Message[];
    model?: string;
    provider?: ProviderType;
    tools?: string[];
    maxSteps?: number;
    skills?: string[];
    sessionId?: string;
    permissionLevel?: PermissionLevel;
    approveTool?: ApproveToolFn;
    onText: (delta: string) => void;
    onToolCall: (info: { name: string; args: Record<string, unknown>; callId: string }) => void;
    onToolResult: (info: { callId: string; output: string; success: boolean }) => void;
    onStep: (step: { type: string; content?: string; timestamp: number }) => void;
    onError: (error: { code: string; message: string; provider?: string; tool?: string }) => void;
    onDone: (result: { text: string; usage: Usage; finishReason: string }) => void;
    signal?: AbortSignal;
  },
  serverPermissionLevel: PermissionLevel,
  middleware?: Middleware[],
): Promise<void> {
  try {
    // Resolve provider
    const { provider: llmProvider, model } = await getProvider(opts.provider);

    // Resolve tools
    const toolDefs = opts.tools ? resolveTools(opts.tools) : getAllToolDefinitions();

    // Hooks
    const hooks = createHookExecutor();

    // Build message list — seed with prior history if provided (parity with
    // CLI `Agent` and SDK `SdkAgent`, which own messages[] across turns).
    const messages: Message[] = opts.messages ? [...opts.messages] : [];
    messages.push({
      id: generateId(),
      role: "user",
      content: opts.message,
      timestamp: now(),
    });

    // Accumulate text for the final result
    let accumulatedText = "";

    // Run the agent loop with onStep callbacks
    const result = await runAgentLoop({
      provider: llmProvider,
      model: opts.model ?? model,
      messages,
      toolDefs,
      maxSteps: opts.maxSteps ?? 5,
      hooks,
      permissionLevel: opts.permissionLevel ?? serverPermissionLevel,
      approveTool: opts.approveTool,
      signal: opts.signal,
      middleware,
      config: { agentName: "server" },
      onStep: (step) => {
        if (step.type === "text" && step.content) {
          accumulatedText += step.content;
          opts.onText(step.content);
        }
        if (step.type === "tool_call" && step.toolCall) {
          opts.onToolCall({
            name: step.toolCall.name,
            args: step.toolCall.args,
            callId: step.toolCall.id,
          });
          opts.onToolResult({
            callId: step.toolCall.id,
            output: step.toolCall.result,
            success: !step.toolCall.result.startsWith("Error:"),
          });
        }
        opts.onStep(step);
      },
    });

    opts.onDone({
      text: accumulatedText,
      usage: result.usage,
      finishReason: result.finishReason,
    });
  } catch (err) {
    opts.onError({
      code: "STREAM_ERROR",
      message: err instanceof Error ? err.message : "Stream failed",
    });
    opts.onDone({
      text: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      finishReason: "error",
    });
  }
}
