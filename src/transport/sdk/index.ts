/**
 * Seepient SDK — Public entry point
 *
 * Exports `generateText`, `streamText`, `createAgent`, and all public types,
 * tool factories, provider helpers, and skill utilities.
 */

import type {
  GenerateTextOptions,
  GenerateTextResult,
  StreamTextOptions,
  StreamTextResult,
  Message,
  StepResult,
  ToolCall,
  Usage,
  SeepientError,
} from "../../foundations/types.js";
import { getDefaultProviderRuntime, type ProviderRuntime } from "../../domain/providers/provider-runtime.js";
import { createHookExecutor } from "../../domain/hooks.js";
import { StreamManager } from "../../domain/streaming/stream-manager.js";
import { resolveTools, getAllToolDefinitions } from "./tools.js";
import { runAgentLoop } from "../../domain/agent-loop.js";
import { createSessionGrantStore } from "../../domain/grants.js";
import { initializeSkillRegistry } from "../../capabilities/skills/index.js";
import { buildSkillCatalog } from "../../domain/skills/skill-catalog.js";
import {
  now,
  toSeepientError,
} from "../../domain/context/message-convert.js";
import { generateId } from "../../foundations/id.js";
import type { Middleware } from "../../foundations/contracts/middleware.js";
import { homedir } from 'os';
import * as path from 'path';

// ── Re-exports ───────────────────────────────────────────────────────────

export { createAgent } from "./agent.js";
export { createSeepient } from "./seepient.js";
export type {
  Seepient,
  CreateSeepientOptions,
  AgentOptions as SeepientAgentOptions,
  GenerateTextOptions as SeepientGenerateTextOptions,
  GenerateImageOptions as SeepientGenerateImageOptions,
  ResolveOptions as SeepientResolveOptions,
} from "../../foundations/contracts/sdk-fixture.js";
export { tool, CORE_TOOLS, COMM_TOOLS, ADVANCED_TOOLS, ALL_TOOLS } from "./tools.js";
export { settings, SettingsError } from "./settings.js";
export { createRuntimeSkillProviderSwitcher } from "../../domain/skills/skill-invoker.js";
export type { SSEOptions } from "./http.js";

// Re-export middleware pipeline
export {
  compose,
  type PipelineContext,
  type Middleware,
  loggingMiddleware,
  rateLimitMiddleware,
  authMiddleware,
} from "../../domain/index.js";

import type { GatewayConfig } from "../../capabilities/gateway/types.js";
import type { GatewaySettingsAdapter } from "../../capabilities/gateway/settings-adapter.js";

// Gateway (lazy — only loaded when used)
export const gateway = {
  async createGateway(config: GatewayConfig, settingsAdapter?: GatewaySettingsAdapter) {
    const { createGateway } = await import('../../capabilities/gateway/index.js');
    const { GatewaySettingsAdapter: Adapter } = await import('../../capabilities/gateway/settings-adapter.js');
    const adapter = settingsAdapter ?? new Adapter(
      process.env.SEEPIENT_GATEWAY_DIR ?? path.join(homedir(), '.seepient')
    );
    if (!settingsAdapter) await adapter.initialize();
    const { registerTool } = await import('../../domain/tool-executor.js');
    return createGateway(config, adapter, undefined, (tools) => tools.forEach(registerTool));
  },
};

// Re-export all types
export type {
  ProviderType,
  MultiProviderConfig,
  Message,
  ToolCall,
  StepResult,
  Usage,
  CumulativeUsage,
  UserToolDefinition,
  ToolContext,
  ToolResult,
  Hooks,
  GenerateTextOptions,
  GenerateTextResult,
  StreamTextOptions,
  StreamTextResult,
  AgentCreateOptions,
  SdkAgent,
  AgentResponse,
  SessionStore,
  SessionData,
  PersistenceBackend,
  PersistenceConfig,
  SkillMetadata,
  SeepientError,
  PermissionLevel,
  ToolRiskCategory,
} from "../../foundations/types.js";

export {
  createPersistenceBackend,
  registerBackend,
  createSessionStore,
  createMemoryStore,
} from "../../domain/sessions/session-store.js";



// ── generateText ─────────────────────────────────────────────────────────

/**
 * Resolve the skill catalog for a one-shot SDK call. Returns the system prompt
 * with the catalog appended, or the prompt unchanged when skills are disabled
 * or none are found. Best-effort: discovery failures are swallowed.
 */
