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
  /**
   * Session snapshot store (spec 019, FR-001). Analyzers that prepare
   * edits (edit_file) apply patches in memory against it at analysis time;
   * the SAME store instance backs the read-side tagging in the boundary.
   */
  snapshotStore?: import("../hashline/snapshot-store.js").SnapshotStore;
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
import type { UserToolDefinition } from "../types.js";

/**
 * Classify a legacy `tool({ execute })` registration. Emits a deprecation
 * warning and returns a `LegacyHostToolRegistration` that FAILS CLOSED at
 * execution until migrated to an explicit trust model. It never silently
 * becomes policy-governed or `safe`.
 */
export function classifyLegacyTool(def: UserToolDefinition): LegacyHostToolRegistration {
  if (typeof console !== "undefined") {
    console.warn(
      `[seepient] DEPRECATION: tool(${def.name ?? "<anonymous>"}) uses the legacy \`tool({ execute })\` factory. ` +
        `It will fail closed at execution. Migrate to preparedTool(), brokerConnector(), or ` +
        `trustedHostTool({ trust: "host" }) to select an explicit trust model.`,
    );
  }
  return {
    trust: "legacy-host",
    definition: {
      type: "function",
      function: {
        name: def.name ?? "legacy_tool",
        description: def.description,
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: def.execute,
  };
}
export interface LegacyHostToolRegistration {
  trust: "legacy-host";
  definition: ToolDefinition;
  execute(args: unknown, context: HostToolContext): Promise<string | ToolResult>;
}
