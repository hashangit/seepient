/** Seepient Core — THE Agent Loop (single implementation) */

import type { Message, StepResult, ToolCall, Usage, SeepientError, ApproveToolFn, ApprovalDecision, ApprovalScope, ApprovalContext, PermissionLevel, ToolRiskCategory } from "../foundations/types.js";
import type { LLMProvider, ProviderMessage, ProviderToolCall, ProviderResponse } from "../foundations/contracts/llm.js";
import type { ToolDefinition } from "../foundations/contracts/tool.js";
import { now, toSeepientError, messageToProviderMessage, providerToolCallToToolCall } from "./context/message-convert.js";
import { generateId } from "../foundations/id.js";
import { StreamingResponseAccumulator } from "./streaming/stream-accumulator.js";
import { executeTool, normalizeToolResult } from "./tool-executor.js";
import type { HookExecutor } from "./hooks.js";
import type { Middleware, PipelineContext } from "../foundations/contracts/middleware.js";
import { compose } from "../foundations/contracts/middleware.js";
import { checkToolPermission, getToolRiskCategory } from "./permission.js";
import { GrantStore } from "./grants.js";
import { extractPattern } from "../foundations/grant-pattern.js";
import { getAllToolModules } from "./tool-executor.js";
import { getModelMeta } from "../foundations/models-catalog.js";
import type { ActionLifecycle } from "./permissions/action-lifecycle.js";

// ProviderFactory for per-skill model switching
export interface ProviderFactory {
  resolve(skillName?: string): Promise<{ provider: LLMProvider; model: string }>;
  restore(): void;
}

export interface AgentLoopOptions {
  provider: LLMProvider;
  model: string;
  messages: Message[];
  toolDefs: ToolDefinition[];
  systemPrompt?: string;          // Prepended as system message if provided
  maxSteps: number;
  hooks: HookExecutor;
  signal?: AbortSignal;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  onStep?: (step: StepResult) => void;
  /** Opt into token streaming (provider.chatStream). Off → always chat(). */
  stream?: boolean;
  providerFactory?: ProviderFactory;
  middleware?: Middleware[];
  approveTool?: ApproveToolFn;
  permissionLevel?: PermissionLevel;
  autoConfirm?: boolean;
  /** Persisted approval grants. When set, matching calls skip the prompt. */
  grantStore?: GrantStore;
  /**
   * Spec 008 action-lifecycle delegate. When set, each tool call is routed
   * through the new Domain policy pipeline (PolicyEngine → ApprovalBroker →
   * ExecutionBoundary → audit) instead of the legacy matrix/grant/admit
   * branches. The legacy branches remain the default until P3 wires every
   * adapter; this is the P0/P1 ship-strategy feature flag.
   */
  actionLifecycle?: ActionLifecycle;
}

export interface AgentLoopError {
  message: string;
  code: string;          // "PROVIDER_ERROR" | "TOOL_FAILED" | "MAX_STEPS" | "ABORTED"
  retryable: boolean;
  provider?: string;
  tool?: string;
}

export interface AgentLoopResult {
  messages: Message[];
  steps: StepResult[];
  toolCalls: ToolCall[];
  usage: Usage;
  /** Prompt tokens of the LAST provider request — reflects actual context-window usage. */
  contextTokens: number;
  finishReason: "stop" | "max_steps" | "error" | "aborted";
  error?: AgentLoopError;
}

/**
 * Normalize an ApprovalDecision (bare boolean OR scoped object) into a plain
 * `{ approved, scope }`. Bare booleans default to scope "once".
 */
function normalizeApproval(decision: ApprovalDecision): { approved: boolean; scope: ApprovalScope } {
  if (typeof decision === "boolean") return { approved: decision, scope: "once" };
  return { approved: decision.approved, scope: decision.scope ?? "once" };
}

/**
 * Build the LLM-authored gate context from a tool call's args. Reads the
 * optional structured `approval` object; falls back to the legacy flat
 * `rationale` string for the description; then to empty. Never throws.
 */
