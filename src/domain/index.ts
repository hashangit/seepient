/**
 * Seepient Core Module
 *
 * Central orchestrators and utilities for the Seepient unified architecture.
 */

export {
  invokeSkill,
  createRuntimeSkillProviderSwitcher,
  resolveSkillInvocationPlan,
  type SkillInvocationResult,
} from './skills/skill-invoker.js';
export { buildSkillCatalog } from './skills/skill-catalog.js';
export {
  runAgentLoop,
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentLoopError,
  type ProviderFactory,
} from './agent-loop.js';
export { createHookExecutor, type HookExecutor } from './hooks.js';
export { StreamManager } from './streaming/stream-manager.js';
export { createSessionStore, createMemoryStore, createPersistenceBackend, persistSession, registerBackend, FilePersistenceBackend, MemoryPersistenceBackend } from './sessions/session-store.js';
export type { BackendFactory } from './sessions/session-store.js';

// Export error classes (canonical definitions live in ./errors.ts)
export {
  SeepientError,
  ProviderError,
  ToolError,
  MaxStepsError,
  AbortedError,
} from '../foundations/errors.js';

// Export all types from types.ts
export type {
  // Messages
  Message,
  ToolCall,
  // Steps
  StepResult,
  // Usage
  Usage,
  CumulativeUsage,
  // Tools
  UserToolDefinition,
  ToolContext,
  ToolResult,
  // Hooks
  Hooks,
  // generateText
  GenerateTextOptions,
  GenerateTextResult,
  // streamText
  StreamTextOptions,
  StreamTextResult,
  // createAgent
  AgentCreateOptions,
  SdkAgent,
  AgentResponse,
  // Session
  SessionStore,
  SessionData,
  PersistenceBackend,
  PersistenceConfig,
  // Skills
  SkillMetadata,
  // Permissions
  PermissionLevel,
  ToolRiskCategory,
} from '../foundations/types.js';

// SeepientError is also re-exported as a value from types.ts, but the canonical
// class export comes from ./errors.js above. The `export type` block omits
// SeepientError intentionally to avoid a duplicate value export.

// Export message conversion helpers
export { generateId } from '../foundations/id.js';
export {
  now,
  estimateTokens,
  toSeepientError,
  messageToCanonicalMessage,
} from './context/message-convert.js';

// Export tool executor
export {
  CORE_TOOLS,
  COMM_TOOLS,
  ADVANCED_TOOLS,
  ALL_TOOLS,
  tool,
  resolveTools,
  getToolGroup,
  registerTool,
  executeTool,
  getAllToolDefinitions,
} from './tool-executor.js';

// Export permission system
export {
  checkToolPermission,
  getToolRiskCategory,
  resolvePermissionLevel,
} from './permission.js';

// Export middleware pipeline
export {
  compose,
  type PipelineContext,
  type Middleware,
} from '../foundations/contracts/middleware.js';
export { loggingMiddleware, type LoggingOptions } from './middleware/logging.js';
export { rateLimitMiddleware, type RateLimitOptions } from './middleware/rate-limit.js';
export { authMiddleware, type AuthOptions } from './middleware/auth.js';