async function resolveSkillCatalog(
  systemPrompt: string | undefined,
  skills: string[] | boolean | undefined,
  cwd?: string,
): Promise<string | undefined> {
  if (skills === false) return systemPrompt;
  try {
    const registry = await initializeSkillRegistry(cwd ?? process.cwd());
    let metadata = registry.getMetadata();
    if (Array.isArray(skills)) {
      const wanted = new Set(skills);
      metadata = metadata.filter(s => wanted.has(s.name));
    }
    if (metadata.length === 0) return systemPrompt;
    const catalog = buildSkillCatalog(metadata);
    return systemPrompt ? systemPrompt + '\n\n' + catalog : catalog;
  } catch {
    return systemPrompt;
  }
}

/**
 * Run a one-shot agent loop and return the structured result.
 *
 * Creates fresh state for each call (stateless). Handles tool calls
 * automatically until the provider returns no more tool calls or
 * `maxSteps` is reached.
 *
 * @example
 * ```ts
 * const result = await generateText("What is the weather in SF?", {
 *   tools: ["web_search"],
 *   maxSteps: 5,
 * });
 * console.log(result.text);
 * ```
 */
export async function generateText(
  prompt: string,
  options?: GenerateTextOptions,
): Promise<GenerateTextResult> {
  const opts = options ?? {};
  const maxSteps = opts.maxSteps ?? 10;
  const runtime: ProviderRuntime = (opts as any).runtime ?? (opts as any).providerRuntime ?? getDefaultProviderRuntime();

  // Resolve tools
  const toolDefs = opts.tools ? resolveTools(opts.tools) : getAllToolDefinitions();

  // Hooks
  const hooks = createHookExecutor(opts.hooks);

  // Resolve skill catalog and append to the system prompt
  const systemPrompt = await resolveSkillCatalog(opts.systemPrompt, opts.skills, opts.cwd);

  // Build message list
  const messages: Message[] = [];
  messages.push({
    id: generateId(),
    role: "user" as const,
    content: prompt,
    timestamp: now(),
  });

  // Spec 008 opt-in: construct the wired pipeline for this call when
  // permissionPipeline is set. (createAgent does this once; generateText and
  // streamText build it per-call since they're stateless.)
  let wiredPipeline: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle | undefined;
  if (opts.permissionPipeline) {
    const { buildActionLifecycle } = await import("../../domain/permissions/action-lifecycle-factory.js");
    const { legacyApproveToolToBroker } = await import("../legacy-adapter.js");
    const { buildLocalBoundary } = await import("../../capabilities/execution/build-local-boundary.js");
    const { boundary, artifacts: sharedArtifacts } = await buildLocalBoundary();
    wiredPipeline = await buildActionLifecycle({
      principalId: "sdk-user",
      runId: generateId(),
      workspaceRoot: opts.cwd ?? process.cwd(),
      modelProviderClass: (opts.provider ?? "openai") as string,
      approvalBroker: legacyApproveToolToBroker(opts.approveTool),
      executionBoundary: boundary,
      artifacts: sharedArtifacts,
    });
  }

  const snapshot = await runtime.createTurnSnapshot();

  const result = await runAgentLoop({
    runtime,
    turnSnapshot: snapshot,
    model: opts.model,
    modelOverride: opts.model,
    messages,
    toolDefs,
    systemPrompt,
    maxSteps,
    hooks,
    signal: opts.signal,
    config: { ...opts.config, runtime },
    metadata: opts.metadata,
    middleware: opts.middleware,
    approveTool: opts.approveTool,
    permissionLevel: opts.permissionLevel,
    grantStore: opts.grants?.length ? createSessionGrantStore(opts.grants) : undefined,
    wiredPipeline,
  });

  // Get the final text
  const lastAssistant = [...result.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  const text = lastAssistant?.content ?? "";

  const genResult: GenerateTextResult = {
    text,
    steps: result.steps,
    toolCalls: result.toolCalls,
    usage: result.usage,
    finishReason: result.finishReason as GenerateTextResult["finishReason"],
    messages: result.messages,
  };

  await hooks.onFinish(genResult);
  return genResult;
}

// ── streamText ───────────────────────────────────────────────────────────

/**
 * Run a one-shot agent loop with streaming callbacks.
 *
 * Returns AsyncIterables for text and steps, plus `toResponse()` and
 * `toSSEStream()` for HTTP server integration.
 *
 * Note: The current provider.chat() API returns full responses (not deltas),
 * so onText receives the complete text at once. Future versions will integrate
 * with provider-level streaming.
 *
 * @example
 * ```ts
 * const stream = await streamText("Explain quantum computing", {
 *   onText: (delta) => process.stdout.write(delta),
 * });
 * const finalText = await stream.fullText;
 * ```
 */
export async function streamText(
  prompt: string,
  options?: StreamTextOptions,
): Promise<StreamTextResult> {
  const opts = options ?? {};
  const maxSteps = opts.maxSteps ?? 10;
  const runtime: ProviderRuntime = (opts as any).providerRuntime ?? getDefaultProviderRuntime();

  // Resolve tools
  const toolDefs = opts.tools ? resolveTools(opts.tools) : getAllToolDefinitions();

  // Hooks — merge stream-level callbacks with any base hooks
  const mergedHooks = { ...opts.hooks };
  const hooks = createHookExecutor(mergedHooks);

  // Resolve skill catalog and append to the system prompt
  const systemPrompt = await resolveSkillCatalog(opts.systemPrompt, opts.skills, opts.cwd);

  // Build message list
  const messages: Message[] = [];
  messages.push({
    id: generateId(),
    role: "user",
    content: prompt,
    timestamp: now(),
  });

  // Abort controller
  const abortController = new AbortController();

  // Stream manager handles queues, async iterables, and SSE
  const stream = new StreamManager();

  // Spec 008 opt-in: build the wired pipeline for this stream call.
  let wiredPipeline: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle | undefined;
  if (opts.permissionPipeline) {
    const { buildActionLifecycle } = await import("../../domain/permissions/action-lifecycle-factory.js");
    const { legacyApproveToolToBroker } = await import("../legacy-adapter.js");
    const { buildLocalBoundary } = await import("../../capabilities/execution/build-local-boundary.js");
    const { boundary, artifacts: sharedArtifacts } = await buildLocalBoundary();
    wiredPipeline = await buildActionLifecycle({
      principalId: "sdk-user",
      runId: generateId(),
      workspaceRoot: opts.cwd ?? process.cwd(),
      modelProviderClass: (opts.provider ?? "openai") as string,
      approvalBroker: legacyApproveToolToBroker(opts.approveTool),
      executionBoundary: boundary,
      artifacts: sharedArtifacts,
    });
  }

  // Run loop in background
  (async () => {
    try {
      const snapshot = await runtime.createTurnSnapshot();

      const result = await runAgentLoop({
        runtime,
        turnSnapshot: snapshot,
        model: opts.model,
        modelOverride: opts.model,
        messages,
        toolDefs,
        systemPrompt,
        maxSteps,
        hooks,
        signal: abortController.signal,
        config: { ...opts.config, runtime },
        metadata: opts.metadata,
        middleware: opts.middleware,
        approveTool: opts.approveTool,
        permissionLevel: opts.permissionLevel,
        grantStore: opts.grants?.length ? createSessionGrantStore(opts.grants) : undefined,
        wiredPipeline,
        onStep: (step) => {
          if (opts.onStep) opts.onStep(step);
          if (step.type === "text" && step.content) {
            if (opts.onText) opts.onText(step.content);
            stream.enqueueText(step.content);
          }
          if (step.type === "tool_call" && step.toolCall) {
            if (opts.onToolCall) {
              opts.onToolCall({ name: step.toolCall.name, args: step.toolCall.args, callId: step.toolCall.id });
            }
            if (opts.onToolResult) {
              opts.onToolResult({ callId: step.toolCall.id, output: step.toolCall.result, success: true });
            }
          }
          stream.enqueueStep(step);
        },
      });

      // fullText: join all text deltas that were enqueued
      const allText = result.steps
        .filter((s) => s.type === "text")
        .map((s) => s.content ?? "")
        .join("");

      stream.resolveText(allText);
      stream.resolveUsage(result.usage);
      stream.resolveFinish(result.finishReason);
    } catch (err) {
      const seepientErr = toSeepientError(err, "PROVIDER_ERROR");
      if (opts.onError) opts.onError(seepientErr);
      stream.resolveText("");
      stream.resolveUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });
      stream.resolveFinish("error");
    } finally {
      stream.complete();
    }
  })();

  return {
    textStream: stream.textStream,
    steps: stream.stepsStream,
    fullText: stream.fullText,
    usage: stream.usage,
    finishReason: stream.finishReason,
    abort: () => abortController.abort(),
    toResponse: () => stream.toResponse(),
    toSSEStream: () => stream.toSSEStream(),
  };
}
