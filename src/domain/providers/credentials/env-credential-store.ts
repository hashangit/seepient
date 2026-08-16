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

/**
 * Environment-variable-based CredentialStore (kind: 'env').
 */
export class EnvCredentialStore implements CredentialStore {
  async resolve(ref: CredentialRef): Promise<CredentialHandle> {
    if (ref.kind !== "env") {
      throw new SeepientError(
        `EnvCredentialStore cannot resolve credential of kind "${ref.kind}"`,
        "UNRESOLVABLE_CREDENTIAL",
        false,
      );
    }

    const envName = ref.name;
    let activeLeases = 0;
    let leaseSeq = 0;

    const handle: CredentialHandle = {
      id: `env:${envName}`,
      ref,
      get activeLeaseCount() {
        return activeLeases;
      },
      async isResolvable(): Promise<boolean> {
        return Boolean(process.env[envName] && process.env[envName]!.trim().length > 0);
      },
      acquireLease(): CredentialLease {
        leaseSeq++;
        activeLeases++;
        let isReleased = false;

        const lease: CredentialLease = {
          leaseId: `env-lease-${leaseSeq}`,
          get isReleased() {
            return isReleased;
          },
          async secret(): Promise<CredentialSecret> {
            if (isReleased) {
              throw new SeepientError(
                `Cannot access secret on already-released lease "${lease.leaseId}"`,
                "CREDENTIAL_LEASE_EXPIRED",
                false,
              );
            }
            const val = process.env[envName];
            if (!val || val.trim().length === 0) {
              throw new SeepientError(
                `Environment variable "${envName}" is not set or empty`,
                "UNRESOLVABLE_CREDENTIAL",
                false,
              );
            }
            return { kind: "api_key", value: val };
          },
          async release(): Promise<void> {
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

  async put(_id: string, _record: PersistedCredentialRecord, _meta?: CredentialMeta): Promise<void> {
    throw new SeepientError(
      "EnvCredentialStore does not support put() operation",
      "UNSUPPORTED_OPERATION",
      false,
    );
  }

  async list(): Promise<CredentialRecord[]> {
    return [];
  }

  async delete(_id: string): Promise<void> {
    throw new SeepientError(
      "EnvCredentialStore does not support delete() operation",
      "UNSUPPORTED_OPERATION",
      false,
    );
  }
}
