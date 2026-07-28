/**
 * Persisted broker replay ledger — Capabilities (spec 008, T210a, FR-009).
 *
 * Replaces the in-memory `consumedRequestIds = new Set<string>()` in
 * EffectBroker with a durable NDJSON file under
 * `~/.seepient/security/replay/` using the same atomic write discipline
 * (tmp + fsync + rename, 0o600/0o700) as the audit store and capability ledger.
 *
 * On restart the ledger is reloaded and replay protection resumes from the
 * persisted set. Entries are never pruned in v1 (future: TTL-based GC).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

interface ReplayEntry {
  requestId: string;
  consumedAt: number;
}

/**
 * Durable replay ledger. Backed by an append-only NDJSON file.
 * `load()` must be called once at startup before any `has()` / `consume()`.
 */
export class PersistedReplayLedger {
  private readonly dir: string;
  private readonly file: string;
  private consumed = new Set<string>();
  private loaded = false;

  constructor(opts?: { root?: string }) {
    this.dir =
      opts?.root ??
      (process.env.SEEPIENT_SECURITY_DIR
        ? path.join(process.env.SEEPIENT_SECURITY_DIR, "replay")
        : path.join(os.homedir(), ".seepient", "security", "replay"));
    this.file = path.join(this.dir, "ledger.ndjson");
  }

  /** Load existing entries from disk. Safe to call multiple times. */
  async load(): Promise<void> {
    if (this.loaded) return;
    await this.ensureDir();
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw err;
    }
    this.consumed = new Set();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as ReplayEntry;
        this.consumed.add(entry.requestId);
      } catch {
        /* skip malformed */
      }
    }
    this.loaded = true;
  }

  /** Returns true if the requestId was already consumed. */
  async has(requestId: string): Promise<boolean> {
    await this.load();
    return this.consumed.has(requestId);
  }

  hasSync(requestId: string): boolean {
    return this.consumed.has(requestId);
  }
  /**
   * Durably mark a requestId as consumed. Returns false if already present
   * (replay detected). Atomically appends to the NDJSON file with fsync.
   */
  async consume(requestId: string): Promise<boolean> {
    await this.load();
    if (this.consumed.has(requestId)) return false;
    const entry: ReplayEntry = { requestId, consumedAt: Date.now() };
    await this.appendEntry(entry);
    this.consumed.add(requestId);
    return true;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(this.dir, 0o700);
    } catch { /* non-fatal */ }
  }

  private async appendEntry(entry: ReplayEntry): Promise<void> {
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
