import type {
  ActionAuditEvent,
  AuditStore,
  PolicyStore,
  PolicySnapshot,
} from "../../foundations/contracts/execution-brokers.js";
import type {
  CapabilitySet,
  DecisionAuthority,
  Capability,
} from "../../foundations/contracts/permission-policy.js";
import type {
  CapabilityLedger,
  CapabilityLedgerScope,
  RevokeFilter,
} from "../../foundations/contracts/capability-ledger.js";
import { PolicyConflictError } from "../../foundations/errors.js";

/**
 * In-memory AuditStore implementing AuditStore with isolated stamp.
 * Used as the zero-ambient default for multi-tenant server boot and tests.
 */
export class InMemoryAuditStore implements AuditStore {
  readonly isIsolated = true;
  private readonly appends: Array<{ event: ActionAuditEvent; idempotencyKey: string }> = [];
  private readonly seenKeys = new Set<string>();
  private readonly terminalEvents = new Map<string, ActionAuditEvent>();

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

/**
 * In-memory PolicyStore implementing PolicyStore with isolated stamp.
 * Scopes reads by principal in multi-tenant mode; enforces optimistic concurrency versioning.
 */
export class InMemoryPolicyStore implements PolicyStore {
  readonly isIsolated = true;
  private readonly snapshots = new Map<string, PolicySnapshot>();

  async read(
    workspaceId: string,
    opts?: { principalId?: string; tenancyMode?: "single" | "multi" },
  ): Promise<PolicySnapshot> {
    const existing = this.snapshots.get(workspaceId);
    let snap: PolicySnapshot;
    if (existing) {
      snap = { ...existing, policy: { ...existing.policy, capabilities: [...existing.policy.capabilities] } };
    } else {
      snap = {
        workspaceId,
        version: 0,
        policyDigest: "empty",
        policy: { version: 1, capabilities: [] },
        mutationHistory: [],
      };
    }
    if (opts?.principalId) {
      const isMulti = opts.tenancyMode === "multi";
      const isDefaultSingleUser = !isMulti;
      const filtered = snap.policy.capabilities.filter((cap: Capability) => {
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
      policyDigest: `digest-${current.version + 1}`,
      policy: { version: next.version ?? 1, capabilities: [...next.capabilities] },
      grantedBy: actor,
      grantedAt: Date.now(),
      mutationId: mutation?.mutationId,
      mutationHistory: history,
    };
    this.snapshots.set(workspaceId, nextSnapshot);
    return nextSnapshot;
  }

  clear(): void {
    this.snapshots.clear();
  }
}

/**
 * In-memory CapabilityLedger with consumption & revocation tracking and isolated stamp.
 */
export class InMemoryCapabilityLedger implements CapabilityLedger {
  readonly isIsolated = true;
  private readonly consumedDigestsByPrincipal = new Map<string, Set<string>>();
  private readonly consumedEnvelopesByPrincipal = new Map<string, Set<string>>();
  private readonly revokedRunsByPrincipal = new Map<string, Set<string>>();
  private readonly revokedSessionsByPrincipal = new Map<string, Set<string>>();

  private getPrincipal(scope?: CapabilityLedgerScope): string {
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

  async load(scope?: CapabilityLedgerScope): Promise<void> {
    // In-memory ledger is already ready
  }

  async consume(
    envelopeId: string,
    actionDigest: string,
    scope?: CapabilityLedgerScope,
  ): Promise<boolean> {
    const principal = this.getPrincipal(scope);
    const digests = this.getSet(this.consumedDigestsByPrincipal, principal);
    const envelopes = this.getSet(this.consumedEnvelopesByPrincipal, principal);
    if (digests.has(actionDigest)) {
      return false;
    }
    digests.add(actionDigest);
    envelopes.add(envelopeId);
    return true;
  }

  async revoke(filter: RevokeFilter, scope?: CapabilityLedgerScope): Promise<void> {
    const principal = this.getPrincipal(scope);
    if (filter.runId) {
      this.getSet(this.revokedRunsByPrincipal, principal).add(filter.runId);
    }
    if (filter.sessionId) {
      this.getSet(this.revokedSessionsByPrincipal, principal).add(filter.sessionId);
    }
  }

  isConsumedDigest(actionDigest: string, scope?: CapabilityLedgerScope): boolean {
    const principal = this.getPrincipal(scope);
    return this.getSet(this.consumedDigestsByPrincipal, principal).has(actionDigest);
  }

  isRunRevoked(runId: string, scope?: CapabilityLedgerScope): boolean {
    const principal = this.getPrincipal(scope);
    return this.getSet(this.revokedRunsByPrincipal, principal).has(runId);
  }

  isSessionRevoked(sessionId: string, scope?: CapabilityLedgerScope): boolean {
    const principal = this.getPrincipal(scope);
    return this.getSet(this.revokedSessionsByPrincipal, principal).has(sessionId);
  }

  clear(): void {
    this.consumedDigestsByPrincipal.clear();
    this.consumedEnvelopesByPrincipal.clear();
    this.revokedRunsByPrincipal.clear();
    this.revokedSessionsByPrincipal.clear();
  }
}
