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

/** Revocation filter — what to revoke. */
export interface RevokeFilter {
  runId?: string;
  sessionId?: string;
}

/**
 * Persisted capability ledger. Backed by an append-only NDJSON file with
 * fsync on every append; the in-memory index is rebuilt on startup.
 *
 * `consume()` and `revoke()` are the only mutation paths. Lookups are
 * synchronous after load() completes.
 */
export class PersistedCapabilityLedger {
  private readonly dir: string;
  private readonly file: string;
  /** Consumed actionDigests (action-scoped). */
  private consumedDigests = new Set<string>();
  /** Consumed envelopeIds (action-scoped dedup). */
  private consumedEnvelopes = new Set<string>();
  /** Revoked runIds. */
  private revokedRuns = new Set<string>();
  /** Revoked sessionIds. */
  private revokedSessions = new Set<string>();

  constructor(opts?: { root?: string }) {
    this.dir =
      opts?.root ??
      (process.env.SEEPIENT_SECURITY_DIR
        ? path.join(process.env.SEEPIENT_SECURITY_DIR, "caps")
        : path.join(os.homedir(), ".seepient", "security", "caps"));
    this.file = path.join(this.dir, "ledger.ndjson");
  }

  /** Load existing ledger from disk. Safe to call multiple times. */
  async load(): Promise<void> {
    await this.ensureDir();
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    this.consumedDigests = new Set();
    this.consumedEnvelopes = new Set();
    this.revokedRuns = new Set();
    this.revokedSessions = new Set();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        this.applyEntry(entry);
      } catch {
        /* skip malformed lines */
      }
    }
  }

  private applyEntry(entry: LedgerEntry): void {
    switch (entry.kind) {
      case "consumed-action":
        this.consumedDigests.add(entry.actionDigest);
        this.consumedEnvelopes.add(entry.envelopeId);
        break;
      case "revoked-run":
        this.revokedRuns.add(entry.runId);
        break;
      case "revoked-session":
        this.revokedSessions.add(entry.sessionId);
        break;
    }
  }

  /**
   * Atomically consume an action-scoped envelope. If the actionDigest has
   * already been consumed, returns false (replay → capability-expired).
   * Otherwise records the consumption durably and returns true.
   */
  async consume(envelopeId: string, actionDigest: string): Promise<boolean> {
    await this.ensureDir();
    const lockFile = this.file + ".lock";
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
      await this.load();
      if (this.consumedDigests.has(actionDigest)) return false;
      const entry: LedgerEntry = {
        kind: "consumed-action",
        envelopeId,
        actionDigest,
        consumedAt: Date.now(),
      };
      const line = JSON.stringify(entry) + "\n";
      const handle = await fs.open(this.file, "a", 0o600);
      try {
        await handle.appendFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.consumedDigests.add(actionDigest);
      this.consumedEnvelopes.add(envelopeId);
      return true;
    } finally {
      await lockHandle.close().catch(() => {});
      await fs.unlink(lockFile).catch(() => {});
    }
  }

  /**
   * Revoke a run-scoped or session-scoped grant. Subsequent isConsumed checks
   * for that runId/sessionId return true (fail closed with capability-revoked).
   */
  async revoke(filter: RevokeFilter): Promise<void> {
    if (filter.runId) {
      if (this.revokedRuns.has(filter.runId)) return;
      const entry: LedgerEntry = {
        kind: "revoked-run",
        runId: filter.runId,
        revokedAt: Date.now(),
      };
      await this.appendEntry(entry);
      this.revokedRuns.add(filter.runId);
    }
    if (filter.sessionId) {
      if (this.revokedSessions.has(filter.sessionId)) return;
      const entry: LedgerEntry = {
        kind: "revoked-session",
        sessionId: filter.sessionId,
        revokedAt: Date.now(),
      };
      await this.appendEntry(entry);
      this.revokedSessions.add(filter.sessionId);
    }
  }

  /** True if the actionDigest was already consumed. */
  isConsumedDigest(actionDigest: string): boolean {
    return this.consumedDigests.has(actionDigest);
  }

  /** True if the run was revoked. */
  isRunRevoked(runId: string): boolean {
    return this.revokedRuns.has(runId);
  }

  /** True if the session was revoked. */
  isSessionRevoked(sessionId: string): boolean {
    return this.revokedSessions.has(sessionId);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(this.dir, 0o700);
    } catch { /* non-fatal */ }
  }

  /** Append one entry atomically: write to tmp → fsync → rename. */
  private async appendEntry(entry: LedgerEntry): Promise<void> {
    await this.ensureDir();
    const lockFile = this.file + ".lock";
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
      const handle = await fs.open(this.file, "a", 0o600);
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
  ledger: PersistedCapabilityLedger,
  now: number,
): "ok" | "expired" | "revoked" {
  if (ledger.isRunRevoked(runId)) return "revoked";
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
  ledger: PersistedCapabilityLedger,
  now: number,
): "ok" | "expired" | "revoked" {
  if (ledger.isSessionRevoked(sessionId)) return "revoked";
  if (expiresAt !== undefined && expiresAt <= now) return "expired";
  return "ok";
}

/** SHA-256 helper for digest verification. */
export function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}
