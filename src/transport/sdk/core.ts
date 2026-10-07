/**
 * seepient-core — public entry point (spec 027).
 *
 * The chat/agent engine surface: `createSeepient` (incl. the `stateless`
 * option) with the `chatStream` instance method, the `askSeepient` one-shot,
 * the `createChat` multi-turn front door, trusted-host/custom tool
 * registration, the provider runtime, and the injectable store contracts —
 * importable with no reference to the full `seepient` package.
 *
 * Deliberately NOT here: `createProviderManagerApi`/`isOAuthSupported` (CLI
 * impl), `GatewaySettingsAdapter`, gateway construction, and the server/CLI/
 * TUI surfaces — those ship with the full package (contracts
 * core-package-surface.md §2).
 */
// ── Agent construction & chat ────────────────────────────────────────────────

export {
  createSeepient,
  createTenantAgent,
  validateSessionId,
  MAX_SESSION_ID_LENGTH,
  type CreateTenantAgentOptions,
} from "./seepient.js";
export { askSeepient } from "./ask.js";
export { createChat, type ChatSession, type ChatTurnResult } from "./chat.js";

// ── Streaming & errors ───────────────────────────────────────────────────────

export { surfaceLoopError, extractLoopError } from "./error-surfacing.js";
export {
  compose,
  type PipelineContext,
  type Middleware,
  loggingMiddleware,
  rateLimitMiddleware,
  authMiddleware,
} from "../../domain/index.js";
export type { AgentLoopError } from "../../domain/agent-loop.js";
export { ToolRegistry, getToolGroup, normalizeToolResult, ToolRegistrationError, resolveTools, tool, CORE_TOOLS, COMM_TOOLS, ADVANCED_TOOLS, ALL_TOOLS } from "./tools.js";

// ── Tools (light) ────────────────────────────────────────────────────────────

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
export {
  extractHostCallbacks,
  extractRegistrations,
  DEFAULT_TRUSTED_HOST_ALLOWLIST,
  type ToolRegistrationMap,
} from "./tools.js";
export type { ToolModule, ToolDefinition, ToolExecExtra, ToolRegistryContract } from "../../foundations/contracts/tool.js";

// ── Provider system ──────────────────────────────────────────────────────────

export {
  createAmbientProviderRuntime,
  createIsolatedProviderRuntime,
  ProviderRuntime,
} from "../../domain/providers/provider-runtime.js";
export { ProviderConfigStore } from "../../domain/providers/config-store/provider-config-store.js";
export { MemoryCredentialStore } from "../../domain/providers/credentials/memory-credential-store.js";
export { CompositeCredentialStore } from "../../domain/providers/credentials/composite-credential-store.js";
export type { ProviderRuntimeContract } from "../../foundations/contracts/provider-runtime.js";
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

// ── Injectable stores ────────────────────────────────────────────────────────

export {
  InMemoryAuditStore,
  InMemoryPolicyStore,
  InMemoryCapabilityLedger,
} from "../../domain/permissions/in-memory-stores.js";
export { InMemoryReplayLedger } from "../../capabilities/execution/in-memory-replay-ledger.js";
export { createPersistenceBackend, registerBackend } from "../../domain/sessions/session-store.js";
export type {
  AuditStore,
  PolicyStore,
  ActionAuditEvent,
  PolicySnapshot,
} from "../../foundations/contracts/execution-brokers.js";
export type { CapabilityLedger, RevokeFilter } from "../../foundations/contracts/capability-ledger.js";
export type {
  CapabilitySet,
  DecisionAuthority,
  ApprovalBroker,
  PermissionRequest,
  PermissionDecision,
} from "../../foundations/contracts/permission-policy.js";
export type { ConsentMode } from "../../foundations/settings-schema.js";
export type {
  ExecutionBoundary,
  ExecutionBackendCapabilities,
  ExecutionResult,
} from "../../foundations/contracts/execution-boundary.js";
export { FsSkillSources } from "../../capabilities/skills/fs-skill-sources.js";
export { initializeSkillRegistry } from "../../capabilities/skills/index.js";
export {
  saveGeneratedSkill,
  type SaveGeneratedSkillParams,
  type SaveGeneratedSkillResult,
} from "../../domain/skills/generated-skill-save.js";
export type {
  SkillRecord,
  SkillSource,
  SkillStore,
  SkillLiteral,
} from "../../foundations/contracts/skill-source.js";

// ── Tenancy ──────────────────────────────────────────────────────────────────

export {
  resolveTenancyMode,
  validateTenancyCompleteness,
  emitTenancyNoticeOnce,
  emitCredentialsSingleUserWarningOnce,
  TenancyRuntimeRequiredError,
  TenancyStoreIncompleteError,
  TenancyAmbientIoError,
  type TenancyMode,
  type TenancySignals,
  type TenancyResolution,
} from "../../domain/tenancy/tenancy-mode.js";

// ── Errors & types ───────────────────────────────────────────────────────────

export {
  SeepientError,
  GatewayError,
  InferenceError,
  ProviderError,
  ToolError,
  MaxStepsError,
  AbortedError,
  WidgetError,
  HashlineError,
  PermissionError,
  ApprovalBrokerError,
  AuditError,
  PolicyConflictError,
  WorkerSchedulerError,
  UnsupportedBackendError,
  ToolUnavailableError,
  SkillStoreUnavailableError,
  SkillCollisionError,
  SkillBodyUnavailableError,
  SkillBodyRequiredError,
  PersistConfigInvalidError,
  SessionIdInvalidError,
  PrincipalRequiredError,
  TenancyWorkspaceRequiredError,
  CredentialRequiredError,
  GlobalLifetimeForbiddenError,
  PathEscapesWorkspaceError,
  PathHardlinkRefusedError,
  PathIdentityMismatchError,
  type InferenceErrorCode,
  type InferenceErrorOptions,
} from "../../foundations/errors.js";
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
  AskSeepientOptions,
  AskSeepientResult,
  AskSeepientStreamResult,
  AgentResponse,
  SessionData,
  PersistenceBackend,
  PersistenceConfig,
  SkillMetadata,
  ToolRiskCategory,
  Purpose,
  Tier,
  Seepient,
  CreateSeepientOptions,
} from "../../foundations/types.js";
