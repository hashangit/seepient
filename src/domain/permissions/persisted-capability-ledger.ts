/**
 * Persisted capability ledger — Domain (spec 008, T107a, FR-005/NFR-003).
 *
 * Tracks consumed action-scoped envelopes and revoked run/session grants in
 * a durable NDJSON file under `~/.seepient/security/caps/` with the same
 * atomic write discipline (tmp + fsync + rename, 0o600/0o700) as the audit
 * store.
 *
 * Rules (from data-model.md authority-consumption table):
 *   action  — CapabilityStore.consume(envelopeId, actionDigest) before dispatch;
 *             replay of a consumed actionDigest → capability-expired.
 *   run     — revoke(runId, …) marks the run revoked; expired (expiresAt ≤ now)
 *             or revoked run grants fail closed with capability-revoked /
 *             capability-expired before policy offers them.
 *   session — same fail-closed rule as run.
 *
 * Hard rule: action/run/session grants are NEVER placed into
 * principalPolicy/runtimeBaseline/deploymentCeiling.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type {
  CapabilityLedger,
  CapabilityLedgerScope,
  RevokeFilter,
} from "../../foundations/contracts/capability-ledger.js";

export type { RevokeFilter, CapabilityLedger, CapabilityLedgerScope };

/** A ledger entry — either a consumed action or a revoked run/session. */
type LedgerEntry =
  | {
      kind: "consumed-action";
      envelopeId: string;
      actionDigest: string;
      consumedAt: number;
    }
  | {
      kind: "revoked-run";
      runId: string;
      revokedAt: number;
    }
  | {
      kind: "revoked-session";
      sessionId: string;
      revokedAt: number;
    };

/**
 * Persisted capability ledger. Backed by an append-only NDJSON file with
 * fsync on every append; the in-memory index is rebuilt on startup.
 *
 * `consume()` and `revoke()` are the only mutation paths. Lookups are
 * synchronous after load() completes.
 */
export class PersistedCapabilityLedger implements CapabilityLedger {
  private readonly dir: string;
  private readonly consumedDigestsByPrincipal = new Map<string, Set<string>>();
  private readonly consumedEnvelopesByPrincipal = new Map<string, Set<string>>();
  private readonly revokedRunsByPrincipal = new Map<string, Set<string>>();
  private readonly revokedSessionsByPrincipal = new Map<string, Set<string>>();
  private readonly defaultPrincipalId: string;

  constructor(opts?: { root?: string; defaultPrincipalId?: string }) {
    this.dir =
      opts?.root ??
      (process.env.SEEPIENT_SECURITY_DIR
        ? path.join(process.env.SEEPIENT_SECURITY_DIR, "caps")
        : path.join(os.homedir(), ".seepient", "security", "caps"));
    this.defaultPrincipalId = opts?.defaultPrincipalId ?? "default";
  }

  private getPrincipal(scope?: CapabilityLedgerScope): string {
    return scope?.principalId ?? this.defaultPrincipalId;
  }

  private getPrincipalDir(principalId: string): string {
    return path.join(this.dir, principalId);
  }

  /** Path builder for caps/<principalId>/ledger.ndjson (Spec 022 T026) */
  private getFileForPrincipal(principalId: string): string {
    return path.join(this.dir, principalId, "ledger.ndjson");
  }

  private getLockForPrincipal(principalId: string): string {
    return path.join(this.dir, principalId, "ledger.ndjson.lock");
  }

  private getPrincipalSets(principalId: string) {
    let digests = this.consumedDigestsByPrincipal.get(principalId);
    if (!digests) {
      digests = new Set<string>();
      this.consumedDigestsByPrincipal.set(principalId, digests);
    }
    let envelopes = this.consumedEnvelopesByPrincipal.get(principalId);
    if (!envelopes) {
      envelopes = new Set<string>();
      this.consumedEnvelopesByPrincipal.set(principalId, envelopes);
    }
    let runs = this.revokedRunsByPrincipal.get(principalId);
    if (!runs) {
      runs = new Set<string>();
      this.revokedRunsByPrincipal.set(principalId, runs);
    }
    let sessions = this.revokedSessionsByPrincipal.get(principalId);
    if (!sessions) {
      sessions = new Set<string>();
      this.revokedSessionsByPrincipal.set(principalId, sessions);
    }
    return { digests, envelopes, runs, sessions };
  }

  private async ensureDir(principalId: string): Promise<void> {
    const pDir = this.getPrincipalDir(principalId);
    await fs.mkdir(pDir, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(pDir, 0o700);
    } catch {
      /* non-fatal */
    }
  }

