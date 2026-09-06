import type { AskSeepientResult, Usage, Message, ApproveToolFn, StepResult } from "../../foundations/types.js";
import { runAgentLoop } from "../../domain/agent-loop.js";
import { createHookExecutor } from "../../domain/hooks.js";
import { resolveTools, getAllToolDefinitions } from "../../domain/tool-executor.js";
import { now } from "../../domain/context/message-convert.js";
import { generateId } from "../../foundations/id.js";
import { getDefaultProviderRuntime, type ProviderRuntime } from "../../domain/providers/provider-runtime.js";
import type { ProviderRuntimeContract } from "../../foundations/contracts/provider-runtime.js";
import type { Middleware } from "../../foundations/contracts/middleware.js";
import { extractLoopError } from "../sdk/error-surfacing.js";
import { normalizeHistoryForSend } from "../../domain/sessions/normalize-history.js";
import { initializeSkillRegistry } from "../../capabilities/skills/index.js";
import { buildSkillCatalog } from "../../domain/skills/skill-catalog.js";

/**
 * Resolve the skill catalog for a server-side request. Returns the system
 * prompt with the catalog appended, or undefined when no skills are found.
 * Best-effort: discovery failures are swallowed.
 */
async function resolveServerSkills(skills?: string[]): Promise<{ skillCatalog?: string; skillRegistry?: import("../../capabilities/skills/types.js").SkillRegistry }> {
  try {
    const registry = await initializeSkillRegistry(process.cwd());
    let metadata = registry.getMetadata();
    if (skills && skills.length > 0) {
      const wanted = new Set(skills);
      metadata = metadata.filter(s => wanted.has(s.name));
    }
    if (metadata.length === 0) return { skillRegistry: registry };
    return { skillCatalog: buildSkillCatalog(metadata), skillRegistry: registry };
  } catch {
    return {};
  }
}

export const MAX_HISTORY_MESSAGES = 50;

/**
 * Server-side generateText using core agent loop directly.
 */
export async function serverGenerateText(
  options: {
    message: string;
    model?: string;
    provider?: string;
    tools?: string[];
    maxSteps?: number;
    skills?: string[];
    history?: Message[];
    runtime?: ProviderRuntime | ProviderRuntimeContract;
    /** Spec 008 wired pipeline (constructed by createServer). */
    wiredPipeline?: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle;
  },
  middleware?: Middleware[],
): Promise<AskSeepientResult> {
  const runtime = options.runtime ?? getDefaultProviderRuntime();

  // Resolve tools
  const toolDefs = options.tools ? resolveTools(options.tools) : getAllToolDefinitions();

  // Hooks
  const hooks = createHookExecutor();

  // Resolve skill catalog
  const { skillCatalog, skillRegistry } = await resolveServerSkills(options.skills);

  // Build message list
  const messages: Message[] = [];
  if (skillCatalog) {
    messages.push({
      id: generateId(),
      role: "system",
      content: skillCatalog,
      timestamp: now(),
    });
  }
  if (options.history && options.history.length > 0) {
    const trimmed = options.history.slice(-MAX_HISTORY_MESSAGES);
    messages.push(...trimmed);
  }
  messages.push({
    id: generateId(),
    role: "user",
    content: options.message,
    timestamp: now(),
  });

  // W150 (D3a): a failed turn leaves a dangling persisted user message;
  // collapse it on the model-input copy so retries alternate roles.
  const modelMessages = normalizeHistoryForSend(messages);

  const snapshot = await runtime.createTurnSnapshot();

  const result = await runAgentLoop({
    runtime,
    turnSnapshot: snapshot,
    model: options.model,
    modelOverride: options.model,
    messages: modelMessages,
    toolDefs,
    maxSteps: options.maxSteps ?? 5,
    hooks,
    middleware,
    config: { agentName: "server", runtime, skills: skillRegistry },
    wiredPipeline: options.wiredPipeline,
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
    finishReason: result.finishReason as AskSeepientResult["finishReason"],
    messages: result.messages,
  };
}

export { handleAgentChatStream as serverStreamText };

/**
 * Handle POST /api/agent/chat with streaming.
 */
export async function handleAgentChatStream(
  opts: {
    message: string;
    model?: string;
    provider?: string;
    tools?: string[];
    maxSteps?: number;
    skills?: string[];
    history?: Message[];
    approveTool?: ApproveToolFn;
    runtime?: ProviderRuntime | ProviderRuntimeContract;
    /** Spec 008 wired pipeline (constructed by createServer). */
    wiredPipeline?: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle;
    onText: (chunk: string) => void;
    onToolCall: (call: { name: string; args: any; callId: string }) => void;
    onToolResult: (result: { callId: string; output: string; success: boolean }) => void;
    onStep: (step: StepResult) => void;
    onError: (error: { code: string; message: string }) => void;
    onDone: (result: { text: string; usage: Usage; finishReason: string }) => void;
    signal?: AbortSignal;
  },
  middleware?: Middleware[],
): Promise<void> {
  const runtime = opts.runtime ?? getDefaultProviderRuntime();
  const toolDefs = opts.tools ? resolveTools(opts.tools) : getAllToolDefinitions();
  const hooks = createHookExecutor();

  // Load session or create initial message list
  const messages: Message[] = [];
  const { skillCatalog, skillRegistry } = await resolveServerSkills(opts.skills);
  if (skillCatalog) {
    messages.push({
      id: generateId(),
      role: "system",
      content: skillCatalog,
      timestamp: now(),
    });
  }
  if (opts.history && opts.history.length > 0) {
    const trimmed = opts.history.slice(-MAX_HISTORY_MESSAGES);
    messages.push(...trimmed);
  }
  messages.push({
    id: generateId(),
    role: "user",
    content: opts.message,
    timestamp: now(),
  });

  // W150 (D3a): same send-time normalization as the non-streaming path.
  const modelMessages = normalizeHistoryForSend(messages);

  let accumulatedText = "";

  try {
    const snapshot = await runtime.createTurnSnapshot();

    const result = await runAgentLoop({
      runtime,
      turnSnapshot: snapshot,
      model: opts.model,
      modelOverride: opts.model,
      messages: modelMessages,
      toolDefs,
      maxSteps: opts.maxSteps ?? 5,
      hooks,
      approveTool: opts.approveTool,
      signal: opts.signal,
      middleware: middleware ?? [],
      config: { agentName: "server", runtime, skills: skillRegistry },
      wiredPipeline: opts.wiredPipeline,
      onStep: (step) => {
        if ((step.type === "text" || step.type === "text_delta") && step.content) {
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

    const loopErr = extractLoopError(result);
    if (loopErr) {
      opts.onError({
        code: loopErr.code,
        message: loopErr.message,
      });
      opts.onDone({
        text: accumulatedText,
        usage: result.usage,
        finishReason: "error",
      });
    } else {
      opts.onDone({
        text: accumulatedText,
        usage: result.usage,
        finishReason: result.finishReason,
      });
    }
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
