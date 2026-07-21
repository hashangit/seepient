/**
 * Prepared-action contract — Foundations (spec 008).
 *
 * An analyzer produces one immutable, versioned, serializable
 * `PreparedToolAction` before policy runs. The same prepared operation is
 * executed; there is no second `ToolModule.executePrepared()` authority and
 * no re-parsing of model input after approval. `PreparedOperation` carries
 * JSON-compatible values plus content-addressed artifact references — never
 * callbacks, open handles, secret values, or mutable worktree paths.
 *
 * Foundations imports no Seepient layer.
 */

import type { ToolResult } from "../types.js";
import type {
  CanonicalPathTarget,
  CommandDescriptor,
  EffectRequest,
  FileSnapshot,
  JsonValue,
  NetworkDestination,
  ExternalRecipient,
  RootRequest,
  ToolRiskCategory,
} from "./tool-effects.js";

/** Reference to a content-addressed artifact in the preparation store. */
export interface PreparedArtifactRef {
  artifactId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
}

/** Versioned prepared operation. Variant `kind` selects the executor. */
export type PreparedOperation =
  | { kind: "none"; result: ToolResult }
  | { kind: "read-file"; target: CanonicalPathTarget; expected: FileSnapshot }
  | { kind: "commit-files"; commits: PreparedFileCommit[] }
  | { kind: "process"; command: CommandDescriptor; roots: RootRequest[] }
  | { kind: "broker"; request: BrokeredEffectRequest }
  | { kind: "trusted-host"; registrationId: string; args: JsonValue };

/** One exact-file commit prepared by an analyzer. */
export interface PreparedFileCommit {
  destination: CanonicalPathTarget;
  content: PreparedArtifactRef;
  expected?: FileSnapshot;
}

/** Typed broker request — no generic socket/fetch surface. */
export type BrokeredEffectRequest =
  | {
      kind: "http";
      requestId: string;
      destination: NetworkDestination;
      method: string;
      headers: Record<string, string>;
      body?: PreparedArtifactRef;
      secretRefs: string[];
    }
  | {
      kind: "external-send";
      requestId: string;
      service: string;
      recipients: ExternalRecipient[];
      payload: PreparedArtifactRef;
      secretRefs: string[];
    }
  | {
      kind: "vendor-operation";
      requestId: string;
      connector: string;
      operation: string;
      input: JsonValue;
      secretRefs: string[];
    };

/** Deterministic, tool-owned display data. `agentRationale` is untrusted. */
export interface ActionDisplay {
  title: string;
  summary: string;
  canonicalTargets: string[];
  effects: import("./tool-effects.js").ToolEffectKind[];
  agentRationale?: string;
}

/**
 * Immutable analyzer output. `actionDigest` covers the canonical operation,
 * effect list, artifact digests, principal, and tool identity. Workers
 * verify the digest after deserialization and before dispatch.
 */
export interface PreparedToolAction {
  version: 1;
  actionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  principalId: string;
  argsDigest: string;
  actionDigest: string;
  risk: ToolRiskCategory;
  effects: EffectRequest[];
  display: ActionDisplay;
  operation: PreparedOperation;
}
