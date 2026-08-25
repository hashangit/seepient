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
