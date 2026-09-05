/**
 * Seepient SDK — Public entry point
 *
 * Exports `generateText`, `streamText`, `createSeepient`, and all public types,
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
import { resolveTools, getAllToolDefinitions, extractHostCallbacks, extractRegistrations, DEFAULT_TRUSTED_HOST_ALLOWLIST } from "./tools.js";
import { runAgentLoop } from "../../domain/agent-loop.js";
import { initializeSkillRegistry } from "../../capabilities/skills/index.js";
import { buildSkillCatalog } from "../../domain/skills/skill-catalog.js";
import {
  now,
  toSeepientError,
} from "../../domain/context/message-convert.js";
import { generateId } from "../../foundations/id.js";
import { surfaceLoopError, extractLoopError } from "./error-surfacing.js";
import type { Middleware } from "../../foundations/contracts/middleware.js";
import { homedir } from 'os';
import * as path from 'path';

// ── Re-exports ───────────────────────────────────────────────────────────

export { createSeepient, warnIfPartialStoreInjection } from "./seepient.js";
import { warnIfPartialStoreInjection } from "./seepient.js";
export type {
  Seepient,
  CreateSeepientOptions,
} from "../../foundations/types.js";
export type { CredentialStore } from "../../foundations/contracts/credential-store.js";
export type {
  AccountInput,
  SaveResult,
  DeleteResult,
  AssignmentTarget,
  UiError,
  ManagerState,
  ProviderManagerApi,
  ResolutionPreview,
  ProbeResult,
} from "../../foundations/contracts/provider-manager-api.js";
export { createProviderManagerApi, isOAuthSupported, getCanonicalOAuthFlowId } from "../cli/provider-manager-api.js";
export { tool, CORE_TOOLS, COMM_TOOLS, ADVANCED_TOOLS, ALL_TOOLS } from "./tools.js";
export {
  preparedTool,
  brokerConnector,
  trustedHostTool,
  type AnyToolRegistration,
  type TrustedHostToolRegistration,
  type PreparedToolRegistration,
  type BrokerConnectorRegistration,
  type LegacyHostToolRegistration,
  type HostToolContext,
} from "./custom-tools.js";
export { settings, SettingsError } from "./settings.js";
export { createRuntimeSkillProviderSwitcher } from "../../domain/skills/skill-invoker.js";
export { getDefaultProviderRuntime, ProviderRuntime } from "../../domain/providers/provider-runtime.js";
export { ProviderConfigStore } from "../../domain/providers/config-store/provider-config-store.js";
export { MemoryCredentialStore } from "../../domain/providers/credentials/memory-credential-store.js";
export type { AuditStore, PolicyStore, ActionAuditEvent, PolicySnapshot } from "../../foundations/contracts/execution-brokers.js";
export type { CapabilityLedger, RevokeFilter } from "../../foundations/contracts/capability-ledger.js";
export type { CapabilitySet, DecisionAuthority, ApprovalBroker, PermissionRequest, PermissionDecision } from "../../foundations/contracts/permission-policy.js";
export type { ProviderRuntimeContract } from "../../foundations/contracts/provider-runtime.js";
export type { SkillRegistryContract } from "../../foundations/contracts/skill-registry.js";
export type { ConsentMode } from "../../foundations/settings-schema.js";
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
  AgentResponse,
  SessionStore,
  SessionData,
  PersistenceBackend,
  PersistenceConfig,
  SkillMetadata,
  SeepientError,
  ToolRiskCategory,
} from "../../foundations/types.js";

function toCapabilitySet(cap: import("../../foundations/contracts/permission-policy.js").CapabilitySet | import("../../foundations/contracts/permission-policy.js").Capability[] | undefined): import("../../foundations/contracts/permission-policy.js").CapabilitySet | undefined {
  if (!cap) return undefined;
  if (Array.isArray(cap)) {
    return { version: 1, capabilities: cap };
  }
  return cap;
}

export {
  createPersistenceBackend,
  registerBackend,
  createSessionStore,
  createMemoryStore,
} from "../../domain/sessions/session-store.js";



// ── generateText ─────────────────────────────────────────────────────────

/**
 * Resolve the skill catalog for a one-shot SDK call. Returns the system prompt
 * with the catalog appended and the held SkillRegistry instance, or the prompt
 * unchanged when skills are disabled or none are found. Best-effort: discovery
 * failures are swallowed.
 */
