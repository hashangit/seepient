/**
 * In-memory test doubles for Spec 021 store injection contracts.
 *
 * Implements AuditStore, PolicyStore, CapabilityLedger, PersistenceBackend,
 * and createFakeRuntime for unit and integration testing without disk I/O.
 */

import type {
  AuditStore,
  ActionAuditEvent,
  PolicyStore,
  PolicySnapshot,
} from "../../../../foundations/contracts/execution-brokers.js";
import type {
  CapabilityLedger,
  RevokeFilter,
} from "../../../../foundations/contracts/capability-ledger.js";
import type {
  CapabilitySet,
  DecisionAuthority,
} from "../../../../foundations/contracts/permission-policy.js";
import type {
  PersistenceBackend,
  SessionData,
} from "../../../../foundations/types.js";
import { PolicyConflictError } from "../../../../foundations/errors.js";
import { ProviderRuntime } from "../../../../domain/providers/provider-runtime.js";
import { ProviderConfigStore } from "../../../../domain/providers/config-store/provider-config-store.js";
import { CompositeCredentialStore } from "../../../../domain/providers/credentials/composite-credential-store.js";
import { MemoryCredentialStore } from "../../../../domain/providers/credentials/memory-credential-store.js";
import { ModelCatalog } from "../../../../domain/providers/model-catalog.js";
import {
  createMockRuntime,
  type MockStepResponse,
} from "../../../../domain/__tests__/test-doubles.js";

/** In-memory AuditStore with call recording and idempotency dedup. */
export class FakeAuditStore implements AuditStore {
  readonly isIsolated = true;
  readonly appends: Array<{ event: ActionAuditEvent; idempotencyKey: string }> = [];
  readonly seenKeys = new Set<string>();
  readonly terminalEvents = new Map<string, ActionAuditEvent>();

  async append(
    event: ActionAuditEvent,
    opts: { idempotencyKey: string },
  ): Promise<"written" | "duplicate"> {
    if (this.seenKeys.has(opts.idempotencyKey)) {
      return "duplicate";
    }
    this.seenKeys.add(opts.idempotencyKey);
    this.appends.push({ event: { ...event }, idempotencyKey: opts.idempotencyKey });
    if (
      event.state === "succeeded" ||
      event.state === "failed" ||
      event.state === "cancelled" ||
      event.state === "denied" ||
      event.state === "approval-denied" ||
      event.state === "approval-expired" ||
      event.state === "indeterminate"
    ) {
      this.terminalEvents.set(event.actionId, event);
    }
    return "written";
  }

  async getTerminal(actionId: string): Promise<ActionAuditEvent | undefined> {
    return this.terminalEvents.get(actionId);
  }

  clear(): void {
    this.appends.length = 0;
    this.seenKeys.clear();
    this.terminalEvents.clear();
  }
}

/** In-memory PolicyStore with compare-and-set version tracking. */
export class FakePolicyStore implements PolicyStore {
  readonly isIsolated = true;
  readonly snapshots = new Map<string, PolicySnapshot>();
  readonly calls: Array<{
    type: "read" | "compareAndSet";
    workspaceId: string;
    expectedVersion?: number;
    next?: CapabilitySet;
    actor?: DecisionAuthority;
    mutation?: { mutationId: string };
  }> = [];

  async read(
    workspaceId: string,
    opts?: { principalId?: string; tenancyMode?: "single" | "multi" },
  ): Promise<PolicySnapshot> {
    this.calls.push({ type: "read", workspaceId });
    const existing = this.snapshots.get(workspaceId);
    let snap: PolicySnapshot;
    if (existing) {
      snap = { ...existing, policy: { ...existing.policy, capabilities: [...existing.policy.capabilities] } };
    } else {
      snap = {
        workspaceId,
        version: 0,
        policyDigest: "fake-digest-0",
        policy: { version: 1, capabilities: [] },
        mutationHistory: [],
      };
    }
    if (opts?.principalId) {
      const isMulti = opts.tenancyMode === "multi";
      const isDefaultSingleUser = !isMulti;
      const filtered = snap.policy.capabilities.filter((cap) => {
        if (cap.principalId) return cap.principalId === opts.principalId;
        return isDefaultSingleUser;
      });
      return { ...snap, policy: { ...snap.policy, capabilities: filtered } };
    }
    return snap;
  }

