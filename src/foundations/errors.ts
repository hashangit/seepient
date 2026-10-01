/**
 * Seepient Core — Error class hierarchy
 *
 * Proper class hierarchy for all Seepient errors.
 * Each error class carries a `code`, `retryable` flag, and domain-specific
 * metadata (e.g. `provider`, `tool`, `steps`).
 */

// ── Base error ──────────────────────────────────────────────────────────

/**
 * Base class for all Seepient errors.
 *
 * Carries a machine-readable `code` and a `retryable` flag so callers can
 * decide whether to retry automatically.
 */
export class SeepientError extends Error {
  /** Machine-readable error code, e.g. "PROVIDER_ERROR", "TOOL_FAILED". */
  code: string;
  /** Whether the operation that caused this error can be retried. */
  retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "SeepientError";
    this.code = code;
    this.retryable = retryable;
  }
}

// ── Provider errors ─────────────────────────────────────────────────────

export type InferenceErrorCode =
  | "unsupported_capability"
  | "unsupported_thinking_level"
  | "provider_unavailable"
  | "rate_limit"
  | "context_overflow"
  | "invalid_request"
  | "auth"
  | "timeout"
  | "network"
  | "overload"
  | "content_policy"
  | "malformed_response"
  | "internal_adapter"
  | "model_not_found"
  | "unknown_model"
  | "unconfigured_provider"
  | "unconfigured_purpose"
  | "oauth_expired";

export interface InferenceErrorOptions {
  code: InferenceErrorCode;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
  providerAccount?: string;
  model?: string;
  cause?: unknown;
}

/**
 * Standardized error originating from unified inference operations.
 */
export class InferenceError extends SeepientError {
  providerAccount?: string;
  model?: string;
  retryAfterMs?: number;

  constructor(opts: InferenceErrorOptions) {
    super(opts.message, opts.code, opts.retryable ?? false);
    this.name = "InferenceError";
    this.providerAccount = opts.providerAccount;
    this.model = opts.model;
    this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause) {
      this.cause = opts.cause;
    }
  }
}

/**
 * Error originating from a provider (LLM API call failure, auth, rate-limit, etc.).
 */
export class ProviderError extends SeepientError {
  /** The provider name that produced the error, if known. */
  provider?: string;

  constructor(message: string, provider?: string) {
    super(message, "PROVIDER_ERROR", true);
    this.name = "ProviderError";
    this.provider = provider;
  }
}

// ── Tool errors ─────────────────────────────────────────────────────────

/**
 * Error from tool execution.
 */
export class ToolError extends SeepientError {
  /** The tool name that produced the error, if known. */
  tool?: string;

  constructor(message: string, tool?: string) {
    super(message, "TOOL_FAILED", true);
    this.name = "ToolError";
    this.tool = tool;
  }
}

// ── Max steps ───────────────────────────────────────────────────────────

/**
 * Thrown when the agent loop exceeds the configured maximum number of steps.
 */
export class MaxStepsError extends SeepientError {
  /** The number of steps that were executed. */
  steps: number;

  constructor(steps: number, maxSteps: number) {
    super(
      `Maximum steps reached (${steps}/${maxSteps})`,
      "MAX_STEPS",
      false,
    );
    this.name = "MaxStepsError";
    this.steps = steps;
  }
}

// ── Aborted ─────────────────────────────────────────────────────────────

/**
 * Thrown when an operation is aborted (e.g. via AbortSignal).
 */
export class AbortedError extends SeepientError {
  constructor(message?: string) {
    super(message ?? "Operation was aborted", "ABORTED", false);
    this.name = "AbortedError";
  }
}

// ── Gateway errors ──────────────────────────────────────────────────────

/**
 * Error from gateway operations (MCP client, REST proxy, target management).
 */
export class GatewayError extends SeepientError {
  /** The target name that produced the error, if known. */
  target?: string;

  constructor(message: string, target?: string, retryable: boolean = true) {
    super(message, "GATEWAY_ERROR", retryable);
    this.name = "GatewayError";
    this.target = target;
  }
}

// ── Widget errors ───────────────────────────────────────────────────────

/** Widget validation error — malformed render_widget payload. */
export class WidgetError extends SeepientError {
  widgetId?: string;

