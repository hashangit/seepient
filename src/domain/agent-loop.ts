/** Seepient Core — THE Agent Loop (single implementation) */

import { SeepientError } from "../foundations/errors.js";
import type { Message, StepResult, ToolCall, Usage, ApproveToolFn, ApprovalDecision, ApprovalScope, ApprovalContext, PermissionLevel, ToolRiskCategory } from "../foundations/types.js";
import type { LLMProvider, ProviderMessage, ProviderToolCall, ProviderResponse } from "../foundations/contracts/llm.js";
import type { ToolDefinition } from "../foundations/contracts/tool.js";
import { now, toSeepientError, messageToProviderMessage, messageToCanonicalMessage, providerToolCallToToolCall } from "./context/message-convert.js";
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
import type { WiredActionLifecycle } from "./permissions/action-lifecycle-factory.js";
import type { PermissionRequest } from "../foundations/contracts/permission-policy.js";
import { resolveAnalyzerWithFallback } from "./permissions/default-analyzers.js";

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
  cwd?: string;
  metadata?: Record<string, unknown>;
  onStep?: (step: StepResult) => void;
  /** Opt into token streaming (provider.chatStream). Off → always chat(). */
  stream?: boolean;
  providerFactory?: ProviderFactory;
  providerRuntime?: any;
  turnSnapshot?: any;
  modelOverride?: string;
  middleware?: Middleware[];
  approveTool?: ApproveToolFn;
  permissionLevel?: PermissionLevel;
  autoConfirm?: boolean;
  /** Persisted approval grants. When set, matching calls skip the prompt. */
  grantStore?: GrantStore;
  /**
   * Spec 008 wired action-lifecycle pipeline. When set, each tool call is
   * routed through the new Domain policy pipeline (PolicyEngine →
   * ApprovalBroker → ExecutionBoundary → audit) instead of the legacy
   * matrix/grant/admit branches. This is the opt-in feature flag.
   *
   * The pipeline is REACHABLE: when set, the tool-call loop delegates to it.
   * Tools with a registered analyzer run through the full pipeline; tools
   * without one fall back to the legacy handler but still pass through
   * policy/approval/audit via the legacy-handler executor.
   */
  wiredPipeline?: WiredActionLifecycle;
  /** Allow JS filesystem fallback for file commits when native helper is absent. */
  allowFallback?: boolean;
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
 * Spec 008 FR-010: classify tool output sensitivity for the model-egress gate.
 * Product behavior: when a tool reads a secret-class file (SSH keys, .env,
 * certificates, active policy), its output must not reach the AI provider.
 * Returns "secret" for known secret paths, "sensitive" for config paths,
 * "normal" otherwise. Only read_file produces variable sensitivity; other
 * tools produce normal output by default.
 */
