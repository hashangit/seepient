import type { AskSeepientResult, Usage, Message, ApproveToolFn, StepResult } from "../../foundations/types.js";
import { runAgentLoop } from "../../domain/agent-loop.js";
import { createHookExecutor } from "../../domain/hooks.js";
import type { ToolRegistryContract } from "../../foundations/contracts/tool.js";
import { resolveTools, ToolRegistry } from "../../domain/tool-executor.js";
import { now } from "../../domain/context/message-convert.js";
import { generateId } from "../../foundations/id.js";
import { createIsolatedProviderRuntime, type ProviderRuntime } from "../../domain/providers/provider-runtime.js";
import type { ProviderRuntimeContract } from "../../foundations/contracts/provider-runtime.js";
import type { Middleware } from "../../foundations/contracts/middleware.js";
import { extractLoopError } from "../sdk/error-surfacing.js";
import { normalizeHistoryForSend } from "../../domain/sessions/normalize-history.js";
import { logTransportEvent } from "../logging.js";
import { isGuardNeutralized } from "../../foundations/test-seams.js";
import * as crypto from "node:crypto";
import { initializeSkillRegistry } from "../../capabilities/skills/index.js";
import { buildSkillCatalog } from "../../domain/skills/skill-catalog.js";

/**
 * Resolve the skill catalog for a server-side request. Returns the system
 * prompt with the catalog appended, or undefined when no skills are found.
 * Best-effort: discovery failures are swallowed.
 */
async function resolveServerSkills(
  skills?: string[],
  sources?: import("../../foundations/contracts/skill-source.js").SkillSource[],
): Promise<{ skillCatalog?: string; skillRegistry?: import("../../capabilities/skills/types.js").SkillRegistry }> {
  try {
    const registry = await initializeSkillRegistry(process.cwd(), {
      tenancyMode: "multi",
      sources: sources ?? [],
    });
    let metadata = registry.getMetadata();
    if (skills && skills.length > 0) {
      const wanted = new Set(skills);
      const available = new Set(metadata.map((s) => s.name));
      const missing = Array.from(wanted).filter((name) => !available.has(name));
      if (missing.length > 0) {
        console.warn(`[SKILLS] Warning: Skill filter requested unavailable skill(s): ${missing.join(", ")}`);
      }
      metadata = metadata.filter((s) => wanted.has(s.name));
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
    sources?: import("../../foundations/contracts/skill-source.js").SkillSource[];
    history?: Message[];
    runtime?: ProviderRuntime | ProviderRuntimeContract;
    toolRegistry?: ToolRegistryContract;
    /** Spec 008 wired pipeline (constructed by createServer). */
    wiredPipeline?: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle;
    tenancyMode?: "single" | "multi";
    builtInTools?: boolean;
  },
  middleware?: Middleware[],
): Promise<AskSeepientResult> {
  if (options.runtime && (options.runtime as any).isIsolated !== true && options.tenancyMode === "multi") {
    const { TenancyRuntimeRequiredError } = await import("../../domain/tenancy/tenancy-mode.js");
    throw new TenancyRuntimeRequiredError();
  }
  const runtime = options.runtime ?? createIsolatedProviderRuntime();
  const registry = options.toolRegistry ?? new ToolRegistry();

  // Resolve tools
  const isMulti = (options as any).tenancyMode === "multi";
  const toolDefs = options.tools ? resolveTools(options.tools, registry) : ((isMulti && !(options as any).builtInTools && !isGuardNeutralized("VULN-17")) ? [] : registry.definitions());

  // Hooks
  const hooks = createHookExecutor();

  // Resolve skill catalog
  const { skillCatalog, skillRegistry } = await resolveServerSkills(options.skills, options.sources);

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
  const inputCount = modelMessages.length;

  const snapshot = await runtime.createTurnSnapshot();
  const tenancyMode = options.tenancyMode ?? (options.wiredPipeline ? "multi" : "single");

  const result = await runAgentLoop({
    runtime,
    turnSnapshot: snapshot,
    model: options.model,
    modelOverride: options.model,
    messages: modelMessages,
    toolRegistry: registry,
    toolDefs,
    maxSteps: options.maxSteps ?? 5,
    hooks,
    middleware,
    config: { agentName: "server", runtime, skills: skillRegistry },
    wiredPipeline: options.wiredPipeline,
    tenancyMode,
  });

  // B6: extract the answer from THIS turn's output only — on abort/max_steps
  // with no output, a history assistant would otherwise be returned (and
  // persisted by the transport) as this turn's answer.
  const lastAssistant = [...result.messages.slice(inputCount)]
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
    sources?: import("../../foundations/contracts/skill-source.js").SkillSource[];
    history?: Message[];
    approveTool?: ApproveToolFn;
    runtime?: ProviderRuntime | ProviderRuntimeContract;
    toolRegistry?: ToolRegistryContract;
    /** Spec 008 wired pipeline (constructed by createServer). */
    wiredPipeline?: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle;
    tenancyMode?: "single" | "multi";
    builtInTools?: boolean;
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
  if (opts.runtime && (opts.runtime as any).isIsolated !== true && (opts as any).tenancyMode === "multi") {
    const { TenancyRuntimeRequiredError } = await import("../../domain/tenancy/tenancy-mode.js");
    throw new TenancyRuntimeRequiredError();
  }
  const runtime = opts.runtime ?? createIsolatedProviderRuntime();
  const registry = opts.toolRegistry ?? new ToolRegistry();
  const isMulti = (opts as any).tenancyMode === "multi";
  const toolDefs = opts.tools ? resolveTools(opts.tools, registry) : ((isMulti && !(opts as any).builtInTools && !isGuardNeutralized("VULN-17")) ? [] : registry.definitions());
  const hooks = createHookExecutor();

  // Load session or create initial message list
  const messages: Message[] = [];
  const { skillCatalog, skillRegistry } = await resolveServerSkills(opts.skills, opts.sources);
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
    const tenancyMode = opts.tenancyMode ?? (opts.wiredPipeline ? "multi" : "single");

    const result = await runAgentLoop({
      runtime,
      turnSnapshot: snapshot,
      model: opts.model,
      modelOverride: opts.model,
      messages: modelMessages,
      toolRegistry: registry,
      toolDefs,
      maxSteps: opts.maxSteps ?? 5,
      hooks,
      approveTool: opts.approveTool,
      signal: opts.signal,
      middleware: middleware ?? [],
      config: { agentName: "server", runtime, skills: skillRegistry },
      wiredPipeline: opts.wiredPipeline,
      tenancyMode,
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
    // W162: raw detail stays in the transport log; the wire gets generic text.
    logTransportEvent({
      level: "warn",
      event: "http_request",
      requestId: crypto.randomUUID(),
      error: err instanceof Error ? err.message : "Stream failed",
    });
    opts.onError({
      code: "STREAM_ERROR",
      message: "Stream failed",
    });
    opts.onDone({
      text: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      finishReason: "error",
    });
  }
}
