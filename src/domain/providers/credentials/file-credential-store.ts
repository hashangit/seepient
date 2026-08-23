import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  CredentialStore,
  CredentialHandle,
  CredentialLease,
  CredentialSecret,
} from "../../../foundations/contracts/credential-store.js";
import type {
  CredentialRef,
  CredentialRecord,
  PersistedCredentialRecord,
  CredentialMeta,
} from "../../../foundations/schemas/credential-store.js";
import { SeepientError } from "../../../foundations/errors.js";

interface StoredFilePayload {
  id: string;
  materialKind: "api_key" | "oauth";
  keyValue?: string;
  refresh?: string;
  access?: string;
  expires?: number;
  createdAt: string;
  updatedAt: string;
  meta?: CredentialMeta;
}

/**
 * File-based CredentialStore for explicitly opted-in local persistence (kind: 'seepient').
 * Directory mode 0700, file mode 0600, atomic writes.
 */
export class FileCredentialStore implements CredentialStore {
  private baseDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir =
      customBaseDir ??
      process.env.SEEPIENT_CREDENTIALS_PATH ??
      path.join(os.homedir(), ".seepient", "credentials");
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    }
  }

  private filePath(id: string): string {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.baseDir, `${safeId}.json`);
  }

  async resolve(ref: CredentialRef): Promise<CredentialHandle> {
    if (ref.kind !== "seepient") {
      throw new SeepientError(
        `FileCredentialStore cannot resolve credential of kind "${ref.kind}"`,
        "UNRESOLVABLE_CREDENTIAL",
        false,
      );
    }

    const credId = ref.id;
    let activeLeases = 0;
    let leaseSeq = 0;

    const handle: CredentialHandle = {
      id: `seepient:${credId}`,
      ref,
      get activeLeaseCount() {
        return activeLeases;
      },
      isResolvable: async (): Promise<boolean> => {
        return fs.existsSync(this.filePath(credId));
      },
      acquireLease: (): CredentialLease => {
        leaseSeq++;
        activeLeases++;
        let isReleased = false;

        const lease: CredentialLease = {
          leaseId: `file-lease-${leaseSeq}`,
          get isReleased() {
            return isReleased;
          },
          secret: async (): Promise<CredentialSecret> => {
            if (isReleased) {
              throw new SeepientError(
                `Cannot access secret on released lease "${lease.leaseId}"`,
                "CREDENTIAL_LEASE_EXPIRED",
                false,
              );
            }
            const file = this.filePath(credId);
            if (!fs.existsSync(file)) {
              throw new SeepientError(
                `Credential file not found for "${credId}"`,
                "UNRESOLVABLE_CREDENTIAL",
                false,
              );
            }
            try {
              const stat = fs.lstatSync(file);
              if (stat.isSymbolicLink()) {
                throw new SeepientError(
                  `Security Violation: Symlinked credential file is rejected: "${file}"`,
                  "SECURITY_ERROR",
                  false,
                );
              }
              const raw = fs.readFileSync(file, "utf-8");
              const parsed = JSON.parse(raw) as StoredFilePayload;
              if (parsed.materialKind === "oauth") {
                return {
                  kind: "pi_oauth",
                  piAuthContext: {
                    refresh: parsed.refresh ?? "",
                    access: parsed.access ?? "",
                    expires: parsed.expires ?? 0,
                  },
                };
              }
              return { kind: "api_key", value: parsed.keyValue ?? "" };
            } catch (err: any) {
              throw new SeepientError(
                `Failed to read credential "${credId}": ${err?.message}`,
                "UNRESOLVABLE_CREDENTIAL",
                false,
              );
            }
          },
          release: async (): Promise<void> => {
            if (!isReleased) {
              isReleased = true;
              activeLeases = Math.max(0, activeLeases - 1);
            }
          },
        };

        return lease;
      },
    };

    return handle;
  }

  async get(id: string): Promise<CredentialRecord | undefined> {
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return undefined;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        throw new Error(`Security Violation: Symlinked credential file is rejected: ${file}`);
      }
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw) as StoredFilePayload;
      return {
        id: parsed.id,
        materialKind: parsed.materialKind,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        meta: parsed.meta,
      };
    } catch {
      return undefined;
    }
  }

  async getRecord(id: string): Promise<PersistedCredentialRecord | undefined> {
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return undefined;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return undefined;
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw) as StoredFilePayload;
      if (parsed.materialKind === "oauth") {
        return {
          kind: "oauth",
          refresh: parsed.refresh ?? "",
          access: parsed.access ?? "",
          expires: parsed.expires ?? 0,
        };
      }
      return { kind: "api_key", keyValue: parsed.keyValue ?? "" };
    } catch {
      return undefined;
    }
  }

  async put(id: string, record: PersistedCredentialRecord, meta?: CredentialMeta): Promise<void> {
    this.ensureDir();
    const file = this.filePath(id);
    const existing = await this.get(id);
    const now = new Date().toISOString();

    const payload: StoredFilePayload = {
      id,
      materialKind: record.kind,
      ...(record.kind === "api_key"
        ? { keyValue: record.keyValue }
        : { refresh: record.refresh, access: record.access, expires: record.expires }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      meta,
    };

    const tmpFile = `${file}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const fd = fs.openSync(tmpFile, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, file);

    try {
      const dirFd = fs.openSync(this.baseDir, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Ignored if directory fsync is not supported by underlying filesystem
    }
  }

  async list(): Promise<CredentialRecord[]> {
    if (!fs.existsSync(this.baseDir)) return [];
    const files = fs.readdirSync(this.baseDir);
    const records: CredentialRecord[] = [];

    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const fullPath = path.join(this.baseDir, f);
      try {
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;

        const raw = fs.readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(raw) as StoredFilePayload;
        records.push({
          id: parsed.id,
          materialKind: parsed.materialKind,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          meta: parsed.meta,
        });
      } catch {
        // Skip corrupted entries
      }
    }

    return records;
  }

  async delete(id: string): Promise<void> {
    const file = this.filePath(id);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}