function buildApprovalContext(args: Record<string, unknown>): ApprovalContext | undefined {
  const approval = args.approval;
  if (approval && typeof approval === "object") {
    const a = approval as Record<string, unknown>;
    const title = typeof a.title === "string" ? a.title : "";
    const description = typeof a.description === "string" ? a.description : "";
    const implications = a.implications;
    if (title || description) {
      const ctx: ApprovalContext = { title, description };
      if (implications && typeof implications === "object") {
        ctx.implications = implications as ApprovalContext["implications"];
      }
      return ctx;
    }
  }
  // Legacy fallback: flat `rationale` string (e.g. execute_shell_command).
  const rationale = args.rationale;
  if (typeof rationale === "string" && rationale.length > 0) {
    return { title: "", description: rationale };
  }
  return undefined;
}

/**
 * Run the Seepient agent loop - THE single implementation.
 *
 * This is the canonical agent loop that all other entry points (createAgent,
 * generateText, streamText, CLI Agent) will delegate to. It handles:
 *
 * - Multi-step reasoning with tool execution
 * - Provider resolution (including per-skill switching via providerFactory)
 * - System prompt injection
 * - Abort signal handling
 * - Hook execution
 * - Usage estimation
 * - Structured error reporting
 * - Middleware pipeline (when provided)
 *
 * @param options - Agent loop configuration
 * @returns AgentLoopResult with messages, steps, tool calls, usage, and finish reason
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    provider,
    model,
    messages,
    toolDefs,
    systemPrompt,
    maxSteps,
    hooks,
    signal,
    config = {},
    metadata = {},
    onStep,
    providerFactory,
    middleware,
  } = options;

  // ── No middleware: run loop directly (backward compatible) ────────────
  if (!middleware || middleware.length === 0) {
    return executeLoop(options);
  }

  // ── With middleware: wrap loop in pipeline ────────────────────────────
  const ctx: PipelineContext = {
    requestId: generateId(),
    messages,
    provider,
    model,
    toolDefs,
    metadata,
    signal,
    startedAt: Date.now(),
  };

  try {
    await compose(middleware)(ctx, async () => {
      // Rebuild options from ctx to capture middleware mutations (e.g., injected tools)
      const mergedOptions: AgentLoopOptions = {
        ...options,
        toolDefs: ctx.toolDefs,
        config: {
          ...options.config,
          agentName: options.config?.agentName ?? 'seepient',
          ...(ctx.metadata.injectedTools ? { injectedTools: ctx.metadata.injectedTools } : {}),
        },
      };
      const result = await executeLoop(mergedOptions);
      ctx.result = {
        messages: result.messages,
        steps: result.steps,
        toolCalls: result.toolCalls,
        usage: result.usage,
        contextTokens: result.contextTokens,
        finishReason: result.finishReason,
      };
    });

    // ctx.result is populated by the final handler
    if (ctx.result) {
      return {
        messages: ctx.result.messages,
        steps: ctx.result.steps,
        toolCalls: ctx.result.toolCalls,
        usage: ctx.result.usage,
        contextTokens: ctx.result.contextTokens,
        finishReason: ctx.result.finishReason as AgentLoopResult["finishReason"],
      };
    }

    // Middleware completed without populating result (shouldn't happen)
    return {
      messages,
      steps: [],
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      contextTokens: 0,
      finishReason: "error",
      error: {
        message: "Middleware completed without producing a result",
        code: "MIDDLEWARE_ERROR",
        retryable: false,
      },
    };
  } catch (err) {
    // Log the error for audit trail even though middleware chain was interrupted
    console.error(`[middleware] request ${ctx.requestId} failed after ${Date.now() - ctx.startedAt}ms:`,
      err instanceof Error ? err.message : String(err));

    return {
      messages,
      steps: [],
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      contextTokens: 0,
      finishReason: "error",
      error: {
        message: err instanceof Error ? err.message : String(err),
        code: (err as any)?.code ?? "MIDDLEWARE_ERROR",
        retryable: false,
      },
    };
  }
}

/**
 * Execute the core agent loop (no middleware wrapping).
 * Extracted from runAgentLoop for clarity.
 */
