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
  TuiApprovalSelection,
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
 *
 * Spec 011 (T002): the presenter returns the transient `TuiApprovalSelection`
 * (option ID + lifetime only). The broker adds the trusted request ID, action
 * digest, actor identity, and decision time to produce the shared
 * `PermissionDecision` — the prompt never supplies authority metadata.
 */
export interface InlineApprovalPresenter {
  prompt(
    req: PermissionRequest,
    opts: { signal?: AbortSignal },
  ): Promise<TuiApprovalSelection>;
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
    // A request that expired while queued/displayed can never be approved.
    if (req.expiresAt < Date.now()) {
      return this.denial(req, "approval-expired");
    }
    // Compose the caller's signal with a deadline signal.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deadlineMs);
    const onParentAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      // Race the presenter against the deadline: a presenter that ignores
      // the abort signal must not hang the lifecycle forever (spec 011
      // review fix). The selection contract only carries
      // user-denied/approval-unavailable, so deadline and abort are
      // distinguished here, on the trusted side.
      const selection = await Promise.race([
        this.presenter.prompt(req, { signal: controller.signal }),
        new Promise<TuiApprovalSelection>((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () => resolve({ approved: false, reason: "approval-unavailable" }),
            { once: true },
          );
        }),
      ]);
      if (controller.signal.aborted) {
        // Deadline (request expired) vs parent abort (user cancelled) are
        // distinct typed reasons; the lifecycle maps them to the audit.
        return this.denial(
          req,
          opts.signal?.aborted ? "user-denied" : "approval-expired",
        );
      }
      return this.enrich(req, selection);
    } catch {
      // Timeout, abort, or closed UI → safe denial.
      return this.denial(
        req,
        "approval-expired",
        "prompt aborted, timed out, or UI closed",
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onParentAbort);
    }
  }

  /**
   * Turn a transient `TuiApprovalSelection` into the shared
   * `PermissionDecision`, binding it to THIS request. The broker is the only
   * place that supplies actor identity and decision time (FR-004).
   */
  private enrich(
    req: PermissionRequest,
    selection: TuiApprovalSelection,
  ): PermissionDecision {
    if (!selection.approved) {
      return this.denial(req, selection.reason ?? "user-denied");
    }
    // The selection must name a policy-issued option and an offered lifetime;
    // anything else is an invalid response, never a fallback option.
    const option = req.approvalOptions.find(
      (o) => o.optionId === selection.optionId,
    );
    if (!option) {
      return this.denial(req, "invalid-approval-response");
    }
    if (
      !option.supportedLifetimes.includes(selection.lifetime) ||
      !req.offeredLifetimes.includes(selection.lifetime) ||
      (selection.lifetime === "session" && !req.sessionId)
    ) {
      return this.denial(req, "invalid-approval-response");
    }
    return {
      approved: true,
      requestId: req.requestId,
      actionDigest: req.actionDigest,
      optionId: selection.optionId,
      lifetime: selection.lifetime,
      actorId: "inline-broker",
      decidedAt: Date.now(),
    };
  }

  private denial(
    req: PermissionRequest,
    reason: string,
    message?: string,
  ): PermissionDecision {
    return {
      approved: false,
      requestId: req.requestId,
      actionDigest: req.actionDigest,
      actorId: "inline-broker",
      reason: message ?? reason,
      decidedAt: Date.now(),
    };
  }
}

/** `--yes` means never-ask; it does NOT change the execution boundary. */
export function yesFlagToApprovalMode(yes: boolean): "manual" | "never" {
  return yes ? "never" : "manual";
}
