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
import { SeepientError, CredentialRequiredError } from "../../../foundations/errors.js";

interface StoredEntry {
  record: PersistedCredentialRecord;
  createdAt: string;
  updatedAt: string;
  meta?: CredentialMeta;
}

export interface MemoryCredentialStoreOptions {
  isIsolated?: boolean;
}

/**
 * In-memory CredentialStore for testing and SDK host-app embedded modes.
 */
export class MemoryCredentialStore implements CredentialStore {
  readonly isIsolated: boolean;
  private entries = new Map<string, StoredEntry>();

  constructor(opts?: MemoryCredentialStoreOptions) {
    this.isIsolated = opts?.isIsolated ?? true;
  }

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

    if (ref.kind === "env") {
      // 022-5 FR-005: env is not an inference credential source in any mode.
      return {
        id: `env:${ref.name}`,
        ref,
        activeLeaseCount: 0,
        async isResolvable() {
          return false;
        },
        acquireLease(): CredentialLease {
          throw new CredentialRequiredError(
            `CREDENTIAL_REQUIRED: Environment variable credential "${ref.name}" is not supported — configure the provider through provider management or inject a credential store.`,
          );
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
            if (entry.record.kind === "oauth") {
              return { kind: "pi_oauth", piAuthContext: entry.record };
            }
            if (entry.record.kind === "api_key" && !entry.record.keyValue) {
              throw new SeepientError(
                `Credential "${credId}" has no key value`,
                "CREDENTIAL_REQUIRED",
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
      materialKind: entry.record.kind,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      meta: entry.meta,
    };
  }

  async getRecord(id: string): Promise<PersistedCredentialRecord | undefined> {
    return this.entries.get(id)?.record;
  }

  async put(id: string, record: PersistedCredentialRecord, meta?: CredentialMeta): Promise<void> {
    // 022-5 FR-005: an unresolvable credential must never enter the store —
    // env-kind refs have no source anymore, and a valueless api_key would
    // otherwise resolve `value: undefined` into a vendored SDK (env fallback).
    if ((record as { kind?: string }).kind === "env") {
      throw new SeepientError(
        `Credential "${id}": environment-variable credentials are not supported — configure the provider through provider management`,
        "UNRESOLVABLE_CREDENTIAL",
        false,
      );
    }
    if (record.kind === "api_key" && !record.keyValue) {
      throw new SeepientError(
        `Credential "${id}": api_key records require a non-empty keyValue`,
        "UNRESOLVABLE_CREDENTIAL",
        false,
      );
    }
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
        materialKind: entry.record.kind,
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

  resolveSecret(ref: string): string | undefined {
    const entry = this.entries.get(ref);
    if (!entry) return undefined;
    if (entry.record.kind === "api_key") {
      if (!entry.record.keyValue) {
        throw new SeepientError(
          `Credential "${ref}" has no key value`,
          "CREDENTIAL_REQUIRED",
          false,
        );
      }
      return entry.record.keyValue;
    }
    if (entry.record.kind === "oauth") {
      return entry.record.access;
    }
    return undefined;
  }
}