  /** Load existing ledger from disk for a given principal. Safe to call multiple times. */
  async load(scope?: CapabilityLedgerScope): Promise<void> {
    const principalId = this.getPrincipal(scope);
    await this.ensureDir(principalId);
    const file = this.getFileForPrincipal(principalId);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const sets = this.getPrincipalSets(principalId);
    sets.digests.clear();
    sets.envelopes.clear();
    sets.runs.clear();
    sets.sessions.clear();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        this.applyEntry(entry, principalId);
      } catch {
        /* skip malformed lines */
      }
    }
  }

  private applyEntry(entry: LedgerEntry, principalId: string): void {
    const sets = this.getPrincipalSets(principalId);
    switch (entry.kind) {
      case "consumed-action":
        sets.digests.add(entry.actionDigest);
        sets.envelopes.add(entry.envelopeId);
        break;
      case "revoked-run":
        sets.runs.add(entry.runId);
        break;
      case "revoked-session":
        sets.sessions.add(entry.sessionId);
        break;
    }
  }

  /**
   * Atomically consume an action-scoped envelope for a principal. If the actionDigest has
   * already been consumed by this principal, returns false (replay → capability-expired).
   * Otherwise records the consumption durably and returns true.
   */
  async consume(
    envelopeId: string,
    actionDigest: string,
    scope?: CapabilityLedgerScope,
  ): Promise<boolean> {
    const principalId = this.getPrincipal(scope);
    await this.ensureDir(principalId);
    const file = this.getFileForPrincipal(principalId);
    const lockFile = this.getLockForPrincipal(principalId);
    let lockHandle: fs.FileHandle | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        lockHandle = await fs.open(lockFile, "wx", 0o600);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    if (!lockHandle) {
      return false; // Fail closed if lock acquisition fails
    }
    try {
      await this.load({ principalId });
      const sets = this.getPrincipalSets(principalId);
      if (sets.digests.has(actionDigest)) return false;
      const entry: LedgerEntry = {
        kind: "consumed-action",
        envelopeId,
        actionDigest,
        consumedAt: Date.now(),
      };
      const line = JSON.stringify(entry) + "\n";
      const handle = await fs.open(file, "a", 0o600);
      try {
        await handle.appendFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      sets.digests.add(actionDigest);
      sets.envelopes.add(envelopeId);
      return true;
    } finally {
      if (lockHandle) {
        await lockHandle.close().catch(() => {});
        await fs.unlink(lockFile).catch(() => {});
      }
    }
  }

  /**
   * Revoke a run-scoped or session-scoped grant for a principal.
   */
  async revoke(filter: RevokeFilter, scope?: CapabilityLedgerScope): Promise<void> {
    const principalId = this.getPrincipal(scope);
    const sets = this.getPrincipalSets(principalId);
    if (filter.runId) {
      if (sets.runs.has(filter.runId)) return;
      const entry: LedgerEntry = {
        kind: "revoked-run",
        runId: filter.runId,
        revokedAt: Date.now(),
      };
      await this.appendEntry(entry, principalId);
      sets.runs.add(filter.runId);
    }
    if (filter.sessionId) {
      if (sets.sessions.has(filter.sessionId)) return;
      const entry: LedgerEntry = {
        kind: "revoked-session",
        sessionId: filter.sessionId,
        revokedAt: Date.now(),
      };
      await this.appendEntry(entry, principalId);
      sets.sessions.add(filter.sessionId);
    }
  }

  async verify(
    envelopeId: string,
    actionDigest: string,
    scope?: CapabilityLedgerScope,
  ): Promise<boolean> {
    const principalId = this.getPrincipal(scope);
    return this.isConsumedDigest(actionDigest, { principalId });
  }

  /** True if the actionDigest was already consumed by this principal. */
  isConsumedDigest(actionDigest: string, scope?: CapabilityLedgerScope): boolean {
    const principalId = this.getPrincipal(scope);
    return this.consumedDigestsByPrincipal.get(principalId)?.has(actionDigest) ?? false;
  }

  /** True if the run was revoked for this principal. */
  isRunRevoked(runId: string, scope?: CapabilityLedgerScope): boolean {
    const principalId = this.getPrincipal(scope);
    return this.revokedRunsByPrincipal.get(principalId)?.has(runId) ?? false;
  }

  /** True if the session was revoked for this principal. */
  isSessionRevoked(sessionId: string, scope?: CapabilityLedgerScope): boolean {
    const principalId = this.getPrincipal(scope);
    return this.revokedSessionsByPrincipal.get(principalId)?.has(sessionId) ?? false;
  }

  /** Append one entry atomically: write to tmp → fsync → rename. */
  private async appendEntry(entry: LedgerEntry, principalId: string): Promise<void> {
    await this.ensureDir(principalId);
    const file = this.getFileForPrincipal(principalId);
    const lockFile = this.getLockForPrincipal(principalId);
    let lockHandle: fs.FileHandle | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        lockHandle = await fs.open(lockFile, "wx", 0o600);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try {
      const line = JSON.stringify(entry) + "\n";
      const handle = await fs.open(file, "a", 0o600);
      try {
        await handle.appendFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } finally {
      if (lockHandle) {
        await lockHandle.close().catch(() => {});
        await fs.unlink(lockFile).catch(() => {});
      }
    }
  }
}

/**
 * Validate a run-scoped envelope against the ledger and current time.
 * Returns "ok", "expired", or "revoked".
 */
export function checkRunLifetime(
  runId: string,
  expiresAt: number,
  ledger: CapabilityLedger,
  now: number,
  scope?: CapabilityLedgerScope,
): "ok" | "expired" | "revoked" {
  if (ledger.isRunRevoked(runId, scope)) return "revoked";
  if (expiresAt <= now) return "expired";
  return "ok";
}

/**
 * Validate a session-scoped envelope against the ledger and current time.
 * Returns "ok", "expired", or "revoked".
 */
export function checkSessionLifetime(
  sessionId: string,
  expiresAt: number | undefined,
  ledger: CapabilityLedger,
  now: number,
  scope?: CapabilityLedgerScope,
): "ok" | "expired" | "revoked" {
  if (ledger.isSessionRevoked(sessionId, scope)) return "revoked";
  if (expiresAt !== undefined && expiresAt <= now) return "expired";
  return "ok";
}

/** SHA-256 helper for digest verification. */
export function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}