  constructor(message: string, code: 'WIDGET_INVALID_KIND' | 'WIDGET_INVALID_PROPS' | 'WIDGET_DUPLICATE_ACTION', widgetId?: string) {
    super(message, code, true);
    this.name = "WidgetError";
    this.widgetId = widgetId;
  }
}

// ── Hashline errors ─────────────────────────────────────────────────────

/** Hashline patch application error. */
export class HashlineError extends SeepientError {
  constructor(message: string, code: string, retryable: boolean) {
    super(message, code, retryable);
    this.name = "HashlineError";
  }
}

// ── Permission system errors (spec 008) ─────────────────────────────────

/**
 * Structured permission/policy/audit/broker errors. Each carries a stable
 * `code` and `retryable` flag; safe metadata only — never secret values.
 */
export class PermissionError extends SeepientError {
  /** PermissionDenyReason or broker/audit/store code (never a secret). */
  denyReason?: string;
  /** Action digest the error concerns (safe to log). */
  actionDigest?: string;

  constructor(
    message: string,
    code: string,
    opts: { retryable?: boolean; denyReason?: string; actionDigest?: string } = {},
  ) {
    super(message, code, opts.retryable ?? false);
    this.name = "PermissionError";
    this.denyReason = opts.denyReason;
    this.actionDigest = opts.actionDigest;
  }
}

/**
 * Approval broker error — timeout, abort, invalid response, or durable-remote
 * failure. `retryable` is true only for transient remote failures.
 */
export class ApprovalBrokerError extends PermissionError {
  requestId?: string;

  constructor(
    message: string,
    code:
      | "APPROVAL_TIMEOUT"
      | "APPROVAL_ABORTED"
      | "APPROVAL_INVALID_RESPONSE"
      | "APPROVAL_UNAVAILABLE",
    opts: { retryable?: boolean; requestId?: string; actionDigest?: string } = {},
  ) {
    super(message, code, opts);
    this.name = "ApprovalBrokerError";
    this.requestId = opts.requestId;
  }
}

/**
 * Audit store error — failure to record the durable `dispatched` event denies
 * effectful execution; terminal-event persistence delay is reported as
 * degraded health, not success.
 */
export class AuditError extends PermissionError {
  actionId?: string;
  state?: string;

  constructor(
    message: string,
    code: "AUDIT_UNAVAILABLE" | "AUDIT_CONFLICT" | "AUDIT_OUTBOX_DEGRADED",
    opts: { retryable?: boolean; actionId?: string; state?: string } = {},
  ) {
    super(message, code, opts);
    this.name = "AuditError";
    this.actionId = opts.actionId;
    this.state = opts.state;
  }
}

/**
 * Policy store conflict — stale `expectedVersion` cannot overwrite a newer
 * policy. Caller must re-read and retry.
 */
export class PolicyConflictError extends PermissionError {
  workspaceId?: string;
  expectedVersion?: number;
  actualVersion?: number;

  constructor(
    message: string,
    opts: {
      workspaceId?: string;
      expectedVersion?: number;
      actualVersion?: number;
    } = {},
  ) {
    super(message, "POLICY_CONFLICT", { retryable: true });
    this.name = "PolicyConflictError";
    this.workspaceId = opts.workspaceId;
    this.expectedVersion = opts.expectedVersion;
    this.actualVersion = opts.actualVersion;
  }
}

/**
 * Worker scheduler error — dispatch nonce replay, unknown version, expired
 * lease, forged digest, or scheduler unavailable.
 */
export class WorkerSchedulerError extends PermissionError {
  dispatchId?: string;
  leaseId?: string;

  constructor(
    message: string,
    code:
      | "WORKER_REPLAY"
      | "WORKER_UNKNOWN_VERSION"
      | "WORKER_EXPIRED_LEASE"
      | "WORKER_FORGED_DIGEST"
      | "WORKER_UNAVAILABLE"
      | "WORKER_UNSCHEDULABLE",
    opts: { retryable?: boolean; dispatchId?: string; leaseId?: string } = {},
  ) {
    super(message, code, opts);
    this.name = "WorkerSchedulerError";
    this.dispatchId = opts.dispatchId;
    this.leaseId = opts.leaseId;
  }
}

/**
 * Execution backend cannot enforce the requested capability shape. Policy
 * must not offer an unenforceable shape; this surfaces when a caller asks
 * anyway.
 */
export class UnsupportedBackendError extends PermissionError {
  backend?: string;
  operationKind?: string;

