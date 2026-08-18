/** Seepient Core — THE Agent Loop (single implementation) */

import { SeepientError } from "../foundations/errors.js";
import type { Message, StepResult, ToolCall, Usage, ApproveToolFn, ApprovalDecision, ApprovalScope, ApprovalContext, PermissionLevel, ToolRiskCategory } from "../foundations/types.js";
import type { ToolDefinition } from "../foundations/contracts/tool.js";
import { now, toSeepientError, messageToCanonicalMessage, providerToolCallToToolCall } from "./context/message-convert.js";
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
import type { ProviderRuntime, TurnSnapshot } from "./providers/provider-runtime.js";

// ProviderFactory for per-skill model switching
export interface ProviderFactory {
  resolve(skillName?: string): Promise<{ model?: string; providerAccount?: string }>;
  restore(): void;
}

export interface AgentLoopOptions {
  runtime: ProviderRuntime;
  model?: string;
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
  providerFactory?: ProviderFactory;
  turnSnapshot?: TurnSnapshot;
  modelOverride?: string;
  middleware?: Middleware[];
  approveTool?: ApproveToolFn;
  permissionLevel?: PermissionLevel;
  autoConfirm?: boolean;
  /** Persisted approval grants. When set, matching calls skip the prompt. */
  grantStore?: GrantStore;
  /**
   * Spec 008 wired action-lifecycle pipeline.
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

function classifyOutputSensitivity(toolName: string, args: Record<string, unknown>, output: string): string {
  if (toolName === "read_file" && typeof args.path === "string" && (args.path.includes(".env") || args.path.includes("id_rsa") || args.path.includes("secret"))) {
    return "secret";
  }
  return "normal";
}

/**
 * Run the agent loop with optional middleware wrapping.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    runtime,
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
    turnSnapshot,
  } = options;

  const config = {
    ...rawConfig,
    runtime,
  };

  // ── No middleware: run loop directly (backward compatible) ────────────
  if (!middleware || middleware.length === 0) {
    return executeLoop({ ...options, config });
  }

  // ── With middleware: wrap loop in pipeline ────────────────────────────
  const ctx: PipelineContext = {
    requestId: generateId(),
    messages,
    provider: runtime as any,
    model: model ?? "",
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
          agentName: (options.config?.agentName as string) ?? 'seepient',
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

    if (!ctx.result) {
      throw new SeepientError(
        "Middleware chain completed without producing a result",
        "MIDDLEWARE_ERROR",
        false,
      );
    }

    return {
      messages: ctx.result.messages,
      steps: ctx.result.steps,
      toolCalls: ctx.result.toolCalls,
      usage: ctx.result.usage,
      contextTokens: ctx.result.contextTokens,
      finishReason: ctx.result.finishReason as AgentLoopResult["finishReason"],
    };
  } catch (err) {
    const seepientErr = toSeepientError(err, "MIDDLEWARE_ERROR");
    await hooks.onError(seepientErr);
    return {
      messages,
      steps: [],
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      contextTokens: 0,
      finishReason: "error",
      error: {
        message: seepientErr.message,
        code: seepientErr.code,
        retryable: seepientErr.retryable,
      },
    };
  }
}

/**
 * Core loop execution — iterates turns, dispatches tool calls, checks permissions.
 */
async function executeLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    runtime,
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
  } = options;

  const approveTool = options.approveTool;
  const permissionLevel = options.permissionLevel;
  const autoConfirm = options.autoConfirm;
  const grantStore = options.grantStore;
  let currentModel = model ?? "";

  // Spec 008: Every tool call routes through the Domain policy pipeline.
  let wiredPipeline = options.wiredPipeline;
  if (!wiredPipeline) {
    const { InMemoryArtifactStore } = await import("../capabilities/execution/in-memory-artifact-store.js");
    const { buildActionLifecycle } = await import("./permissions/action-lifecycle-factory.js");
    const { buildLocalBoundary } = await import("../capabilities/execution/build-local-boundary.js");
    const { legacyApproveToolToBroker } = await import("../transport/legacy-adapter.js");
    const artifacts = new InMemoryArtifactStore();
    const hostCallbacks = new Map<string, (args: unknown) => Promise<unknown>>();
    const allModules = getAllToolModules();
    for (const mod of allModules) {
      hostCallbacks.set(mod.definition.function.name, (args) => mod.handler(args as any, config));
    }
    const { boundary } = await buildLocalBoundary({ artifacts, hostCallbacks, allowFallback: options.allowFallback ?? true });
    const broker = approveTool
      ? legacyApproveToolToBroker(approveTool)
      : autoConfirm
        ? {
            mode: "inline" as const,
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

    let modelProviderClass = "normal";
    try {
      const initialSnapshot = options.turnSnapshot ?? (await runtime.createTurnSnapshot());
      const initialPlan = await runtime.resolvePlan(
        initialSnapshot,
        "text",
        "standard",
        options.modelOverride ? { model: options.modelOverride } : undefined,
      );
      modelProviderClass = initialPlan.selectedTarget?.providerAccount || "normal";
    } catch {}

    wiredPipeline = await buildActionLifecycle({
      principalId: "agent-user",
      runId: generateId(),
      sessionId: (options.config?.sessionId as string) ?? "default-session",
      workspaceRoot: options.cwd ?? process.cwd(),
      modelProviderClass,
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
  let hitMaxSteps = false;

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let lastContextTokens = 0;

  for (let step = 0; step < maxSteps; step++) {
    try {
      if (signal?.aborted) {
        finishReason = "aborted";
        loopError = { message: "Operation was aborted", code: "ABORTED", retryable: false };
        break;
      }

      let stepOverride: any = options.modelOverride ? { model: options.modelOverride } : undefined;
      if (providerFactory) {
        try {
          const resolved = await providerFactory.resolve();
          if (resolved.model || resolved.providerAccount) {
            stepOverride = { model: resolved.model, providerAccount: resolved.providerAccount };
          }
        } catch (err) {
          finishReason = "error";
          loopError = { message: err instanceof Error ? err.message : String(err), code: "PROVIDER_ERROR", retryable: true, provider: currentModel };
          const seepientErr = toSeepientError(err, "PROVIDER_ERROR");
          await hooks.onError(seepientErr);
          break;
        }
      }

      const snapshot = options.turnSnapshot ?? (await runtime.createTurnSnapshot());
      let response: { content?: string; tool_calls?: any[]; usage?: Usage } = { content: "" };
      const acc = new StreamingResponseAccumulator();
      const canonicalMessages = messages.map(messageToCanonicalMessage);

      try {
        const plan = await runtime.resolvePlan(snapshot, "text", "standard", stepOverride);
        currentModel = plan.selectedTarget.model;

        for await (const event of runtime.executeLanguage(plan, { messages: canonicalMessages, tools: toolDefs as any }, { signal })) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            acc.appendText(event.delta.text);
            const deltaStep: StepResult = { type: "text_delta", content: event.delta.text, timestamp: now() };
            steps.push(deltaStep);
            await hooks.onStep(deltaStep);
            if (onStep) onStep(deltaStep);
          } else if (event.type === "content_block_start" && event.block?.type === "tool_use") {
            acc.beginToolCall(event.index, (event.block as any).id, (event.block as any).name);
          } else if (event.type === "content_block_delta" && event.delta.type === "tool_input_delta") {
            acc.appendToolCallArgs(event.index, event.delta.partialJson);
          } else if (event.type === "finish" && event.usage) {
            const inp = event.usage.inputTokens ?? event.usage.promptTokens ?? 0;
            const out = event.usage.outputTokens ?? event.usage.completionTokens ?? 0;
            acc.setUsage({ promptTokens: inp, completionTokens: out, totalTokens: inp + out, cost: 0 });
          } else if (event.type === "abort") {
            finishReason = "aborted";
            loopError = { message: "Operation was aborted", code: "ABORTED", retryable: false };
            break;
          } else if (event.type === "error") {
            throw new SeepientError(event.error.message, event.error.code, event.error.retryable);
          }
        }
        response = acc.toResponse();
      } catch (err) {
        const seepientErr = toSeepientError(err, "PROVIDER_ERROR");
        finishReason = "error";
        loopError = { message: seepientErr.message, code: "PROVIDER_ERROR", retryable: seepientErr.retryable, provider: currentModel };
        await hooks.onError(seepientErr);
        break;
      }

      if (finishReason === "aborted") break;

      const stepUsage = acc.getUsage();
      if (stepUsage && (stepUsage.promptTokens > 0 || stepUsage.completionTokens > 0)) {
        totalPromptTokens += stepUsage.promptTokens;
        totalCompletionTokens += stepUsage.completionTokens;
        lastContextTokens = stepUsage.promptTokens;
      } else {
        let stepPromptChars = 0;
        for (const msg of canonicalMessages) {
          if (typeof msg.content === "string") stepPromptChars += msg.content.length;
          else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if ("text" in block && typeof (block as any).text === "string") stepPromptChars += (block as any).text.length;
            }
          }
        }
        const estPrompt = Math.ceil(stepPromptChars / 4);
        const estCompletion = Math.ceil((response.content ?? "").length / 4);
        totalPromptTokens += estPrompt;
        totalCompletionTokens += estCompletion;
        lastContextTokens = estPrompt;
      }

      // Text content. Add assistant message if no tool calls.
      if (response.content) {
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
