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
import { EnvCredentialStore } from "./env-credential-store.js";
import { FileCredentialStore } from "./file-credential-store.js";
import { KeychainCredentialStore } from "./keychain-credential-store.js";
import { MemoryCredentialStore } from "./memory-credential-store.js";

/**
 * Unified CompositeCredentialStore routing credential resolution and persistence
 * across env, file, keychain, and memory stores based on ref.kind.
 */
export class CompositeCredentialStore implements CredentialStore {
  readonly envStore: EnvCredentialStore;
  readonly fileStore: FileCredentialStore;
  readonly keychainStore: KeychainCredentialStore;
  readonly memoryStore: MemoryCredentialStore;
  private primaryWriteStore: "file" | "keychain" | "memory";

  constructor(customStores?: {
    env?: EnvCredentialStore;
    file?: FileCredentialStore;
    keychain?: KeychainCredentialStore;
    memory?: MemoryCredentialStore;
    primaryWriteStore?: "file" | "keychain" | "memory";
  }) {
    this.envStore = customStores?.env ?? new EnvCredentialStore();
    this.fileStore = customStores?.file ?? new FileCredentialStore();
    this.keychainStore = customStores?.keychain ?? new KeychainCredentialStore();
    this.memoryStore = customStores?.memory ?? new MemoryCredentialStore();
    this.primaryWriteStore = customStores?.primaryWriteStore ?? "file";
  }

  private getWriteStore(): CredentialStore {
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
      return this.envStore.resolve(ref);
    }

    if (ref.kind === "seepient") {
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
    const fromWrite = await this.getWriteStore().get(id);
    if (fromWrite) return fromWrite;
    return this.fileStore.get(id);
  }

  async put(id: string, record: PersistedCredentialRecord, meta?: CredentialMeta): Promise<void> {
    return this.getWriteStore().put(id, record, meta);
  }

  async list(): Promise<CredentialRecord[]> {
    return this.getWriteStore().list();
  }

  async delete(id: string): Promise<void> {
    return this.getWriteStore().delete(id);
  }
}