  constructor(opts: {
    backend?: string;
    operationKind?: string;
    actionDigest?: string;
    message?: string;
  }) {
    super(
      opts.message ??
        `Backend cannot enforce operation "${opts.operationKind ?? "?"}"`,
      "BACKEND_UNSUPPORTED",
      { retryable: false, actionDigest: opts.actionDigest },
    );
    this.name = "UnsupportedBackendError";
    this.backend = opts.backend;
    this.operationKind = opts.operationKind;
  }
}

// ── Skill store errors ──────────────────────────────────────────────────

/**
 * Thrown when an operation requires a SkillStore (such as saving a generated
 * skill) but no SkillStore is present in the effective sources list.
 */
export class SkillStoreUnavailableError extends SeepientError {
  constructor(
    message = "SKILL_STORE_UNAVAILABLE: No SkillStore is configured in the effective sources list. Remediation: To save generated skills in an SDK/stateless worker, inject a SkillStore in the `sources` array (e.g. `sources: [..., mySkillStore]`).",
  ) {
    super(message, "SKILL_STORE_UNAVAILABLE", false);
    this.name = "SkillStoreUnavailableError";
  }
}

/**
 * Thrown when attempting to save a generated skill with a name that already
 * exists in one of the effective sources without explicit update intent.
 */
export class SkillCollisionError extends SeepientError {
  existingName: string;
  existingSource?: string;

  constructor(name: string, source?: string) {
    super(
      `Skill "${name}" already exists (collision in source: ${source ?? "unknown"}). To update the existing skill, provide explicit update intent (replace: true, changelogEntry: "...") or choose a different name.`,
      "SKILL_COLLISION",
      false,
    );
    this.name = "SkillCollisionError";
    this.existingName = name;
    this.existingSource = source;
  }
}

/**
 * Thrown when a catalog-listed skill exists in the registry but its body
 * cannot be loaded or is unreadable (FR-034).
 */
export class SkillBodyUnavailableError extends SeepientError {
  skillName: string;

  constructor(skillName: string, detail?: string) {
    const detailMsg = detail ? ` (${detail})` : "";
    super(
      `SKILL_BODY_UNAVAILABLE: Skill '${skillName}' content is unavailable or unreadable${detailMsg}.`,
      "SKILL_BODY_UNAVAILABLE",
      false,
    );
    this.name = "SkillBodyUnavailableError";
    this.skillName = skillName;
  }
}

/**
 * Thrown when attempting to save a generated skill with an empty body (FR-036).
 */
export class SkillBodyRequiredError extends SeepientError {
  constructor(name: string) {
    super(
      `SKILL_BODY_REQUIRED: Cannot save skill '${name}' with an empty body.`,
      "SKILL_BODY_REQUIRED",
      false,
    );
    this.name = "SkillBodyRequiredError";
  }
}

// ── Session persistence errors ──────────────────────────────────────────

/**
 * Thrown when the `persist` option passed to `createSeepient` does not match
 * any supported persistence backend format.
 */
export class PersistConfigInvalidError extends SeepientError {
  constructor(
    message = 'PERSIST_CONFIG_INVALID: Invalid "persist" configuration shape. Supported forms are: (1) directory path string, (2) PersistenceConfig object ({ type: "file", path: "..." } or { type: "memory" }), or (3) a custom PersistenceBackend instance implementing load() and save().',
  ) {
    super(message, "PERSIST_CONFIG_INVALID", false);
    this.name = "PersistConfigInvalidError";
  }
}

/**
 * Thrown when a session ID is invalid (format mismatch or exceeds 128 characters).
 */
export class SessionIdInvalidError extends SeepientError {
  readonly sessionId: string;

  constructor(sessionId: string, message?: string) {
    const defaultMessage = `SESSION_ID_INVALID: Invalid session ID "${sessionId}". Only alphanumeric characters, dashes, and underscores are allowed (max 128 characters).`;
    super(message ?? defaultMessage, "SESSION_ID_INVALID", false);
    this.name = "SessionIdInvalidError";
    this.sessionId = sessionId;
  }
}

// ── Multi-tenant errors ─────────────────────────────────────────────────

/**
 * Thrown when multi-tenant mode is active (explicit or upgraded) but no explicit
 * principalId is provided.
 */
