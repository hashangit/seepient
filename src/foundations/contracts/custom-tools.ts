/**
 * Public custom-tool registration contracts — Foundations (spec 008, FR-012).
 *
 * Custom operations are policy-governed only when they are serializable and
 * supported by an execution backend or typed broker. Arbitrary JavaScript
 * callbacks are application code with ambient host authority and require the
 * explicit `trustedHostTool({ trust: "host" })` API. The legacy
 * `tool({ execute })` factory emits a deprecation warning and fails closed
 * until the developer selects a trust model.
 *
 * Foundations imports no Seepient layer.
 */

import type { ToolDefinition } from "./tool.js";
import type {
  PreparedToolAction,
  PreparedOperation,
} from "./prepared-action.js";
import type { JsonValue } from "./tool-effects.js";
import type { ToolResult } from "../types.js";

/** Context passed to an analyzer. Pure except for read-only snapshot/probe. */
export interface ToolAnalysisContext {
  principalId: string;
  runId: string;
  toolCallId: string;
  workspace: WorkspaceSnapshot;
  artifacts: import("./execution-brokers.js").PreparationArtifactStore;
  modelProviderClass: string;
}

export interface WorkspaceSnapshot {
  workspaceId: string;
  canonicalRoot: string;
  policyVersion: number;
  policyDigest: string;
}

/** V1 supported generic operation kinds a prepared analyzer may emit. */
export type AllowedOperationKind = PreparedOperation["kind"];

/**
 * Application-trusted analyzer registration. `trust: "analyzer"` is
 * intentional: application JavaScript can perform ambient side effects
 * before returning, so it joins the application TCB even though the returned
 * operation is policy-governed. Emitted kinds are restricted to the declared
 * `allowedOperationKinds` and must be supported by the selected backend.
 */
export interface PreparedToolRegistration {
  kind: "prepared";
  trust: "analyzer";
  definition: ToolDefinition;
  allowedOperationKinds: AllowedOperationKind[];
  analyze(
    args: unknown,
    context: ToolAnalysisContext,
  ): Promise<PreparedToolAction>;
}

/**
 * Static argument-to-request mapping for a broker connector. Data-only; the
 * preferred untrusted-input extension point. No developer callback runs
 * during preparation or execution.
 */
export interface DeclarativeConnectorMapping {
  version: 1;
  operation: string;
  /** connector field → validated JSON Pointer into tool args */
  argumentBindings: Record<string, string>;
  constants?: Record<string, JsonValue>;
  secretRefs?: string[];
}

export interface BrokerConnectorRegistration {
  kind: "broker-connector";
  definition: ToolDefinition;
  connector: string;
  mapping: DeclarativeConnectorMapping;
}

/**
 * Host-trusted tool registration. Application authority, not model-grant
 * authority; always audit-labelled; disabled by default for server and
 * multi-tenant roots and only an operator allowlist can enable them.
 */
export interface TrustedHostToolRegistration {
  trust: "host";
  definition: ToolDefinition;
  execute(args: unknown, context: HostToolContext): Promise<string | ToolResult>;
}

export interface HostToolContext {
  signal?: AbortSignal;
  config?: Record<string, unknown>;
}

export type UserToolRegistration =
  | PreparedToolRegistration
  | BrokerConnectorRegistration;

/**
 * Legacy `tool({ execute })` registration shape, recognized for one
 * deprecation window. Emits a warning on registration and fails closed at
 * execution unless migrated to an explicit trust model.
 */
export interface LegacyHostToolRegistration {
  trust: "legacy-host";
  definition: ToolDefinition;
  execute(args: unknown, context: HostToolContext): Promise<string | ToolResult>;
}
