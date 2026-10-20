/**
 * Application Identity Contracts — Foundations (spec 029, M02 S05, FR-008/FR-009).
 *
 * Implements the authoritative 14-ID identity map (vault
 * `contracts/app-contracts.md` §2, decision D8). Pure and renderer-safe: no
 * runtime DB clients, no UI components, no upward imports.
 *
 * Invariants enforced at the TYPE level (runtime validation happens at the
 * ingestion edges that mint these values):
 *
 * 1. Identity is nominal. Plain `string` is not assignable to any `*Id` type.
 * 2. Display names are a distinct branded type and are NEVER authorization
 *    identity: `DisplayName` is not assignable to any ID parameter and no ID is
 *    assignable to `DisplayName`.
 * 3. External keys are immutable once issued (`readonly`, per-kind branded).
 * 4. Membership resolution precedes opening any run/artifact/memory/connection/
 *    assistant handle: every handle-opening signature takes
 *    `ResolvedPrincipalContext` as its first parameter, and that context can
 *    only be produced by membership resolution (`MembershipVerified` is not
 *    constructible by callers).
 */

declare const __idBrand: unique symbol;
declare const __nameBrand: unique symbol;
declare const __keyBrand: unique symbol;
declare const __verified: unique symbol;

/** Nominal identity mark. One brand name per ID kind. */
export type IdBrand<K extends string> = string & { readonly [__idBrand]: K };

/**
 * Human-visible label (assistant name, project title, bot display name…).
 * Deliberately disjoint from every ID type: never a lookup key, never an
 * authorization input, never persisted as identity.
 */
export type DisplayName = string & { readonly [__nameBrand]: "DisplayName" };

/** Immutable external key for identity kind `K` (issued once, never rotated into a different subject). */
export type ExternalKey<K extends IdKind> = string & { readonly [__keyBrand]: K };

/**
 * The 14 identity kinds (D8 table, FR-009). `organization`/`space` share one
 * resolution (membership lookup from principal context) and one external-key
 * namespace; `session`/`thread` likewise (preserved upstream thread ID).
 */
export type IdKind =
  | "principal"
  | "organizationSpace"
  | "assistant"
  | "project"
  | "membership"
  | "session"
  | "run"
  | "attempt"
  | "toolCall"
  | "execution"
  | "approval"
  | "effect"
  | "usageCall"
  | "delivery";

export type PrincipalId = IdBrand<"principal">;
export type OrgSpaceId = IdBrand<"organizationSpace">;
export type AssistantId = IdBrand<"assistant">;
export type ProjectId = IdBrand<"project">;
export type MembershipId = IdBrand<"membership">;
export type SessionId = IdBrand<"session">;
export type RunId = IdBrand<"run">;
export type AttemptId = IdBrand<"attempt">;
export type ToolCallId = IdBrand<"toolCall">;
export type ExecutionId = IdBrand<"execution">;
export type ApprovalId = IdBrand<"approval">;
export type EffectId = IdBrand<"effect">;
export type UsageCallId = IdBrand<"usageCall">;
export type DeliveryId = IdBrand<"delivery">;

/** Ergonomic aliases over the shared kinds (D8 rows 2 and 6). */
export type OrganizationId = OrgSpaceId;
export type SpaceId = OrgSpaceId;
export type ThreadId = SessionId;

/**
 * Trusted resolution source per identity kind (D8 column 3). Descriptive
 * metadata for reviewers and ingestion edges — the enforcement is the branded
 * types plus the resolution-order signatures below.
 */
export const TRUSTED_RESOLUTION: Readonly<Record<IdKind, string>> = {
  principal: "authenticated server context",
  organizationSpace: "membership lookup from principal context",
  assistant: "catalog lookup post-membership (≠ principal, ≠ model account)",
  project: "membership service (vocabulary only)",
  membership: "membership service (vocabulary only)",
  session: "thread store post-membership (preserved upstream thread ID)",
  run: "run supervisor records (preserved upstream run ID)",
  attempt: "run supervisor records (preserved upstream attempt ID)",
  toolCall: "governed-operation records (correlation ID)",
  execution: "governed-operation records (correlation ID)",
  approval: "Seepient-issued request linked to the adopted waiting record",
  effect: "external-effect record",
  usageCall: "per-call settlement record",
  delivery: "outbound delivery record",
} as const;

/**
 * Proof mark produced exclusively by membership resolution. Callers cannot
 * construct it (the brand key is module-private); a `ResolvedPrincipalContext`
 * therefore cannot be fabricated without going through resolution.
 */
export type MembershipVerified = { readonly [__verified]: "membership-verified" };

/**
 * Principal context AFTER membership resolution. This is the mandatory first
 * parameter of every handle-opening operation: membership resolution precedes
 * opening any run/artifact/memory/connection/assistant handle (D8 rule 1).
 */
export interface ResolvedPrincipalContext {
  readonly principalId: PrincipalId;
  readonly orgSpaceId: OrgSpaceId;
  readonly verified: MembershipVerified;
}

/** Opaque handle references — obtainable ONLY through the openers below. */
export type AssistantHandleRef = IdBrand<"assistantHandle">;
export type RunHandleRef = IdBrand<"runHandle">;

/**
 * Handle-opening signatures. A caller holding only display names, raw strings,
 * or an unresolved principal cannot name the first parameter — the type error
 * IS the resolution-order rule.
 */
export type OpenAssistantHandle = (
  context: ResolvedPrincipalContext,
  assistantId: AssistantId,
) => AssistantHandleRef;
export type OpenRunHandle = (context: ResolvedPrincipalContext, runId: RunId) => RunHandleRef;

/**
 * Identity record as carried across surfaces: kind, minted ID, its immutable
 * external key, and a display name that is metadata, never the key.
 */
export interface IdentityRecord<K extends IdKind = IdKind> {
  readonly kind: K;
  readonly id: IdBrand<K>;
  readonly externalKey: ExternalKey<K>;
  readonly displayName: DisplayName;
}
