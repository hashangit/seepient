/**
 * Application Request Discriminant Contracts — Foundations (spec 029, M02 S05, FR-011).
 *
 * Two request families that are NEVER conflated (vault `contracts/app-contracts.md` §4):
 *
 * - `PermissionDecisionRequest` — governed-operation authorization. The Seepient
 *   Domain policy engine decides (M05 wires enforcement); the answer is a plain
 *   approve/deny and can carry nothing else.
 * - `UserInputRequest` — the runtime needs something from the human. It
 *   discriminates `secret-answer | choice | takeover`, and every answer binds
 *   `{ principalId, runId, requestId, operationRef, digestOrVersion }` at
 *   construction.
 *
 * A boolean-carrying approval can never carry a secret answer, a choice, or a
 * takeover: the decision type and the answer union are structurally disjoint
 * (`PermissionDecision` has no payload fields an `UserInputAnswer` could
 * satisfy, and vice versa), and both request families share only the binding
 * envelope. Constructing an input answer without its binding fields is a
 * compile-time error, not a runtime convention.
 */

import type { ApprovalId, PrincipalId, RunId } from "./identity.js";

/** Correlation reference to the governed operation or input prompt being answered. */
export type OperationRef = string & { readonly __operationRef: "OperationRef" };

/**
 * Binding envelope REQUIRED on every answer (approve, deny, secret, choice,
 * takeover): ties the answer to the principal, the run, the request record,
 * the operation it answers, and the exact payload version digested when
 * presented. Answers without it are unrepresentable.
 */
export interface AnswerBinding {
  readonly principalId: PrincipalId;
  readonly runId: RunId;
  /** The Seepient-issued request record being answered (D8 approval row). */
  readonly requestId: ApprovalId;
  readonly operationRef: OperationRef;
  /** Payload digest or version the answer was given for; stale answers are rejected by the store CAS. */
  readonly digestOrVersion: string;
}

/** Envelope shared by both request families. */
export interface RequestEnvelope {
  readonly principalId: PrincipalId;
  readonly runId: RunId;
  readonly requestId: ApprovalId;
  readonly operationRef: OperationRef;
}

// ---------------------------------------------------------------------------
// Family 1 — permission decisions (governed-operation authorization)
// ---------------------------------------------------------------------------

export interface PermissionDecisionRequest extends RequestEnvelope {
  readonly kind: "permission-decision";
  /** Human-presentable summary of the governed operation. */
  readonly summary: string;
  readonly detail?: string;
}

/**
 * The ONLY answer shape a permission request accepts. A boolean carrier by
 * design — and incapable of carrying input payloads, because it has no fields
 * for them.
 */
export type PermissionDecision = { readonly kind: "approve" } | { readonly kind: "deny"; readonly reason?: string };

// ---------------------------------------------------------------------------
// Family 2 — user input (secret answer | choice | takeover)
// ---------------------------------------------------------------------------

export type UserInputRequest = RequestEnvelope & {
  readonly kind: "user-input";
} & UserInputPrompt;

export type UserInputPrompt =
  | {
      readonly mode: "secret-answer";
      /** Prompt text only — a secret-answer request never carries or echoes a secret. */
      readonly text: string;
    }
  | {
      readonly mode: "choice";
      readonly text: string;
      readonly actions: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    }
  | {
      readonly mode: "takeover";
      readonly text: string;
      readonly reason: string;
    };

/**
 * Answers to a `UserInputRequest`. The `AnswerBinding` intersection makes the
 * five binding fields REQUIRED at construction — an answer literal missing any
 * of them does not type-check. The union is structurally disjoint from
 * `PermissionDecision`: an approval boolean can never carry a secret, a
 * choice, or a takeover.
 */
export type UserInputAnswer = AnswerBinding &
  (
    | { readonly mode: "secret-answer"; readonly secret: string }
    | { readonly mode: "choice"; readonly selectedActionId: string }
    | { readonly mode: "takeover" }
  );

/**
 * Narrowing type guards over the request union (allowed tiny functions: the
 * predicate preserves discriminated-union narrowing at every call site).
 */
export function isPermissionDecisionRequest(
  request: PermissionDecisionRequest | UserInputRequest,
): request is PermissionDecisionRequest {
  return request.kind === "permission-decision";
}

export function isUserInputRequest(
  request: PermissionDecisionRequest | UserInputRequest,
): request is UserInputRequest {
  return request.kind === "user-input";
}
