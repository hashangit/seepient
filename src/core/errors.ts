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