async function resolveSkills(
  systemPrompt: string | undefined,
  skills: string[] | boolean | undefined,
  cwd?: string,
): Promise<{ systemPrompt: string | undefined; skillRegistry?: import("../../capabilities/skills/types.js").SkillRegistry }> {
  if (skills === false) return { systemPrompt };
  try {
    const skillRegistry = await initializeSkillRegistry(cwd ?? process.cwd());
    let metadata = skillRegistry.getMetadata();
    if (Array.isArray(skills)) {
      const wanted = new Set(skills);
      metadata = metadata.filter(s => wanted.has(s.name));
    }
    if (metadata.length === 0) return { systemPrompt, skillRegistry };
    const catalog = buildSkillCatalog(metadata);
    return {
      systemPrompt: systemPrompt ? systemPrompt + '\n\n' + catalog : catalog,
      skillRegistry,
    };
  } catch {
    return { systemPrompt };
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
  const runtime = opts.runtime ?? getDefaultProviderRuntime();

  // Resolve skill catalog and append to the system prompt
  const { systemPrompt, skillRegistry } = await resolveSkills(opts.systemPrompt, opts.skills, opts.cwd);

  // Resolve tools
  const toolDefs = opts.tools ? resolveTools(opts.tools) : getAllToolDefinitions();
  // spec 019 FR-006: explicit trustedHostTool registrations wire into the
  // boundary's host-callback map and join the operator allowlist.
  const { callbacks: hostCallbacks, registrationIds } = extractHostCallbacks(opts.tools, { skills: skillRegistry });
  // spec 020 FR-001: custom preparedTool and brokerConnector registrations
  const registrations = extractRegistrations(opts.tools);

  // Hooks
  const hooks = createHookExecutor(opts.hooks);

  // Build message list
  const messages: Message[] = [];
  messages.push({
    id: generateId(),
    role: "user" as const,
    content: prompt,
    timestamp: now(),
  });

  const { buildActionLifecycle } = await import("../../domain/permissions/action-lifecycle-factory.js");
  const { legacyApproveToolToBroker } = await import("../legacy-adapter.js");
  const { buildLocalBoundary } = await import("../../capabilities/execution/build-local-boundary.js");
  const { createSnapshotStore } = await import("../../foundations/hashline/snapshot-store.js");
  const { InMemoryArtifactStore } = await import("../../capabilities/execution/in-memory-artifact-store.js");
  const { createMediaVendorOperationHandler } = await import("../../domain/media/vendor-operation-handler.js");
  const snapshotStore = createSnapshotStore();
  const sharedArtifacts = new InMemoryArtifactStore();
  const vendorOperationHandler = createMediaVendorOperationHandler({
    runtime,
    artifacts: sharedArtifacts,
    signal: (opts as any).signal,
  });
  const { boundary } = await buildLocalBoundary({
    artifacts: sharedArtifacts,
    workspaceRoot: opts.cwd ?? process.cwd(),
    snapshotStore,
    hostCallbacks,
    vendorOperationHandler,
    commitHelper: opts.commitHelper,
    network: opts.network,
  });
  const approvalMode = opts.consentMode
    ? (opts.consentMode === 'autonomous' ? 'autonomous' : opts.consentMode === 'ask-everything' ? 'manual' : 'balanced')
    : (opts.approvalBroker || opts.approveTool ? "manual" : "never");

  warnIfPartialStoreInjection(opts);

  const wiredPipeline = await buildActionLifecycle({
    principalId: opts.principalId ?? "sdk-user",
    runId: generateId(),
    workspaceRoot: opts.cwd ?? process.cwd(),
    modelProviderClass: (opts.provider ?? "openai") as string,
    approvalBroker: opts.approvalBroker ?? legacyApproveToolToBroker(opts.approveTool),
    executionBoundary: boundary,
    approvalMode,
    deploymentCeiling: toCapabilitySet(opts.deploymentCeiling),
    principalPolicy: toCapabilitySet(opts.principalPolicy),
    artifacts: sharedArtifacts,
    snapshotStore,
    trustedHostAllowlist: [...DEFAULT_TRUSTED_HOST_ALLOWLIST, ...registrationIds],
    registrations,
    auditStore: opts.auditStore,
    policyStore: opts.policyStore,
    capabilityLedger: opts.capabilityLedger,
  });

  const snapshot = await runtime.createTurnSnapshot();

  const result = await runAgentLoop({
    runtime,
    turnSnapshot: snapshot,
    model: opts.model,
    modelOverride: opts.providerAccount || opts.model
      ? { providerAccount: opts.providerAccount, model: opts.model }
      : undefined,
    messages,
    toolDefs,
    systemPrompt,
    maxSteps,
    hooks,
    signal: opts.signal,
    config: { ...opts.config, runtime, skills: skillRegistry },
    metadata: opts.metadata,
    middleware: opts.middleware,
    approveTool: opts.approveTool,
    wiredPipeline,
  });

  surfaceLoopError(result);

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
 */
export async function streamText(
  prompt: string,
  options?: StreamTextOptions,
): Promise<StreamTextResult> {
  const opts = options ?? {};
  const maxSteps = opts.maxSteps ?? 10;
  const runtime = opts.runtime ?? getDefaultProviderRuntime();

  // Resolve skill catalog and append to the system prompt
  const { systemPrompt, skillRegistry } = await resolveSkills(opts.systemPrompt, opts.skills, opts.cwd);

  // Resolve tools
  const toolDefs = opts.tools ? resolveTools(opts.tools) : getAllToolDefinitions();
  // spec 019 FR-006: explicit trustedHostTool registrations wire into the
  // boundary's host-callback map and join the operator allowlist.
  const { callbacks: hostCallbacks, registrationIds } = extractHostCallbacks(opts.tools, { skills: skillRegistry });
  // spec 020 FR-001: custom preparedTool and brokerConnector registrations
  const registrations = extractRegistrations(opts.tools);

  // Hooks — merge stream-level callbacks with any base hooks
  const mergedHooks = { ...opts.hooks };
  const hooks = createHookExecutor(mergedHooks);

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
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortController.abort(opts.signal.reason);
    } else {
      opts.signal.addEventListener("abort", () => abortController.abort(opts.signal?.reason), { once: true });
    }
  }

  // Stream manager handles queues, async iterables, and SSE
  const stream = new StreamManager();

  const { buildActionLifecycle } = await import("../../domain/permissions/action-lifecycle-factory.js");
  const { legacyApproveToolToBroker } = await import("../legacy-adapter.js");
  const { buildLocalBoundary } = await import("../../capabilities/execution/build-local-boundary.js");
  const { createSnapshotStore } = await import("../../foundations/hashline/snapshot-store.js");
  const { InMemoryArtifactStore } = await import("../../capabilities/execution/in-memory-artifact-store.js");
  const { createMediaVendorOperationHandler } = await import("../../domain/media/vendor-operation-handler.js");
  const snapshotStore = createSnapshotStore();
  const sharedArtifacts = new InMemoryArtifactStore();
  const vendorOperationHandler = createMediaVendorOperationHandler({
    runtime,
    artifacts: sharedArtifacts,
    signal: abortController.signal,
  });
  const { boundary } = await buildLocalBoundary({
    artifacts: sharedArtifacts,
    workspaceRoot: opts.cwd ?? process.cwd(),
    snapshotStore,
    hostCallbacks,
    vendorOperationHandler,
    commitHelper: opts.commitHelper,
    network: opts.network,
  });
  const approvalMode = opts.consentMode
    ? (opts.consentMode === 'autonomous' ? 'autonomous' : opts.consentMode === 'ask-everything' ? 'manual' : 'balanced')
    : (opts.approvalBroker || opts.approveTool ? "manual" : "never");

  warnIfPartialStoreInjection(opts);

  const wiredPipeline = await buildActionLifecycle({
    principalId: opts.principalId ?? "sdk-user",
    runId: generateId(),
    workspaceRoot: opts.cwd ?? process.cwd(),
    modelProviderClass: (opts.provider ?? "openai") as string,
    approvalBroker: opts.approvalBroker ?? legacyApproveToolToBroker(opts.approveTool),
    executionBoundary: boundary,
    approvalMode,
    deploymentCeiling: toCapabilitySet(opts.deploymentCeiling),
    principalPolicy: toCapabilitySet(opts.principalPolicy),
    artifacts: sharedArtifacts,
    snapshotStore,
    trustedHostAllowlist: [...DEFAULT_TRUSTED_HOST_ALLOWLIST, ...registrationIds],
    registrations,
    auditStore: opts.auditStore,
    policyStore: opts.policyStore,
    capabilityLedger: opts.capabilityLedger,
  });

  // Run loop in background
  (async () => {
    try {
      const snapshot = await runtime.createTurnSnapshot();

      const result = await runAgentLoop({
        runtime,
        turnSnapshot: snapshot,
        model: opts.model,
        modelOverride: opts.providerAccount || opts.model
          ? { providerAccount: opts.providerAccount, model: opts.model }
          : undefined,
        messages,
        toolDefs,
        systemPrompt,
        maxSteps,
        hooks,
        signal: abortController.signal,
        config: { ...opts.config, runtime, skills: skillRegistry },
        metadata: opts.metadata,
        middleware: opts.middleware,
        approveTool: opts.approveTool,
        wiredPipeline,
        onStep: (step) => {
          if (opts.onStep) opts.onStep(step);
          if ((step.type === "text_delta" || step.type === "text") && step.content) {
            if (opts.onText) opts.onText(step.content);
            stream.enqueueText(step.content);
          }
          if (step.type === "tool_call" && step.toolCall) {
            if (opts.onToolCall) {
              opts.onToolCall({ name: step.toolCall.name, args: step.toolCall.args, callId: step.toolCall.id });
            }
            if (opts.onToolResult) {
              const output = step.toolCall.result;
              const success = typeof output === "string" ? !output.startsWith("Error:") : true;
              opts.onToolResult({ callId: step.toolCall.id, output, success });
            }
          }
          stream.enqueueStep(step);
        },
      });

      // fullText: join all text deltas that were enqueued or last assistant content
      const lastAssistant = [...result.messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.content);
      const textFromSteps = result.steps
        .filter((s) => s.type === "text_delta" || s.type === "text")
        .map((s) => s.content ?? "")
        .join("");
      const allText = textFromSteps || (lastAssistant?.content ?? "");

      stream.resolveText(allText);
      stream.resolveUsage(result.usage);
      const loopErr = extractLoopError(result);
      if (loopErr) {
        if (opts.onError) opts.onError(loopErr);
        stream.resolveFinish("error");
      } else {
        stream.resolveFinish(result.finishReason);
      }
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
