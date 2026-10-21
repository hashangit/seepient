/**
 * Compile-time enforcement pins for the S05 application contracts (spec 029,
 * M02 T010–T014). The load-bearing invariants here are TYPE-LEVEL: each
 * `@ts-expect-error` is self-verifying (the test suite fails to compile if the
 * guaranteed error stops firing, and fails at runtime if the negative
 * assertion is removed without the error firing).
 */

import { describe, expect, it } from "vitest";
import {
  type AssistantHandleRef,
  type DisplayName,
  type OpenAssistantHandle,
  type OpenRunHandle,
  type OrgSpaceId,
  type PrincipalId,
  type ResolvedPrincipalContext,
  type RunId,
  TRUSTED_RESOLUTION,
} from "../identity.js";
import {
  DEFAULT_APP_CONTEXT_STRATEGY,
  type AppRunModel,
  type AppRuntimeEvent,
  type AppUsage,
} from "../runtime-translation.js";
import {
  type PermissionDecision,
  type PermissionDecisionRequest,
  type UserInputAnswer,
  type UserInputRequest,
  isPermissionDecisionRequest,
  isUserInputRequest,
} from "../requests.js";
import {
  AppStorePorts,
  type ObservationalHooksPort,
  type ObservationalPortIsNotAStorePort,
  STORE_PORT_OPERATIONS,
} from "../store-ports.js";

const principalId = "p1" as PrincipalId;
const orgSpaceId = "org1" as OrgSpaceId;
const runId = "r1" as RunId;

describe("identity (T010)", () => {
  it("keeps identity nominal — plain strings and display names are not identities", () => {
    const requireId = (id: PrincipalId) => id;
    // @ts-expect-error identity is nominal: a plain string is not a PrincipalId
    expect(requireId("p1")).toBe("p1");

    const displayName = "Ada" as DisplayName;
    // @ts-expect-error display names are never identity
    const _neverAnId: PrincipalId = displayName;
    void _neverAnId;
  });

  it("requires membership resolution before a handle opens (resolution order)", () => {
    const openAssistant: OpenAssistantHandle = (context, assistantId) =>
      `${context.principalId}:${assistantId}` as AssistantHandleRef;
    const openRun: OpenRunHandle = (context, rid) => `${context.principalId}:${rid}` as never;

    // @ts-expect-error a context without the verification mark is not ResolvedPrincipalContext
    openAssistant({ principalId, orgSpaceId }, "a1" as never);
    // @ts-expect-error an unresolved principal cannot open a run handle either
    openRun({ principalId, orgSpaceId, verified: true } as ResolvedPrincipalContext, runId);

    // The mark cannot be minted honestly; fabrication requires a deliberate double cast, which the negative assertion above pins.
    const verified = { verified: true } as unknown as ResolvedPrincipalContext["verified"];
    const context: ResolvedPrincipalContext = { principalId, orgSpaceId, verified };
    expect(openAssistant(context, "a1" as never)).toBe("p1:a1");
  });

  it("carries the 14 trusted-resolution rows", () => {
    expect(Object.keys(TRUSTED_RESOLUTION)).toHaveLength(14);
  });
});

describe("runtime translation (T011)", () => {
  it("keeps usage null-means-unknown and checkpoint opaque", () => {
    const usage: AppUsage = { inputTokens: null, outputTokens: null };
    expect(usage.inputTokens).toBeNull();

    const events: AppRuntimeEvent[] = [
      { type: "text", text: "hi" },
      { type: "checkpoint", blob: "opaque-opaque" },
      { type: "usage", inputTokens: null, outputTokens: 3, provider: "x", model: "y" },
    ];
    expect(events).toHaveLength(3);
    expect(DEFAULT_APP_CONTEXT_STRATEGY).toBe("retrieval");
  });

  it("keeps the model connection credential optional (D7 — normal provider runtime supplies it)", () => {
    const model: AppRunModel = { provider: "opencode", id: "claude-x" };
    expect(model.apiKey).toBeUndefined();
  });
});

describe("request discriminants (T012)", () => {
  const request: UserInputRequest = {
    kind: "user-input",
    principalId,
    runId,
    requestId: "req1" as never,
    operationRef: "op1" as never,
    mode: "choice",
    text: "Pick one",
    actions: [{ id: "a1", label: "One" }],
  };

  it("narrows the two families disjointly", () => {
    expect(isUserInputRequest(request)).toBe(true);
    expect(isPermissionDecisionRequest(request)).toBe(false);
  });

  it("rejects a user-input answer without its binding envelope", () => {
    // @ts-expect-error AnswerBinding fields are required at construction
    const _unbound: UserInputAnswer = { mode: "choice", selectedActionId: "a1" };
    void _unbound;

    const bound: UserInputAnswer = {
      principalId,
      runId,
      requestId: request.requestId,
      operationRef: request.operationRef,
      digestOrVersion: "sha256:abc",
      mode: "choice",
      selectedActionId: "a1",
    };
    expect(bound.selectedActionId).toBe("a1");
  });

  it("keeps permission decisions incapable of carrying input payloads", () => {
    const bound: UserInputAnswer = {
      principalId,
      runId,
      requestId: "req1" as never,
      operationRef: "op1" as never,
      digestOrVersion: "sha256:abc",
      mode: "secret-answer",
      secret: "hunter2",
    };
    // @ts-expect-error an approval boolean can never carry a user-input payload
    const _smuggled: PermissionDecision = bound;
    void _smuggled;

    const decision: PermissionDecision = { kind: "deny", reason: "policy" };
    expect(decision.kind).toBe("deny");
  });

  it("types the permission request family separately", () => {
    const permissionRequest: PermissionDecisionRequest = {
      kind: "permission-decision",
      principalId,
      runId,
      requestId: "req2" as never,
      operationRef: "op2" as never,
      summary: "Run rm -rf in workspace",
    };
    expect(permissionRequest.kind).toBe("permission-decision");
  });
});

describe("store ports (T013)", () => {
  it("classifies every port operation awaited-required", () => {
    expect(Object.values(STORE_PORT_OPERATIONS).every((c) => c === "awaited-required")).toBe(true);
  });

  it("keeps observational hooks from standing in for a store port", () => {
    const guard: ObservationalPortIsNotAStorePort = true;
    expect(guard).toBe(true);

    const hooks: ObservationalHooksPort = { onProgress: () => {} };
    // The type-level statement, spelled out: hooks are not AppStorePorts.
    const _notAssignable: ObservationalHooksPort extends AppStorePorts ? never : true = guard;
    void hooks;
    void _notAssignable;
  });
});
