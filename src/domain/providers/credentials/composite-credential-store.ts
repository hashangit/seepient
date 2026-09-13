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
import { EnvCredentialStore } from "./env-credential-store.js";
import { FileCredentialStore } from "./file-credential-store.js";
import { KeychainCredentialStore } from "./keychain-credential-store.js";
import { MemoryCredentialStore } from "./memory-credential-store.js";

export interface CompositeCredentialStoreOptions {
  env?: EnvCredentialStore;
  file?: FileCredentialStore;
  keychain?: KeychainCredentialStore;
  memory?: MemoryCredentialStore;
  primaryWriteStore?: "file" | "keychain" | "memory";
  /** @internal Set only by createAmbientCompositeCredentialStore */
  isIsolated?: boolean;
}

/**
 * Composite CredentialStore that chains multiple backends with fallback logic.
 * Reads fallback: File -> Keychain -> Env.
 * Writes route to primary write store (File by default in ambient, Memory by default in isolated).
 */
export class CompositeCredentialStore implements CredentialStore {
  readonly isIsolated: boolean;
  readonly envStore: EnvCredentialStore;
  readonly fileStore: FileCredentialStore;
  readonly keychainStore: KeychainCredentialStore;
  readonly memoryStore: MemoryCredentialStore;
  private primaryWriteStore: "file" | "keychain" | "memory";

  constructor(customStores?: CompositeCredentialStoreOptions) {
    if (customStores?.primaryWriteStore === "file" && customStores?.isIsolated === undefined) {
      this.isIsolated = false;
    } else {
      this.isIsolated = customStores?.isIsolated ?? true;
    }
    this.envStore = customStores?.env ?? new EnvCredentialStore();
    this.fileStore = customStores?.file ?? new FileCredentialStore();
    this.keychainStore = customStores?.keychain ?? new KeychainCredentialStore();
    this.memoryStore = customStores?.memory ?? new MemoryCredentialStore({ isIsolated: this.isIsolated });
    this.primaryWriteStore =
      customStores?.primaryWriteStore ?? (this.isIsolated ? "memory" : "file");
  }

  private getWriteStore(): CredentialStore {
    if (this.isIsolated && this.primaryWriteStore !== "memory") {
      return this.memoryStore;
    }
    if (this.primaryWriteStore === "memory") return this.memoryStore;
    if (this.primaryWriteStore === "keychain") return this.keychainStore;
    return this.fileStore;
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
            leaseId: "none-lease",
            isReleased: false,
            async secret(): Promise<CredentialSecret> {
              return { kind: "none" };
            },
            async release() {},
          };
        },
      };
    }

    if (ref.kind === "env") {
      if (this.isIsolated) {
        return {
          id: `env:${ref.name}`,
          ref,
          activeLeaseCount: 0,
          async isResolvable() {
            return false;
          },
          acquireLease(): CredentialLease {
            throw new CredentialRequiredError(
              `CREDENTIAL_REQUIRED: Environment variable credential "${ref.name}" cannot be resolved in isolated multi-tenant mode without explicit credential injection.`,
            );
          },
        };
      }
      return this.envStore.resolve(ref);
    }

    if (ref.kind === "seepient") {
      if (this.isIsolated) {
        return this.memoryStore.resolve(ref);
      }
      try {
        const handle = await this.fileStore.resolve(ref);
        if (await handle.isResolvable()) {
          return handle;
        }
      } catch {
        // Attempt keychain lookup if file store fails
      }
      try {
        const handle = await this.keychainStore.resolve(ref);
        if (await handle.isResolvable()) {
          return handle;
        }
      } catch {
        // Fall through to error
      }
      return this.fileStore.resolve(ref);
    }

    if (ref.kind === "keychain") {
      if (this.isIsolated) {
        return {
          id: `keychain:${ref.service}:${ref.account}`,
          ref,
          activeLeaseCount: 0,
          async isResolvable() {
            return false;
          },
          acquireLease(): CredentialLease {
            throw new CredentialRequiredError(
              `CREDENTIAL_REQUIRED: Keychain credential "${ref.service}/${ref.account}" cannot be resolved in isolated multi-tenant mode.`,
            );
          },
        };
      }
      return this.keychainStore.resolve(ref);
    }

    if ((ref as any).kind === "memory") {
      return this.memoryStore.resolve(ref as any);
    }

    if (ref.kind === "externalsecret") {
      throw new SeepientError(
        `External secret provider "${ref.ref}" is not configured in this environment`,
        "UNRESOLVABLE_CREDENTIAL",
        false,
      );
    }

    throw new SeepientError(
      `Unknown credential ref kind: ${(ref as any).kind}`,
      "UNRESOLVABLE_CREDENTIAL",
      false,
    );
  }

  async get(id: string): Promise<CredentialRecord | undefined> {
    if (this.isIsolated) {
      return this.memoryStore.get(id);
    }
    const fromWrite = await this.getWriteStore().get(id);
    if (fromWrite) return fromWrite;
    return this.fileStore.get(id);
  }

  async getRecord(id: string): Promise<PersistedCredentialRecord | undefined> {
    if (this.isIsolated) {
      return this.memoryStore.getRecord(id);
    }
    const ws = this.getWriteStore();
    if (ws.getRecord) {
      const rec = await ws.getRecord(id);
      if (rec) return rec;
    }
    return this.fileStore.getRecord?.(id);
  }

  async put(id: string, record: PersistedCredentialRecord, meta?: CredentialMeta): Promise<void> {
    return this.getWriteStore().put(id, record, meta);
  }

  async list(): Promise<CredentialRecord[]> {
    if (this.isIsolated) {
      return this.memoryStore.list();
    }
    return this.getWriteStore().list();
  }

  async delete(id: string): Promise<void> {
    return this.getWriteStore().delete(id);
  }

  resolveSecret(ref: string): string | undefined {
    return this.memoryStore.resolveSecret(ref);
  }
}

/**
 * Factory for creating an ambient CompositeCredentialStore (Profile A single-user mode).
 * Reads and writes through to ~/.seepient/credentials, keychain, and process.env.
 */
export function createAmbientCompositeCredentialStore(
  options?: Omit<CompositeCredentialStoreOptions, "isIsolated">,
): CompositeCredentialStore {
  return new CompositeCredentialStore({
    ...options,
    primaryWriteStore: options?.primaryWriteStore ?? "file",
    isIsolated: false,
  });
}
