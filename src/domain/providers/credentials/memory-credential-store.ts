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

interface StoredEntry {
  record: PersistedCredentialRecord;
  createdAt: string;
  updatedAt: string;
  meta?: CredentialMeta;
}

/**
 * In-memory CredentialStore for testing and SDK host-app embedded modes.
 */
export class MemoryCredentialStore implements CredentialStore {
  private entries = new Map<string, StoredEntry>();

  async resolve(ref: CredentialRef): Promise<CredentialHandle> {
    if (ref.kind === "none") {
      return {
        id: "none",
        ref,
        activeLeaseCount: 0,
        async isResolvable() {
          return true;
        },
        acquireLease(): CredentialLease {
          return {
            leaseId: "lease-none",
            isReleased: false,
            async secret() {
              return { kind: "none" };
            },
            async release() {},
          };
        },
      };
    }

    if (ref.kind !== "seepient") {
      throw new SeepientError(
        `MemoryCredentialStore cannot resolve credential of kind "${ref.kind}"`,
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
        return this.entries.has(credId);
      },
      acquireLease: (): CredentialLease => {
        leaseSeq++;
        activeLeases++;
        let isReleased = false;

        const lease: CredentialLease = {
          leaseId: `mem-lease-${leaseSeq}`,
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
            const entry = this.entries.get(credId);
            if (!entry) {
              throw new SeepientError(
                `Credential "${credId}" not found in MemoryCredentialStore`,
                "UNRESOLVABLE_CREDENTIAL",
                false,
              );
            }
            return { kind: "api_key", value: entry.record.keyValue };
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
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return {
      id,
      materialKind: "api_key",
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      meta: entry.meta,
    };
  }

  async put(id: string, record: PersistedCredentialRecord, meta?: CredentialMeta): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.entries.get(id);
    this.entries.set(id, {
      record,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      meta,
    });
  }

  async list(): Promise<CredentialRecord[]> {
    const records: CredentialRecord[] = [];
    for (const [id, entry] of this.entries.entries()) {
      records.push({
        id,
        materialKind: "api_key",
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        meta: entry.meta,
      });
    }
    return records;
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }
}