function classifyOutputSensitivity(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): "normal" | "sensitive" | "secret" {
  const lower = output.toLowerCase();
  // 1. Content-based secret detection (defense in depth for all output).
  if (
    lower.includes("-----begin private key-----") ||
    lower.includes("-----begin rsa private key-----") ||
    /akia[0-9a-z]{16}/.test(lower) ||
    /sk-[a-z0-9]{20,}/.test(lower) ||
    /ghp_[a-z0-9]{30,}/.test(lower) ||
    /(api_key|secret_key|password|token|private_key)\s*[:=]\s*['"]?[a-z0-9+/=_-]{16,}/i.test(lower)
  ) {
    return "secret";
  }

  // 2. read_file origin classification.
  if (toolName === "read_file") {
    const p = String(args.path ?? "").toLowerCase();
    if (
      p.includes("/.ssh/") ||
      p.includes("/.aws/credentials") ||
      p.includes("/.env") ||
      p.endsWith(".pem") ||
      p.endsWith(".key") ||
      p.includes("/.seepient/security/")
    ) {
      return "secret";
    }
    if (p.includes("/.seepient/") || p.includes("/.config/")) {
      return "sensitive";
    }
    return "normal";
  }

  // 3. Known safe local tools.
  if (toolName === "get_current_datetime" || toolName === "manage_todos") {
    return "normal";
  }

  // 4. Process execution, web reads, screenshots, broker connectors, or unknown tools:
  //    Output is derived from external or process boundaries. Per FR-010 / D42,
  //    unknown-derived output MUST NOT default to "normal" — default to "sensitive".
  return "sensitive";
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
    config: rawConfig = {},
    metadata = {},
    onStep,
    providerFactory,
    middleware,
    providerRuntime,
    turnSnapshot,
  } = options;

  const config = {
    ...rawConfig,
    ...(providerRuntime ? { runtime: providerRuntime } : {}),
  };

  // ── No middleware: run loop directly (backward compatible) ────────────
  if (!middleware || middleware.length === 0) {
    return executeLoop({ ...options, config });
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
          ...config,
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
  // Track current provider (may change per step if providerFactory is used)
  let currentProvider = provider;
  let currentModel = model;

  // Spec 008: Every tool call routes through the Domain policy pipeline.
  // If no custom pipeline was passed, we build a local default pipeline.
  let wiredPipeline = options.wiredPipeline;
  if (!wiredPipeline) {
    const { InMemoryArtifactStore } = await import("../capabilities/execution/in-memory-artifact-store.js");
    const { buildActionLifecycle } = await import("./permissions/action-lifecycle-factory.js");
    const { buildLocalBoundary } = await import("../capabilities/execution/build-local-boundary.js");
    const { legacyApproveToolToBroker } = await import("../transport/legacy-adapter.js");
    const artifacts = new InMemoryArtifactStore();
    const hostCallbacks = new Map<string, (args: unknown) => Promise<unknown>>();
    const allModules = (await import("./tool-executor.js")).getAllToolModules();
    for (const mod of allModules) {
      hostCallbacks.set(mod.definition.function.name, (args) => mod.handler(args as any, config));
    }
    const { boundary } = await buildLocalBoundary({ artifacts, hostCallbacks, allowFallback: options.allowFallback ?? false });
    const broker = approveTool
      ? legacyApproveToolToBroker(approveTool)
      : autoConfirm
        ? {
            mode: "inline" as const,
            // Spec 011: auto-confirm binds to the request's narrowest option
            // and an offered lifetime; a request with no representable option
            // cannot be auto-approved.
            request: async (req: PermissionRequest) => {
              const option = req.approvalOptions[0];
              if (!option) {
                return {
                  approved: false as const,
                  requestId: req.requestId,
                  actionDigest: req.actionDigest,
                  actorId: "autoConfirm",
                  reason: "approval-unavailable: request has no representable option",
                  decidedAt: Date.now(),
                };
              }
              return {
                approved: true as const,
                requestId: req.requestId,
                actionDigest: req.actionDigest,
                optionId: option.optionId,
                lifetime: "action" as const,
                actorId: "autoConfirm",
                decidedAt: Date.now(),
              };
            },
          }
        : legacyApproveToolToBroker(undefined);
    wiredPipeline = await buildActionLifecycle({
      principalId: "agent-user",
      runId: generateId(),
      sessionId: (options.config?.sessionId as string) ?? "default-session",
      workspaceRoot: options.cwd ?? process.cwd(),
      modelProviderClass: (currentProvider as any)?.type ?? "normal",
      approvalBroker: broker,
      executionBoundary: boundary,
      artifacts,
    });
  }
  if (!wiredPipeline) {
    throw new SeepientError("Permission pipeline failed to initialize", "PIPELINE_NOT_INITIALIZED", false);
  }

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
    let response: ProviderResponse = { content: "" };
    let streamed = false;
    let acc: StreamingResponseAccumulator | undefined;
    let tookRuntimePath = false;
    try {
      if (options.providerRuntime) {
        const snapshot =
          options.turnSnapshot ?? (await options.providerRuntime.createTurnSnapshot());
        let stepOverride: any = options.modelOverride
          ? { model: options.modelOverride }
          : undefined;
        if (providerFactory) {
          try {
            const resolved = await providerFactory.resolve();
            if (resolved.model || (resolved as any).providerAccount) {
              stepOverride = {
                model: resolved.model,
                providerAccount: (resolved as any).providerAccount,
              };
            }
          } catch {}
        }
        const plan = await options.providerRuntime.resolvePlan(
          snapshot,
          "text",
          "standard",
          stepOverride,
        );
        currentModel = plan.selectedTarget.model;

        streamed = true;
        acc = new StreamingResponseAccumulator();
        const canonicalMessages = messages.map(messageToCanonicalMessage);

        for await (const event of options.providerRuntime.executeLanguage(
          plan,
          {
            messages: canonicalMessages,
            tools: toolDefs as any,
          },
          { signal },
        )) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            acc.appendText(event.delta.text);
            const deltaStep: StepResult = {
              type: "text_delta",
              content: event.delta.text,
              timestamp: now(),
            };
            steps.push(deltaStep);
            await hooks.onStep(deltaStep);
            if (onStep) onStep(deltaStep);
          } else if (
            event.type === "content_block_start" &&
            (event.block?.type === "tool_call" || event.block?.type === "tool_use")
          ) {
            acc.beginToolCall(event.index, (event.block as any).id, (event.block as any).name);
          } else if (event.type === "content_block_delta" && event.delta.type === "tool_input_delta") {
            acc.appendToolCallArgs(event.index, event.delta.partialJson);
          } else if (event.type === "finish" && event.usage) {
            const inp = event.usage.inputTokens ?? event.usage.promptTokens ?? 0;
            const out = event.usage.outputTokens ?? event.usage.completionTokens ?? 0;
            const tot = event.usage.totalTokens ?? inp + out;
            const costVal =
              typeof event.usage.cost === "object"
                ? (event.usage.cost as any)?.total ?? 0
                : typeof event.usage.cost === "number"
                  ? event.usage.cost
                  : 0;
            acc.setUsage({
              promptTokens: inp,
              completionTokens: out,
              totalTokens: tot,
              cost: costVal,
            });
          } else if (event.type === "abort") {
            finishReason = "aborted";
            break;
          } else if (event.type === "error") {
            throw new SeepientError(event.error.message, event.error.code, event.error.retryable);
          }
        }
        response = acc.toResponse();
        tookRuntimePath = true;
      }

      if (!tookRuntimePath) {
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
      }
    } catch (err) {
      const seepientErr = toSeepientError(err, "PROVIDER_ERROR");
      finishReason = "error";
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

      // Add assistant message with text content ONLY when no tool calls are present.
      // If tool calls exist, the assistant message added below already includes this content.
      if (!response.tool_calls || response.tool_calls.length === 0) {
        messages.push({
          id: generateId(),
          role: "assistant",
          content: response.content,
          timestamp: now(),
        });
      }
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

        // ── Spec 008 pipeline path ───────────────────────────────────────
        // When wiredPipeline is set, the legacy matrix/grant/autoConfirm
        // branches are BYPASSED. Every tool call is analyzed, evaluated by
        // PolicyEngine, optionally brokered through ApprovalBroker, executed
        // via the boundary, and audited. This is the path that closes the
        // confirmed defects (autoConfirm bypass, unsandboxed spawn, etc.).
        if (wiredPipeline) {
          // Every tool goes through the pipeline — dedicated analyzer or
          // generic fallback. No tool falls through to the legacy matrix.
          const analyzer = resolveAnalyzerWithFallback(wiredPipeline.analyzers, tc.name);
          if (analyzer) {
            // Build the prepared action via the registered analyzer.
            const action = await analyzer(parsedArgs, {
              ...wiredPipeline.analysisContext,
              toolCallId: tc.id,
            });
            // Run the full lifecycle. The boundary dispatches by
            // PreparedOperation.kind — commit-files → FileCommitBroker,
            // process → ProcessExecutor, etc. The prepared operation IS
            // the operation that executes (not the old tool handler).
            const result = await wiredPipeline.lifecycle.run(action, { signal, onUpdate: execExtra.onUpdate });
            output = result.toolResult.output;
            metadata = result.toolResult.metadata;
            // Spec 008 FR-010: Model-egress gate. Before tool output enters
            // model-visible history, the Domain enforces the gate centrally so
            // transport adapters cannot implement separate redaction policies.
            // The classification is built ONLY from trusted sources: the
            // action's declared `model-egress` effect classes (origin-derived,
            // set by the analyzer) PLUS the call-site classifier's verdict on
            // the actual output bytes — which can only ESCALATE (never
            // downgrade). A caller cannot inject or soften these classes.
            if (result.outcome.state !== "denied" && output.length > 0) {
              // Trusted origin classes from the prepared action's effects.
              const originDataClasses: string[] = [];
              for (const eff of action.effects) {
                if (eff.kind === "model-egress" && (eff as any).dataClasses) {
                  originDataClasses.push(...(eff as any).dataClasses);
                }
              }
              // Classifier verdict on real bytes — escalate-only. If the
              // output looks secret/sensitive (e.g. a key, .env contents) it is
              // forced into the origin set regardless of what the analyzer
              // declared, so a caller claiming "normal" cannot bypass the gate.
              const sensitivity = classifyOutputSensitivity(tc.name, parsedArgs, output);
              if (!originDataClasses.includes(sensitivity)) {
                originDataClasses.push(sensitivity);
              }
              const envelope = result.decision.decision === "allow" ? result.decision.envelope : undefined;
              if (envelope) {
                const { ModelEgressGate } = await import("./permissions/model-egress-gate-proxy.js");
                const gate = new ModelEgressGate();
                // The gate derives its decision SOLELY from provenance + envelope.
                // No caller-supplied classification is passed.
                const decision = await gate.authorize(
                  {
                    actionDigest: action.actionDigest,
                    providerClass: wiredPipeline.analysisContext.modelProviderClass,
                    originDataClasses: [...new Set(originDataClasses)],
                  },
                  envelope,
                );
                if (decision.decision === "deny") {
                  output = `[model-egress denied] ${("message" in decision ? decision.message : "sensitive data withheld from model")}`;
                }
              }
            }
            const duration = now() - start;
            messages.push({
              id: generateId(),
              role: "tool",
              content: output,
              toolCallId: tc.id,
              timestamp: now(),
            });
            const toolStep: StepResult = {
              type: "tool_call",
              toolCall: { id: tc.id, name: tc.name, args: parsedArgs, result: output, duration },
              metadata,
              timestamp: now(),
            };
            steps.push(toolStep);
            await hooks.onStep(toolStep);
            // afterToolCall fires ONLY when an actual dispatch happened
            // (outcome.state === succeeded/failed/cancelled — not denied).
            if (result.outcome.state !== "denied") {
              await hooks.afterToolCall({ name: tc.name, output, duration });
            }
            if (onStep) onStep(toolStep);
            continue; // skip the legacy branches entirely
          }
          // No truthful analyzer for this tool → FAIL CLOSED. The tool does
          // not run through the legacy handler; the model gets a structured
          // denial so it can adapt. This is the reviewer's design: "tools
          // without truthful effect analyzers must fail closed."
          output = `Tool "${tc.name}" is not supported under the permission pipeline (no analyzer registered). Use the legacy path (disable --permission-pipeline) or add an analyzer for this tool.`;
          const duration = now() - start;
          messages.push({
            id: generateId(),
            role: "tool",
            content: output,
            toolCallId: tc.id,
            timestamp: now(),
          });
          const failStep: StepResult = {
            type: "tool_call",
            toolCall: { id: tc.id, name: tc.name, args: parsedArgs, result: output, duration },
            timestamp: now(),
          };
          steps.push(failStep);
          await hooks.onStep(failStep);
          if (onStep) onStep(failStep);
          continue;
        }
      }

      if ((finishReason as string) === "aborted" || (finishReason as string) === "error") break;

      // Continue the loop to get the next response
      // Mark if this was the last allowed iteration
      if (step + 1 >= maxSteps) {
        hitMaxSteps = true;
      }
      continue;
    }

    // No tool calls — we're done
    if ((finishReason as string) !== "aborted" && (finishReason as string) !== "error") {
      finishReason = "stop";
    }
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
