/**
 * Local protected PolicyStore — Domain (spec 008, T108, FR-013).
 *
 * Active project/global security policy lives OUTSIDE executor-writable
 * workspaces at `~/.seepient/security/policies/<workspace-id>.json`, with:
 *   - private directory and file permissions (0o700 / 0o600),
 *   - exclusive lock (lockfile + O_EXCL),
 *   - fsync before rename,
 *   - atomic rename replacement,
 *   - monotonically increasing version,
 *   - post-write digest verification,
 *   - compare-and-set semantics (stale expectedVersion → policy-conflict).
 *
 * `workspace-id` is a versioned digest of canonical real path plus repository
 * identity when available. Executors do not receive this directory as a
 * readable or writable root.
 */
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import type {
  CapabilitySet,
  DecisionAuthority,
} from "../../foundations/contracts/permission-policy.js";
import type {
  PolicySnapshot,
  PolicyStore as PolicyStoreContract,
} from "../../foundations/contracts/execution-brokers.js";
import { PolicyConflictError } from "../../foundations/errors.js";

/** Versioned digest of canonical real path; stable across alias/mount. */
export function computeWorkspaceId(canonicalRoot: string): string {
  const input = `v1:${canonicalRoot}`;
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

/** Stable digest of the serialized policy (tamper-evident snapshots). */
function computePolicyDigest(policy: CapabilitySet): string {
  const canonical = JSON.stringify(policy);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Construct an empty snapshot (first-read default when no file exists). */
function emptySnapshot(workspaceId: string): PolicySnapshot {
  const empty: CapabilitySet = { version: 1, capabilities: [] };
  return {
    workspaceId,
    version: 0,
    policyDigest: computePolicyDigest(empty),
    policy: empty,
  };
}

interface StoredSnapshot {
  workspaceId: string;
  version: number;
  policyDigest: string;
  policy: CapabilitySet;
}

/**
 * Local protected policy store. Uses a sibling lockfile for mutual exclusion
 * and atomic rename for replacement. All file permissions are private.
 */
export class LocalPolicyStore implements PolicyStoreContract {
  private readonly dir: string;
  private readonly root: string;

  constructor(opts?: { root?: string }) {
    this.root =
      opts?.root ??
      (process.env.SEEPIENT_SECURITY_DIR
        ? path.join(process.env.SEEPIENT_SECURITY_DIR, "policies")
        : path.join(os.homedir(), ".seepient", "security", "policies"));
    this.dir = this.root;
  }

  private fileFor(workspaceId: string): string {
    return path.join(this.dir, `${workspaceId}.json`);
  }

  private lockFor(workspaceId: string): string {
    return path.join(this.dir, `${workspaceId}.lock`);
  }

  /** Create the private policy directory if missing. */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Best-effort tighten permissions; mkdir honours umask.
    try {
      await fs.chmod(this.dir, 0o700);
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Acquire an exclusive lock via O_EXCL lockfile. Released in `finally`.
   * Throws on contention so the caller can surface `policy-conflict`.
   */
  private async withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    const lockPath = this.lockFor(workspaceId);
    try {
      // O_EXCL create — fails if another process holds the lock.
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new PolicyConflictError("Policy store is locked by another process", {
          workspaceId,
        });
      }
      throw err;
    }
    try {
      return await fn();
    } finally {
      try {
        await fs.unlink(lockPath);
      } catch {
        /* lock already released */
      }
    }
  }

  async read(workspaceId: string): Promise<PolicySnapshot> {
    const file = this.fileFor(workspaceId);
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as StoredSnapshot;
      // Tamper-evidence: recompute the digest and reject on mismatch.
      const expected = computePolicyDigest(parsed.policy);
      if (expected !== parsed.policyDigest) {
        throw new PolicyConflictError(
          `Policy file for ${workspaceId} failed digest verification`,
          { workspaceId },
        );
      }
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptySnapshot(workspaceId);
      throw err;
    }
  }

  async compareAndSet(
    workspaceId: string,
    expectedVersion: number,
    next: CapabilitySet,
    _actor: DecisionAuthority,
  ): Promise<PolicySnapshot> {
    return this.withLock(workspaceId, async () => {
      const current = await this.read(workspaceId);
      if (current.version !== expectedVersion) {
        throw new PolicyConflictError(
          `Stale policy version: expected ${expectedVersion}, actual ${current.version}`,
          {
            workspaceId,
            expectedVersion,
            actualVersion: current.version,
          },
        );
      }

      const nextSnapshot: StoredSnapshot = {
        workspaceId,
        version: current.version + 1,
        policyDigest: computePolicyDigest(next),
        policy: next,
      };

      // Atomic replace: write temp in same dir, fsync, rename.
      const file = this.fileFor(workspaceId);
      const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      const handle = await fs.open(tmp, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(nextSnapshot, null, 2));
        await handle.sync(); // fsync before rename
      } finally {
        await handle.close();
      }

      // Post-write digest verification (read back what we wrote).
      const verifyRaw = await fs.readFile(tmp, "utf8");
      const verifyParsed = JSON.parse(verifyRaw) as StoredSnapshot;
      if (verifyParsed.policyDigest !== computePolicyDigest(verifyParsed.policy)) {
        await fs.unlink(tmp).catch(() => {});
        throw new PolicyConflictError("Post-write policy digest mismatch", { workspaceId });
      }

      await fs.rename(tmp, file);
      await fs.chmod(file, 0o600).catch(() => {});
      return nextSnapshot;
    });
  }
}