  async compareAndSet(
    workspaceId: string,
    expectedVersion: number,
    next: CapabilitySet,
    actor: DecisionAuthority,
    mutation?: { mutationId: string },
  ): Promise<PolicySnapshot> {
    this.calls.push({
      type: "compareAndSet",
      workspaceId,
      expectedVersion,
      next,
      actor,
      mutation,
    });
    const current = await this.read(workspaceId);
    if (current.version !== expectedVersion) {
      throw new PolicyConflictError(
        `Policy conflict for workspace ${workspaceId}: expected version ${expectedVersion}, got ${current.version}`,
        { workspaceId, expectedVersion, actualVersion: current.version },
      );
    }
    const history = [...(current.mutationHistory ?? [])];
    if (mutation?.mutationId) {
      history.push({ mutationId: mutation.mutationId, version: current.version + 1 });
    }
    const nextSnapshot: PolicySnapshot = {
      workspaceId,
      version: current.version + 1,
      policyDigest: `fake-digest-${current.version + 1}`,
      policy: { version: next.version ?? 1, capabilities: [...next.capabilities] },
      grantedBy: actor,
      grantedAt: Date.now(),
      mutationId: mutation?.mutationId,
      mutationHistory: history,
    };
    this.snapshots.set(workspaceId, nextSnapshot);
    return nextSnapshot;
  }
}

/** In-memory CapabilityLedger with consumption & revocation tracking. */
export class FakeCapabilityLedger implements CapabilityLedger {
  readonly isIsolated = true;
  readonly consumedDigests = new Set<string>();
  readonly consumedEnvelopes = new Set<string>();
  readonly revokedRuns = new Set<string>();
  readonly revokedSessions = new Set<string>();
  readonly consumedDigestsByPrincipal = new Map<string, Set<string>>();
  readonly consumedEnvelopesByPrincipal = new Map<string, Set<string>>();
  readonly revokedRunsByPrincipal = new Map<string, Set<string>>();
  readonly revokedSessionsByPrincipal = new Map<string, Set<string>>();
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  private getPrincipal(scope?: import("../../../../foundations/contracts/capability-ledger.js").CapabilityLedgerScope): string {
    return scope?.principalId ?? "default";
  }

  private getSet(map: Map<string, Set<string>>, principalId: string): Set<string> {
    let set = map.get(principalId);
    if (!set) {
      set = new Set<string>();
      map.set(principalId, set);
    }
    return set;
  }

  async load(scope?: import("../../../../foundations/contracts/capability-ledger.js").CapabilityLedgerScope): Promise<void> {
    this.calls.push({ method: "load", args: [scope] });
  }

  async consume(
    envelopeId: string,
    actionDigest: string,
    scope?: import("../../../../foundations/contracts/capability-ledger.js").CapabilityLedgerScope,
  ): Promise<boolean> {
    this.calls.push({ method: "consume", args: [envelopeId, actionDigest, scope] });
    const principal = this.getPrincipal(scope);
    const digests = this.getSet(this.consumedDigestsByPrincipal, principal);
    const envelopes = this.getSet(this.consumedEnvelopesByPrincipal, principal);
    if (digests.has(actionDigest)) {
      return false;
    }
    digests.add(actionDigest);
    envelopes.add(envelopeId);
    this.consumedDigests.add(actionDigest);
    this.consumedEnvelopes.add(envelopeId);
    return true;
  }

  async revoke(
    filter: RevokeFilter,
    scope?: import("../../../../foundations/contracts/capability-ledger.js").CapabilityLedgerScope,
  ): Promise<void> {
    this.calls.push({ method: "revoke", args: [filter, scope] });
    const principal = this.getPrincipal(scope);
    if (filter.runId) {
      this.getSet(this.revokedRunsByPrincipal, principal).add(filter.runId);
      this.revokedRuns.add(filter.runId);
    }
    if (filter.sessionId) {
      this.getSet(this.revokedSessionsByPrincipal, principal).add(filter.sessionId);
      this.revokedSessions.add(filter.sessionId);
    }
  }