async function executeLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    provider,
    model,
    messages,
    toolDefs,
    systemPrompt,
    maxSteps,
    hooks,
    signal,
    config = {},
    onStep,
    stream,
    providerFactory,
  } = options;

  // Destructure approveTool outside the loop for closure access
  const approveTool = options.approveTool;
  const permissionLevel = options.permissionLevel;
  const autoConfirm = options.autoConfirm;
  const grantStore = options.grantStore;

  // Prepend system prompt if provided and messages[0] is not already a system message
  if (systemPrompt && messages.length > 0 && messages[0].role !== "system") {
    messages.unshift({
      id: generateId(),
      role: "system",
      content: systemPrompt,
      timestamp: now(),
    });
  }

  const steps: StepResult[] = [];
  const allToolCalls: ToolCall[] = [];
  let finishReason: "stop" | "max_steps" | "error" | "aborted" = "stop";
  let loopError: AgentLoopError | undefined;

  // For usage calculation — prefer real API usage; fall back to char÷4 estimate.
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  // Context-window fill: the prompt tokens of the most recent provider request.
  // Each request resends the full conversation (system + tools + all messages),
  // so this equals how full the context window is after this turn.
  let lastContextTokens = 0;

  // Track current provider (may change per step if providerFactory is used)
  let currentProvider = provider;
  let currentModel = model;

  // Track whether the loop exhausted maxSteps
  let hitMaxSteps = false;

  for (let step = 0; step < maxSteps; step++) {
    try {
    // Check abort
    if (signal?.aborted) {
      finishReason = "aborted";
      loopError = {
        message: "Operation was aborted",
        code: "ABORTED",
        retryable: false,
      };
      break;
    }

    // Resolve provider for this step (for skill-driven provider switching)
    if (providerFactory) {
      try {
        const resolved = await providerFactory.resolve();
        currentProvider = resolved.provider;
        currentModel = resolved.model;
      } catch (err) {
        finishReason = "error";
        loopError = {
          message: err instanceof Error ? err.message : String(err),
          code: "PROVIDER_ERROR",
          retryable: true,
          provider: currentModel,
        };
        const seepientErr = toSeepientError(err, "PROVIDER_ERROR");
        await hooks.onError(seepientErr);
        break;
      }
    }

    // Convert messages to provider format
    const providerMessages: ProviderMessage[] = messages.map(messageToProviderMessage);

    // Call provider (stream if available, else chat). Streaming emits
    // text_delta steps as tokens arrive; non-streaming emits one complete
    // 'text' step below. Tool calls are reassembled by the accumulator.
    let response: ProviderResponse;
    let streamed = false;
    let acc: StreamingResponseAccumulator | undefined;
    try {
      if (stream && typeof currentProvider.chatStream === 'function') {
        streamed = true;
        acc = new StreamingResponseAccumulator();
        for await (const delta of currentProvider.chatStream(providerMessages, toolDefs, { signal })) {
          if (delta.type === 'text_delta' && delta.content) {
            acc.appendText(delta.content);
            const deltaStep: StepResult = { type: 'text_delta', content: delta.content, timestamp: now() };
            steps.push(deltaStep);
            await hooks.onStep(deltaStep);
            if (onStep) onStep(deltaStep);
          } else if (delta.type === 'tool_call_begin') {
            acc.beginToolCall(delta.index, delta.id, delta.name);
          } else if (delta.type === 'tool_call_delta') {
            acc.appendToolCallArgs(delta.index, delta.argumentsDelta);
          } else if (delta.type === 'finish' && delta.usage) {
            acc.setUsage(delta.usage);
          }
        }
        response = acc.toResponse();
      } else {
        response = await currentProvider.chat(providerMessages, toolDefs, { signal });
      }
    } catch (err) {
      finishReason = "error";
      const seepientErr = toSeepientError(err, "PROVIDER_ERROR");
      loopError = {
        message: seepientErr.message,
        code: "PROVIDER_ERROR",
        retryable: seepientErr.retryable,
        provider: currentModel,
      };
      await hooks.onError(seepientErr);
      break;
    }

    // Capture real usage from the provider (streaming: accumulator; non-streaming:
    // response.usage). Falls back to a char÷4 estimate when unavailable (e.g.
    // mock/test providers), so usage is never zero for a real call.
    const stepUsage = streamed ? acc?.getUsage() : response.usage;
    if (stepUsage) {
      totalPromptTokens += stepUsage.promptTokens;
      totalCompletionTokens += stepUsage.completionTokens;
      lastContextTokens = stepUsage.promptTokens;
    } else {
      // Fallback: estimate this step's prompt from the current providerMessages
      let stepPromptChars = 0;
      for (const msg of providerMessages) {
        stepPromptChars += (msg.content ?? "").length;
      }
      const estPrompt = Math.ceil(stepPromptChars / 4);
      const estCompletion = Math.ceil((response.content ?? "").length / 4);
      totalPromptTokens += estPrompt;
      totalCompletionTokens += estCompletion;
      lastContextTokens = estPrompt;
    }

    // Text content. When streamed, tokens already went out as text_delta steps,
    // so we only emit the complete 'text' step for the non-streamed path; the
    // assembled content is always added to history either way.
    if (response.content) {
      if (!streamed) {
        const textStep: StepResult = {
          type: "text",
          content: response.content,
          timestamp: now(),
        };
        steps.push(textStep);
        await hooks.onStep(textStep);
        if (onStep) onStep(textStep);
      }

      // Add assistant message with text content
      messages.push({
        id: generateId(),
        role: "assistant",
        content: response.content,
        timestamp: now(),
      });
    }

    // Tool calls
    if (response.tool_calls && response.tool_calls.length > 0) {
      const assistantToolCalls = response.tool_calls.map(providerToolCallToToolCall);
      allToolCalls.push(...assistantToolCalls);

      // Add assistant message with tool calls
      const assistantMsg: Message = {
        id: generateId(),
        role: "assistant",
        content: response.content ?? "",
        toolCalls: assistantToolCalls,
        timestamp: now(),
      };
      messages.push(assistantMsg);

      // Execute each tool call
      for (const tc of response.tool_calls) {
        if (signal?.aborted) {
          finishReason = "aborted";
          loopError = {
            message: "Operation was aborted during tool execution",
            code: "ABORTED",
            retryable: false,
          };
          break;
        }

        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(tc.arguments);
        } catch {
          parsedArgs = { raw: tc.arguments };
        }

        await hooks.beforeToolCall({ name: tc.name, args: parsedArgs });

        // Forward a tool's live progress (e.g. streaming shell stdout) to the
        // adapter as a tool_progress step. Emitted via onStep only — not pushed
        // to result.steps (chunks are transient presentation, not semantic).
        const onUpdate = (progress: { percentage?: number; message?: string }): void => {
          if (progress.message != null && onStep) {
            onStep({
              type: "tool_progress",
              toolCallId: tc.id,
              name: tc.name,
              args: parsedArgs,
              content: progress.message,
              timestamp: now(),
            });
          }
        };
        const execExtra = { onUpdate, signal };

        // Check for dynamically injected tools (from semantic middleware)
        const injectedTools = config?.injectedTools;
        const injectedModule = injectedTools instanceof Map ? injectedTools.get(tc.name) : undefined;

        const start = now();
        let output: string;
        let metadata: Record<string, unknown> | undefined;

        // Runs the tool (injected module or registry), normalizing both branches
        // into { output, metadata } and turning throws into an error output.
        // Shared by all three permission paths below so the try/catch lives once.
        const runToolSafely = async (): Promise<{ output: string; metadata?: Record<string, unknown> }> => {
          try {
            const result = injectedModule
              ? normalizeToolResult(await injectedModule.handler(parsedArgs, config))
              : await executeTool(tc.name, parsedArgs, config, execExtra);
            return { output: result.output, metadata: result.metadata };
          } catch (err) {
            return { output: `Error: ${err instanceof Error ? err.message : String(err)}` };
          }
        };

        // Permission pre-filter + adapter-level tool approval
        const effectiveLevel: PermissionLevel = permissionLevel ?? "moderate";

        if (autoConfirm) {
          // --headless mode: bypass permission matrix, auto-approve everything
          ({ output, metadata } = await runToolSafely());
        } else {
          const riskCategory: ToolRiskCategory = injectedModule?.risk
            ?? getToolRiskCategory(tc.name, getAllToolModules());
          const matrixDecision = checkToolPermission(effectiveLevel, riskCategory);

          if (matrixDecision === "auto") {
            ({ output, metadata } = await runToolSafely());
          } else if (approveTool) {
            // Grant check: a remembered approval skips the prompt entirely.
            if (grantStore && grantStore.consult(tc.name, parsedArgs)) {
              ({ output, metadata } = await runToolSafely());
            } else {
              // Build LLM-authored gate context from the tool's `approval` arg.
              const approvalContext = buildApprovalContext(parsedArgs);
              let raw: ApprovalDecision;
              try {
                raw = await approveTool({ name: tc.name, args: parsedArgs, approvalContext });
              } catch {
                raw = false;
              }
              const { approved, scope } = normalizeApproval(raw);
              if (!approved) {
                output = "User denied tool execution.";
              } else {
                // Persist a scoped grant (fire-and-forget; non-fatal on error).
                if (scope && scope !== "once") {
                  const pattern = extractPattern(tc.name, parsedArgs);
                  grantStore?.add(tc.name, scope, pattern).catch(() => { /* non-fatal */ });
                }
                ({ output, metadata } = await runToolSafely());
              }
            }
          } else {
            output = "Tool execution denied.";
          }
        }
        const duration = now() - start;

        // Note: tool output chars are NOT counted here because they will be
        // counted as promptChars on the next loop iteration when the message
        // history (including tool results) is sent to the provider.

        // Add tool result message
        messages.push({
          id: generateId(),
          role: "tool",
          content: output,
          toolCallId: tc.id,
          timestamp: now(),
        });

        // Record step
        const toolStep: StepResult = {
          type: "tool_call",
          toolCall: {
            id: tc.id,
            name: tc.name,
            args: parsedArgs,
            result: output,
            duration,
          },
          metadata,
          timestamp: now(),
        };
        steps.push(toolStep);
        await hooks.onStep(toolStep);
        await hooks.afterToolCall({ name: tc.name, output, duration });
        if (onStep) onStep(toolStep);
      }

      if (finishReason === "aborted") break;

      // Continue the loop to get the next response
      // Mark if this was the last allowed iteration
      if (step + 1 >= maxSteps) {
        hitMaxSteps = true;
      }
      continue;
    }

    // No tool calls — we're done
    finishReason = "stop";
    break;
    } finally {
      if (providerFactory) providerFactory.restore();
    }
  }

  // The loop ran all iterations with tool calls on the last one
  if (hitMaxSteps) {
    finishReason = "max_steps";
  }

  // Calculate usage — real API tokens when available, char÷4 fallback otherwise.
  const promptTokens = totalPromptTokens;
  const completionTokens = totalCompletionTokens;
  const pricing = getModelMeta(currentModel)?.pricing;
  const cost = pricing
    ? (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000
    : 0;
  const usage: Usage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cost,
  };

  return {
    messages,
    steps,
    toolCalls: allToolCalls,
    usage,
    contextTokens: lastContextTokens,
    finishReason,
    error: loopError,
  };
}
