/**
 * Prepared Action Validator & Constructor — Domain (spec 020, FR-002, US1).
 *
 * Validates untrusted third-party PreparedActionDraft objects fail-closed
 * and stamps platform identity fields (runId, toolCallId, toolName, principalId)
 * and digests (argsDigest, actionDigest).
 *
 * Layers: Domain may import Foundations and Capabilities.
 */
import { randomUUID } from "node:crypto";
import type {
  PreparedActionDraft,
  PreparedToolRegistration,
  ToolAnalysisContext,
} from "../../foundations/contracts/custom-tools.js";
import type {
  PreparedToolAction,
  PreparedOperation,
  ActionDisplay,
} from "../../foundations/contracts/prepared-action.js";
import type {
  EffectRequest,
  ToolRiskCategory,
} from "../../foundations/contracts/tool-effects.js";
import { digestAction, digestArgs } from "../../capabilities/tools/analyzers.js";

export const SUPPORTED_OPERATION_KINDS: readonly string[] = [
  "commit-files",
  "read-file",
  "process",
  "broker",
  "none",
] as const;

export const VALID_RISK_CATEGORIES: readonly ToolRiskCategory[] = [
  "safe",
  "edit",
  "communications",
  "destructive",
] as const;

const VALIDATED_BRAND = Symbol("ValidatedPreparedAction");

export type ValidatedPreparedAction = PreparedToolAction & {
  readonly [VALIDATED_BRAND]?: true;
};

export type PreparedActionErrorCode =
  | "PREPARED_ACTION_INVALID_SHAPE"
  | "PREPARED_ACTION_KIND_NOT_DECLARED"
  | "PREPARED_ACTION_KIND_UNSUPPORTED"
  | "PREPARED_ACTION_EFFECTS_INVALID"
  | "PREPARED_ACTION_REGISTRATION_COLLISION";

export class PreparedActionError extends Error {
  readonly code: PreparedActionErrorCode;
  readonly retryable: false = false;
  readonly remediation: string;

  constructor(code: PreparedActionErrorCode, message: string, remediation: string) {
    super(`${code}: ${message}\nRemediation: ${remediation}`);
    this.name = "PreparedActionError";
    this.code = code;
    this.remediation = remediation;
  }
}

/**
 * Validate an author-supplied PreparedActionDraft and construct a platform-stamped
 * ValidatedPreparedAction with computed digests and context identity.
 */