  isConsumedDigest(
    actionDigest: string,
    scope?: import("../../../../foundations/contracts/capability-ledger.js").CapabilityLedgerScope,
  ): boolean {
    const principal = this.getPrincipal(scope);
    return this.getSet(this.consumedDigestsByPrincipal, principal).has(actionDigest);
  }

  isRunRevoked(
    runId: string,
    scope?: import("../../../../foundations/contracts/capability-ledger.js").CapabilityLedgerScope,
  ): boolean {
    const principal = this.getPrincipal(scope);
    return this.getSet(this.revokedRunsByPrincipal, principal).has(runId);
  }

  isSessionRevoked(
    sessionId: string,
    scope?: import("../../../../foundations/contracts/capability-ledger.js").CapabilityLedgerScope,
  ): boolean {
    const principal = this.getPrincipal(scope);
    return this.getSet(this.revokedSessionsByPrincipal, principal).has(sessionId);
  }
}

/** Recording in-memory PersistenceBackend tracking save/load/delete calls. */
export class RecordingPersistenceBackend implements PersistenceBackend {
  readonly isIsolated = true;
  readonly __persistenceBackend = true as const;
  readonly store = new Map<string, SessionData>();
  readonly saves: Array<{ id: string; data: SessionData }> = [];
  readonly loads: string[] = [];
  readonly deletes: string[] = [];
  readonly lists: number[] = [];

  async save(id: string, data: SessionData): Promise<void> {
    this.saves.push({ id, data: JSON.parse(JSON.stringify(data)) });
    this.store.set(id, { ...data, messages: [...data.messages] });
  }

  async load(id: string): Promise<SessionData | null> {
    this.loads.push(id);
    const item = this.store.get(id);
    if (!item) return null;
    return JSON.parse(JSON.stringify(item));
  }

  async delete(id: string): Promise<void> {
    this.deletes.push(id);
    this.store.delete(id);
  }

  async list(): Promise<string[]> {
    this.lists.push(Date.now());
    return Array.from(this.store.keys());
  }

  clear(): void {
    this.store.clear();
    this.saves.length = 0;
    this.loads.length = 0;
    this.deletes.length = 0;
    this.lists.length = 0;
  }
}

/**
 * Build a ProviderRuntime using in-memory stores and a mock inference adapter.
 */
export function createFakeRuntime(opts?: {
  responses?: MockStepResponse[] | ((req: any) => MockStepResponse);
  configStore?: ProviderConfigStore;
  credentialStore?: CompositeCredentialStore | MemoryCredentialStore;
}): ProviderRuntime {
  if (opts?.responses && !opts.configStore && !opts.credentialStore) {
    return createMockRuntime(opts.responses);
  }

  const configStore = opts?.configStore ?? new ProviderConfigStore(":memory:");
  if (!(configStore as any).currentOverlay?.patch?.modelAssignments) {
    (configStore as any).currentOverlay = {
      revision: 1,
      updatedAt: new Date().toISOString(),
      patch: {
        providers: {
          "mock-account": {
            adapter: "pi-ai",
            upstreamProvider: "mock-account",
            credential: { kind: "none" },
          },
        },
        modelAssignments: {
          text: {
            standard: {
              providerAccount: "mock-account",
              model: "mock-model",
            },
          },
        },
      },
    };
  }

  const memoryCreds = new MemoryCredentialStore();
  const credentialStore =
    opts?.credentialStore instanceof CompositeCredentialStore
      ? opts.credentialStore
      : new CompositeCredentialStore({
          memory: opts?.credentialStore instanceof MemoryCredentialStore ? opts.credentialStore : memoryCreds,
          primaryWriteStore: "memory",
        });

  if (opts?.responses) {
    const mock = createMockRuntime(opts.responses);
    return new ProviderRuntime({
      configStore,
      credentialStore,
      modelCatalog: mock.modelCatalog,
      adapter: mock.adapter,
    });
  }

  return new ProviderRuntime({
    configStore,
    credentialStore,
    modelCatalog: new ModelCatalog([]),
  });
}
