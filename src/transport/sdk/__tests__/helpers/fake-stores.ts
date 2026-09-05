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
  readonly snapshots = new Map<string, PolicySnapshot>();
  readonly calls: Array<{
    type: "read" | "compareAndSet";
    workspaceId: string;
    expectedVersion?: number;
    next?: CapabilitySet;
    actor?: DecisionAuthority;
    mutation?: { mutationId: string };
  }> = [];

  async read(workspaceId: string): Promise<PolicySnapshot> {
    this.calls.push({ type: "read", workspaceId });
    const existing = this.snapshots.get(workspaceId);
    if (existing) return { ...existing, policy: { ...existing.policy, capabilities: [...existing.policy.capabilities] } };
    const initial: PolicySnapshot = {
      workspaceId,
      version: 0,
      policyDigest: "fake-digest-0",
      policy: { version: 1, capabilities: [] },
      mutationHistory: [],
    };
    return initial;
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
  readonly consumedDigests = new Set<string>();
  readonly consumedEnvelopes = new Set<string>();
  readonly revokedRuns = new Set<string>();
  readonly revokedSessions = new Set<string>();
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  async load(): Promise<void> {
    this.calls.push({ method: "load", args: [] });
  }

  async consume(envelopeId: string, actionDigest: string): Promise<boolean> {
    this.calls.push({ method: "consume", args: [envelopeId, actionDigest] });
    if (this.consumedDigests.has(actionDigest)) {
      return false;
    }
    this.consumedDigests.add(actionDigest);
    this.consumedEnvelopes.add(envelopeId);
    return true;
  }

  async revoke(filter: RevokeFilter): Promise<void> {
    this.calls.push({ method: "revoke", args: [filter] });
    if (filter.runId) this.revokedRuns.add(filter.runId);
    if (filter.sessionId) this.revokedSessions.add(filter.sessionId);
  }

  isConsumedDigest(actionDigest: string): boolean {
    return this.consumedDigests.has(actionDigest);
  }

  isRunRevoked(runId: string): boolean {
    return this.revokedRuns.has(runId);
  }

  isSessionRevoked(sessionId: string): boolean {
    return this.revokedSessions.has(sessionId);
  }
}

/** Recording in-memory PersistenceBackend tracking save/load/delete calls. */
export class RecordingPersistenceBackend implements PersistenceBackend {
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