export function buildPreparedAction(
  draft: unknown,
  declared: import("../../foundations/contracts/custom-tools.js").PreparedToolRegistration | import("../../foundations/contracts/custom-tools.js").BrokerConnectorRegistration,
  ctx: ToolAnalysisContext,
  rawArgs?: unknown,
): ValidatedPreparedAction {
  // 1. Shape check
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new PreparedActionError(
      "PREPARED_ACTION_INVALID_SHAPE",
      "Analyzer must return a non-null PreparedActionDraft object.",
      "Ensure the analyzer returns { operation, effects, risk, display }. See contracts/prepared-tool-execution.md.",
    );
  }

  const d = draft as Partial<PreparedActionDraft>;

  if (!d.operation || typeof d.operation !== "object" || typeof (d.operation as any).kind !== "string") {
    throw new PreparedActionError(
      "PREPARED_ACTION_INVALID_SHAPE",
      "Draft missing or invalid 'operation' object with a string 'kind'.",
      "Supply a valid PreparedOperation on draft.operation. See contracts/prepared-tool-execution.md.",
    );
  }

  if (!Array.isArray(d.effects)) {
    throw new PreparedActionError(
      "PREPARED_ACTION_INVALID_SHAPE",
      "Draft 'effects' must be an array of EffectRequest.",
      "Supply an array of EffectRequest on draft.effects. See contracts/prepared-tool-execution.md.",
    );
  }

  if (!d.risk || !VALID_RISK_CATEGORIES.includes(d.risk as ToolRiskCategory)) {
    throw new PreparedActionError(
      "PREPARED_ACTION_INVALID_SHAPE",
      `Draft 'risk' must be one of: ${VALID_RISK_CATEGORIES.join(", ")}. Received: ${String(d.risk)}`,
      `Set draft.risk to a valid ToolRiskCategory ('safe' | 'edit' | 'communications' | 'destructive'). See contracts/prepared-tool-execution.md.`,
    );
  }

  if (!d.display || typeof d.display !== "object" || typeof (d.display as ActionDisplay).title !== "string" || !(d.display as ActionDisplay).title.trim()) {
    throw new PreparedActionError(
      "PREPARED_ACTION_INVALID_SHAPE",
      "Draft missing or invalid 'display' object with a non-empty 'title'.",
      "Supply an ActionDisplay with a non-empty 'title' on draft.display. See contracts/prepared-tool-execution.md.",
    );
  }

  const opKind = (d.operation as PreparedOperation).kind;

  // 2. Declared kinds containment check (PreparedToolRegistration only)
  if (declared.kind === "prepared") {
    const declaredKinds = declared.allowedOperationKinds;
    if (!declaredKinds.includes(opKind as any)) {
      throw new PreparedActionError(
        "PREPARED_ACTION_KIND_NOT_DECLARED",
        `Operation kind "${opKind}" was returned by analyzer but not declared in tool registration allowedOperationKinds [${declaredKinds.join(", ")}].`,
        `Add "${opKind}" to the preparedTool({ allowedOperationKinds: [...] }) registration or adjust analyzer to return declared kinds.`,
      );
    }
  }

  // 3. Supported kinds containment check
  if (!SUPPORTED_OPERATION_KINDS.includes(opKind)) {
    throw new PreparedActionError(
      "PREPARED_ACTION_KIND_UNSUPPORTED",
      `Operation kind "${opKind}" is not in the supported operation kinds list.`,
      `Supported operation kinds are: ${SUPPORTED_OPERATION_KINDS.join(", ")}. See contracts/prepared-tool-execution.md.`,
    );
  }

  // 4. Effects consistency & payload verification
  if (opKind !== "none" && d.effects.length === 0) {
    throw new PreparedActionError(
      "PREPARED_ACTION_EFFECTS_INVALID",
      `Effects array cannot be empty for operation kind "${opKind}".`,
      `Provide at least one EffectRequest describing the intended effect of "${opKind}". See contracts/prepared-tool-execution.md.`,
    );
  }

  if (opKind === "commit-files") {
    const commits = (d.operation as any).commits;
    if (!Array.isArray(commits) || commits.length === 0) {
      throw new PreparedActionError(
        "PREPARED_ACTION_INVALID_SHAPE",
        "Operation kind 'commit-files' requires a non-empty 'commits' array with at least one file commit.",
        "Provide { kind: 'commit-files', commits: [{ destination, content }] } with valid CanonicalPathTarget and PreparedArtifactRef. See contracts/prepared-tool-execution.md.",
      );
    }
    for (const commit of commits) {
      if (!commit || !commit.destination?.canonicalPath || !commit.content?.artifactId) {
        throw new PreparedActionError(
          "PREPARED_ACTION_INVALID_SHAPE",
          "Each item in 'commits' array must have a destination CanonicalPathTarget and content PreparedArtifactRef.",
          "Ensure each commit specifies destination { canonicalPath, ... } and content { artifactId, ... }. See contracts/prepared-tool-execution.md.",
        );
      }
      if (ctx.artifacts && typeof (ctx.artifacts as any).has === "function") {
        if (!(ctx.artifacts as any).has(commit.content.artifactId)) {
          throw new PreparedActionError(
            "PREPARED_ACTION_INVALID_SHAPE",
            `Artifact "${commit.content.artifactId}" referenced in commit was not found in preparation store.`,
            "Ensure artifacts are created via ctx.artifacts.put(...) prior to returning the draft.",
          );
        }
      }
    }

    const fsWriteEffects = d.effects.filter((e) => e.kind === "filesystem-write") as Extract<EffectRequest, { kind: "filesystem-write" }>[];
    if (fsWriteEffects.length === 0) {
      throw new PreparedActionError(
        "PREPARED_ACTION_EFFECTS_INVALID",
        `Operation kind 'commit-files' requires at least one 'filesystem-write' effect in effects array.`,
        `Add a 'filesystem-write' EffectRequest to draft.effects for 'commit-files'. See contracts/prepared-tool-execution.md.`,
      );
    }

    // Cross-check: commit destinations must match filesystem-write targets
    const writtenPaths = new Set(
      fsWriteEffects.flatMap((e) => e.targets.map((t) => t.target.canonicalPath)),
    );
    for (const commit of commits) {
      if (!writtenPaths.has(commit.destination.canonicalPath)) {
        throw new PreparedActionError(
          "PREPARED_ACTION_EFFECTS_INVALID",
          `Commit destination "${commit.destination.canonicalPath}" is not covered by any declared 'filesystem-write' effect target.`,
          `Declare a 'filesystem-write' target for every destination path in draft.operation.commits. See contracts/prepared-tool-execution.md.`,
        );
      }
    }
  } else if (opKind === "read-file") {
    const target = (d.operation as any).target;
    if (!target || !target.canonicalPath) {
      throw new PreparedActionError(
        "PREPARED_ACTION_INVALID_SHAPE",
        "Operation kind 'read-file' requires a 'target' object with a canonicalPath.",
        "Provide { kind: 'read-file', target: CanonicalPathTarget } on draft.operation. See contracts/prepared-tool-execution.md.",
      );
    }
    const fsReadEffects = d.effects.filter((e) => e.kind === "filesystem-read") as Extract<EffectRequest, { kind: "filesystem-read" }>[];
    if (fsReadEffects.length === 0) {
      throw new PreparedActionError(
        "PREPARED_ACTION_EFFECTS_INVALID",
        `Operation kind 'read-file' requires at least one 'filesystem-read' effect in effects array.`,
        `Add a 'filesystem-read' EffectRequest to draft.effects for 'read-file'. See contracts/prepared-tool-execution.md.`,
      );
    }
    const readPaths = new Set(fsReadEffects.flatMap((e) => e.targets.map((t) => t.canonicalPath)));
    if (!readPaths.has(target.canonicalPath)) {
      throw new PreparedActionError(
        "PREPARED_ACTION_EFFECTS_INVALID",
        `Read target "${target.canonicalPath}" is not covered by any declared 'filesystem-read' effect target.`,
        `Declare a 'filesystem-read' target matching draft.operation.target. See contracts/prepared-tool-execution.md.`,
      );
    }
  } else if (opKind === "process") {
    const proc = d.operation as any;
    if (!proc.command || !Array.isArray(proc.roots) || proc.roots.length === 0) {
      throw new PreparedActionError(
        "PREPARED_ACTION_INVALID_SHAPE",
        "Operation kind 'process' requires 'command' and non-empty 'roots' array.",
        "Provide { kind: 'process', command: string | string[], roots: string[] } on draft.operation. See contracts/prepared-tool-execution.md.",
      );
    }
    const hasProcExec = d.effects.some((e) => e.kind === "process-exec");
    if (!hasProcExec) {
      throw new PreparedActionError(
        "PREPARED_ACTION_EFFECTS_INVALID",
        `Operation kind 'process' requires at least one 'process-exec' effect in effects array.`,
        `Add a 'process-exec' EffectRequest to draft.effects for 'process'. See contracts/prepared-tool-execution.md.`,
      );
    }
  } else if (opKind === "broker") {
    const req = (d.operation as any).request;
    if (!req || typeof req !== "object" || typeof req.kind !== "string") {
      throw new PreparedActionError(
        "PREPARED_ACTION_INVALID_SHAPE",
        "Operation kind 'broker' requires a valid 'request' object with a string 'kind'.",
        "Provide { kind: 'broker', request: BrokeredEffectRequest } on draft.operation. See contracts/prepared-tool-execution.md.",
      );
    }
  }

  // 5. Action construction with platform-stamped identity & computed digests
  let clonedOp: PreparedOperation;
  let clonedEffects: EffectRequest[];
  try {
    clonedOp = JSON.parse(JSON.stringify(d.operation));
    clonedEffects = JSON.parse(JSON.stringify(d.effects));
  } catch (err) {
    throw new PreparedActionError(
      "PREPARED_ACTION_INVALID_SHAPE",
      `Failed to serialize draft operation or effects: ${err instanceof Error ? err.message : String(err)}`,
      "Ensure operation and effects contain only JSON-serializable values (no BigInt, functions, or circular references).",
    );
  }

  const rawDisplay = d.display as ActionDisplay;
  const clonedDisplay: ActionDisplay = {
    title: rawDisplay.title,
    summary: rawDisplay.summary ?? rawDisplay.title,
    canonicalTargets: rawDisplay.canonicalTargets ? [...rawDisplay.canonicalTargets] : [],
    effects: rawDisplay.effects ? [...rawDisplay.effects] : clonedEffects.map((e) => e.kind),
    ...(rawDisplay.agentRationale ? { agentRationale: rawDisplay.agentRationale } : {}),
  };

  const toolName = declared.definition.function.name;
  const argsDigest = digestArgs(rawArgs ?? {});
  const actionDigest = digestAction({
    operation: clonedOp,
    effects: clonedEffects,
    principalId: ctx.principalId,
    toolName,
    argsDigest,
    runId: ctx.runId,
    toolCallId: ctx.toolCallId,
  });

  const action: PreparedToolAction = {
    version: 1,
    actionId: randomUUID(),
    principalId: ctx.principalId,
    runId: ctx.runId,
    toolCallId: ctx.toolCallId,
    toolName,
    operation: clonedOp,
    effects: clonedEffects,
    risk: d.risk,
    display: clonedDisplay,
    argsDigest,
    actionDigest,
  };

  return Object.freeze(action) as ValidatedPreparedAction;
}
