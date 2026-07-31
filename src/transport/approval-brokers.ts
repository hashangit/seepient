/**
 * Approval brokers — Transport (spec 008, T301, FR-005/FR-015).
 *
 * Surface-specific brokers that translate the Domain `PermissionRequest`
 * into a presentation. The broker CANNOT change the requested capability;
 * it only collects a human/external decision. Three built-in brokers cover
 * the headless and interactive local surfaces:
 *
 *  - `NoneApprovalBroker` (`mode:"none"`): headless SDK/CLI/REST. Never waits;
 *    returns a typed denial immediately. No stdin/TUI/callback path reached.
 *  - `InlineApprovalBroker` (`mode:"inline"`): TUI/interactive CLI. Presents
 *    one deterministic prompt; abortable via AbortSignal + deadline.
 *  - `CallbackApprovalBroker` (`mode:"callback"`): SDK custom UI. Routes the
 *    typed request to an application-supplied async function.
 *
 * Durable-remote brokers (`mode:"durable-remote"`) belong to P4 server split.
 *
 * Transport layer: validates + delegates; contains no product policy.
 */
import type {
  ApprovalBroker,
  PermissionDecision,
  PermissionRequest,
} from "../foundations/contracts/permission-policy.js";

/** Callback shape for the SDK callback broker. */
export type ApprovalCallback = (
  request: PermissionRequest,
  opts: { signal?: AbortSignal },
) => Promise<PermissionDecision>;

/**
 * Headless broker. Never waits for a human; returns a structured denial so
 * the policy engine records `approval-unavailable` and the model can adapt.
 * Used by: headless CLI, headless SDK, REST `interaction:"never"`.
 */
export class NoneApprovalBroker implements ApprovalBroker {
  readonly mode = "none" as const;

  async request(req: PermissionRequest): Promise<PermissionDecision> {
    return {
      approved: false,
      requestId: req.requestId,
      actionDigest: req.actionDigest,
      actorId: "none-broker",
      reason: "headless surface: no approval available",
      decidedAt: Date.now(),
    };
  }
}

/**
 * SDK callback broker. Routes the typed request to an application-supplied
 * async function. The callback may abort via signal, reject (→ denial), or
 * return a decision for the WRONG action (→ invalid-approval-response, caught
 * by the lifecycle). The SDK never falls back to stdin or console prompts.
 */
export class CallbackApprovalBroker implements ApprovalBroker {
  readonly mode = "callback" as const;
  private readonly callback: ApprovalCallback;

  constructor(callback: ApprovalCallback) {
    this.callback = callback;
  }

  async request(
    req: PermissionRequest,
    opts: { signal?: AbortSignal },
  ): Promise<PermissionDecision> {
    // If already aborted, deny immediately rather than invoking the callback.
    if (opts.signal?.aborted) {
      return {
        approved: false,
        requestId: req.requestId,
        actionDigest: req.actionDigest,
        actorId: "callback-broker",
        reason: "aborted before callback",
        decidedAt: Date.now(),
      };
    }
    // Delegate; a throw becomes a denial at the lifecycle layer.
    return this.callback(req, opts);
  }
}

/**
 * Inline (TUI/CLI) broker presenter contract. The UI implements this; the
 * broker owns the deadline + abort handling so the UI stays pure rendering.
 */
export interface InlineApprovalPresenter {
  prompt(
    req: PermissionRequest,
    opts: { signal?: AbortSignal },
  ): Promise<PermissionDecision>;
}

/**
 * Interactive broker. Presents one deterministic prompt via the injected
 * presenter; honors deadline and AbortSignal. Timeout/abort/closed-UI denies
 * safely. One action produces at most one prompt.
 */
export class InlineApprovalBroker implements ApprovalBroker {
  readonly mode = "inline" as const;
  private readonly presenter: InlineApprovalPresenter;
  private readonly deadlineMs: number;

  constructor(presenter: InlineApprovalPresenter, opts?: { deadlineMs?: number }) {
    this.presenter = presenter;
    this.deadlineMs = opts?.deadlineMs ?? 30_000;
  }

  async request(
    req: PermissionRequest,
    opts: { signal?: AbortSignal },
  ): Promise<PermissionDecision> {
    // Compose the caller's signal with a deadline signal.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deadlineMs);
    const onParentAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      const decision = await this.presenter.prompt(req, {
        signal: controller.signal,
      });
      // Ensure the decision references the correct request (defensive).
      if (
        decision.requestId !== req.requestId ||
        decision.actionDigest !== req.actionDigest
      ) {
        return {
          approved: false,
          requestId: req.requestId,
          actionDigest: req.actionDigest,
          actorId: "inline-broker",
          reason: "presenter returned a decision for a different request",
          decidedAt: Date.now(),
        };
      }
      return decision;
    } catch {
      // Timeout, abort, or closed UI → safe denial.
      return {
        approved: false,
        requestId: req.requestId,
        actionDigest: req.actionDigest,
        actorId: "inline-broker",
        reason: "prompt aborted, timed out, or UI closed",
        decidedAt: Date.now(),
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onParentAbort);
    }
  }
}

/** `--yes` means never-ask; it does NOT change the execution boundary. */
export function yesFlagToApprovalMode(yes: boolean): "manual" | "never" {
  return yes ? "never" : "manual";
}
