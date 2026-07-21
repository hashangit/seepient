import type { ProviderType, GenerateTextResult, Usage, Message, PermissionLevel, ApproveToolFn } from "../../foundations/types.js";
import { runAgentLoop } from "../../domain/agent-loop.js";
import { createHookExecutor } from "../../domain/hooks.js";
import { resolveTools, getAllToolDefinitions } from "../../domain/tool-executor.js";
import { now } from "../../domain/context/message-convert.js";
import { generateId } from "../../foundations/id.js";
import { getProvider } from "../../domain/providers/provider-resolver.js";
import type { Middleware } from "../../foundations/contracts/middleware.js";
import { initializeSkillRegistry } from "../../capabilities/skills/index.js";
import { buildSkillCatalog } from "../../domain/skills/skill-catalog.js";

/**
 * Resolve the skill catalog for a server-side request. Returns the system
 * prompt with the catalog appended, or undefined when no skills are found.
 * Best-effort: discovery failures are swallowed.
 */
async function resolveServerSkillCatalog(skills?: string[]): Promise<string | undefined> {
  try {
    const registry = await initializeSkillRegistry(process.cwd());
    let metadata = registry.getMetadata();
    if (skills && skills.length > 0) {
      const wanted = new Set(skills);
      metadata = metadata.filter(s => wanted.has(s.name));
    }
    if (metadata.length === 0) return undefined;
    return buildSkillCatalog(metadata);
  } catch {
    return undefined;
  }
}

/**
 * Server-side generateText using core agent loop directly.
 */
export async function serverGenerateText(
  options: {
    message: string;
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

  // Resolve skill catalog
  const skillCatalog = await resolveServerSkillCatalog(options.skills);

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

    // Resolve skill catalog
    const skillCatalog = await resolveServerSkillCatalog(opts.skills);

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
