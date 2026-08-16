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

export interface PlatformKeychainProvider {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * OS Keychain CredentialStore (kind: 'keychain').
 * Strictly throws KEYCHAIN_UNAVAILABLE if the platform keychain fails or is absent.
 * NEVER silently falls back to plaintext.
 */
export class KeychainCredentialStore implements CredentialStore {
  private defaultService: string;
  private provider?: PlatformKeychainProvider;

  constructor(customProvider?: PlatformKeychainProvider, defaultService = "seepient") {
    this.provider = customProvider;
    this.defaultService = defaultService;
  }

  async resolve(ref: CredentialRef): Promise<CredentialHandle> {
    if (ref.kind !== "keychain") {
      throw new SeepientError(
        `KeychainCredentialStore cannot resolve credential of kind "${ref.kind}"`,
        "UNRESOLVABLE_CREDENTIAL",
        false,
      );
    }

    const service = ref.service || this.defaultService;
    const account = ref.account;
    const provider = this.provider;

    let activeLeases = 0;
    let leaseSeq = 0;

    const handle: CredentialHandle = {
      id: `keychain:${service}:${account}`,
      ref,
      get activeLeaseCount() {
        return activeLeases;
      },
      isResolvable: async (): Promise<boolean> => {
        if (!provider) return false;
        try {
          const secret = await provider.getPassword(service, account);
          return secret !== null;
        } catch {
          return false;
        }
      },
      acquireLease: (): CredentialLease => {
        leaseSeq++;
        activeLeases++;
        let isReleased = false;

        const lease: CredentialLease = {
          leaseId: `keychain-lease-${leaseSeq}`,
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
            if (!provider) {
              throw new SeepientError(
                "OS Keychain is not available on this platform",
                "KEYCHAIN_UNAVAILABLE",
                false,
              );
            }
            try {
              const val = await provider.getPassword(service, account);
              if (!val) {
                throw new SeepientError(
                  `No keychain item found for service="${service}" account="${account}"`,
                  "UNRESOLVABLE_CREDENTIAL",
                  false,
                );
              }
              return { kind: "api_key", value: val };
            } catch (err: any) {
              if (err instanceof SeepientError) throw err;
              throw new SeepientError(
                `Keychain lookup failed: ${err?.message}`,
                "KEYCHAIN_UNAVAILABLE",
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

  async get(_id: string): Promise<CredentialRecord | undefined> {
    return undefined;
  }

  async put(id: string, record: PersistedCredentialRecord, _meta?: CredentialMeta): Promise<void> {
    if (!this.provider) {
      throw new SeepientError(
        "OS Keychain provider is not available",
        "KEYCHAIN_UNAVAILABLE",
        false,
      );
    }
    await this.provider.setPassword(this.defaultService, id, record.keyValue);
  }

  async list(): Promise<CredentialRecord[]> {
    return [];
  }

  async delete(id: string): Promise<void> {
    if (!this.provider) {
      throw new SeepientError(
        "OS Keychain provider is not available",
        "KEYCHAIN_UNAVAILABLE",
        false,
      );
    }
    await this.provider.deletePassword(this.defaultService, id);
  }
}
