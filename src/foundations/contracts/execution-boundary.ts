/**
 * Execution boundary and backend capability contracts — Foundations (spec 008).
 *
 * `ExecutionBoundary.execute()` is the sole side-effect entry point for
 * model-authored actions. There is no second `ToolModule.executePrepared()`
 * authority. Backends own a registry from `PreparedOperation.kind` to
 * executor, supplied at a composition root through Foundations contracts.
 *
 * Foundations imports no Seepient layer.
 */

import type { PreparedToolAction, PreparedOperation } from "./prepared-action.js";
import type { ToolResult } from "../types.js";
import type { Capability } from "./permission-policy.js";
import type { NetworkDestination } from "./tool-effects.js";

/** Progress callback for long-running operations. */
export interface ToolProgress {
  percentage?: number;
  message: string;
}

/** Structured tool error carried in failure outcomes. */
export interface StructuredToolError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Declared enforcement shape of an execution backend. Policy never offers a
 * capability the selected backend cannot enforce.
 */
export interface ExecutionBackendCapabilities {
  backend:
    | "local-native"
    | "docker-worker"
    | "remote-worker"
    | "browser-worker"
    | "uncontained";
  capabilityKinds: Capability["kind"][];
  exactCommit: boolean;
  hostFilteredEgress: boolean;
  environmentIsolation: boolean;
  supportedOperationKinds: PreparedOperation["kind"][];
}

/** Evidence produced by enforcement; recorded with the terminal audit event. */
export interface EnforcementEvidence {
  backend: ExecutionBackendCapabilities["backend"];
  actionDigest: string;
  executorId: string;
  operationKind: PreparedOperation["kind"];
  committedTargets?: string[];
  effectiveDestinations?: NetworkDestination[];
}

export type ExecutionResult =
  | {
      state: "succeeded";
      result: ToolResult;
      evidence: EnforcementEvidence;
    }
  | {
      state: "failed" | "cancelled";
      error: StructuredToolError;
      evidence: EnforcementEvidence;
    };

/**
 * The sole side-effect entry point for model-authored actions. Backends
 * dispatch versioned, serializable `PreparedOperation` values through an
 * executor registry wired at a composition root.
 */
export interface ExecutionBoundary {
  readonly capabilities: ExecutionBackendCapabilities;
  execute(
    action: PreparedToolAction,
    envelope: import("./permission-policy.js").CapabilityEnvelope,
    opts: {
      signal?: AbortSignal;
      onUpdate?: (update: ToolProgress) => void;
    },
  ): Promise<ExecutionResult>;
}