export class PrincipalRequiredError extends SeepientError {
  constructor(
    message = 'PRINCIPAL_REQUIRED: tenancy: "multi" requires an explicit principalId. Pass a stable per-tenant identifier (e.g. tenantId or userId).',
  ) {
    super(message, "PRINCIPAL_REQUIRED", false);
    this.name = "PrincipalRequiredError";
  }
}

/**
 * Thrown when a principalId violates the allowed slug grammar /^[a-zA-Z0-9_-]{1,128}$/
 * or matches a case-insensitive sentinel ("default", "anonymous", "sdk-user").
 */
export class InvalidPrincipalIdError extends PrincipalRequiredError {
  constructor(
    message = 'INVALID_PRINCIPAL_ID: principalId must match /^[a-zA-Z0-9_-]{1,128}$/ and cannot be a sentinel value ("default", "anonymous", "sdk-user").',
  ) {
    super(message);
    this.code = "INVALID_PRINCIPAL_ID";
    this.name = "InvalidPrincipalIdError";
  }
}

/**
 * Thrown when multi-tenant mode is active without an explicit cwd/workspace.
 */
export class TenancyWorkspaceRequiredError extends SeepientError {
  constructor(
    message = 'TENANCY_WORKSPACE_REQUIRED: tenancy: "multi" requires an explicit cwd/workspaceRoot to prevent cross-tenant disk contamination.',
  ) {
    super(message, "TENANCY_WORKSPACE_REQUIRED", false);
    this.name = "TenancyWorkspaceRequiredError";
  }
}

/**
 * Thrown when an explicit credential is required in multi-tenant mode but was omitted
 * or cannot be resolved without ambient fallback.
 */
export class CredentialRequiredError extends SeepientError {
  constructor(
    message = 'CREDENTIAL_REQUIRED: Explicit credential required in multi-tenant mode.',
  ) {
    super(message, "CREDENTIAL_REQUIRED", false);
    this.name = "CredentialRequiredError";
  }
}

/**
 * Thrown when global approval lifetime is requested or persisted in multi-tenant mode.
 */
export class GlobalLifetimeForbiddenError extends PermissionError {
  constructor(
    message = "GLOBAL_LIFETIME_FORBIDDEN: global approval lifetime is not available in multi-tenant mode; use project or session scope",
  ) {
    super(message, "GLOBAL_LIFETIME_FORBIDDEN", { retryable: false });
    this.name = "GlobalLifetimeForbiddenError";
  }
}

/**
 * Thrown when a file path resolves outside the tenant workspace boundary.
 * The resolved host path is kept on `resolvedPath` for internal logging but is
 * deliberately omitted from the message: tenants must not get a host-path
 * existence/canonicalization oracle.
 */
export class PathEscapesWorkspaceError extends ToolError {
  readonly resolvedPath: string;
  constructor(resolvedPath: string, message?: string) {
    super(
      message ??
        "PATH_ESCAPES_WORKSPACE: this path resolves outside your workspace; ask your operator for access or work on a copy inside the workspace",
    );
    this.name = "PathEscapesWorkspaceError";
    this.code = "PATH_ESCAPES_WORKSPACE";
    this.retryable = false;
    this.resolvedPath = resolvedPath;
  }
}

/**
 * Thrown when attempting to read a hardlinked file with link count > 1.
 */
export class PathHardlinkRefusedError extends ToolError {
  readonly targetPath: string;
  constructor(targetPath: string, message?: string) {
    super(
      message ??
        `PATH_HARDLINK_REFUSED: reads of files with more than one name on this filesystem are prohibited: ${targetPath}. Use a regular file inside your workspace`,
    );
    this.name = "PathHardlinkRefusedError";
    this.code = "PATH_HARDLINK_REFUSED";
    this.retryable = false;
    this.targetPath = targetPath;
  }
}

/**
 * Thrown when the file opened for reading is not the same file (device/inode)
 * that was authorized at analysis time. Catches mid-path (parent-directory)
 * symlink swaps and rename swaps that O_NOFOLLOW cannot see.
 */
export class PathIdentityMismatchError extends ToolError {
  readonly targetPath: string;
  constructor(targetPath: string, message?: string) {
    super(
      message ??
        `PATH_IDENTITY_MISMATCH: the file at ${targetPath} changed between authorization and read (device/inode mismatch); re-read the file and retry`,
    );
    this.name = "PathIdentityMismatchError";
    this.code = "PATH_IDENTITY_MISMATCH";
    this.retryable = false;
    this.targetPath = targetPath;
  }
}



