import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

export interface PlatformKeychainProvider {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * Default OS-native keychain provider using `security` on macOS or `secret-tool` on Linux.
 */
class DefaultPlatformKeychainProvider implements PlatformKeychainProvider {
  async getPassword(service: string, account: string): Promise<string | null> {
    const platform = os.platform();
    if (platform === "darwin") {
      try {
        const { stdout } = await execFileAsync("security", [
          "find-generic-password",
          "-s",
          service,
          "-a",
          account,
          "-w",
        ]);
        return stdout.trim();
      } catch (err: any) {
        if (err?.code === 44 || err?.message?.includes("could not be found")) {
          return null;
        }
        throw err;
      }
    } else if (platform === "linux") {
      try {
        const { stdout } = await execFileAsync("secret-tool", [
          "lookup",
          "service",
          service,
          "account",
          account,
        ]);
        return stdout ? stdout.trim() : null;
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          throw new SeepientError("secret-tool command not found", "KEYCHAIN_UNAVAILABLE", false);
        }
        return null;
      }
    }
    throw new SeepientError(`Platform ${platform} keychain is not supported`, "KEYCHAIN_UNAVAILABLE", false);
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    const platform = os.platform();
    if (platform === "darwin") {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "security",
          ["add-generic-password", "-U", "-s", service, "-a", account, "-w", password],
          (error) => {
            if (error) {
              if ((error as any)?.code === "ENOENT") {
                return reject(new SeepientError("security command not found", "KEYCHAIN_UNAVAILABLE", false));
              }
              return reject(error);
            }
            resolve();
          },
        );
      });
    } else if (platform === "linux") {
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          "secret-tool",
          [
            "store",
            "--label",
            `${service}/${account}`,
            "service",
            service,
            "account",
            account,
          ],
          (error) => {
            if (error) {
              if ((error as any)?.code === "ENOENT") {
                return reject(new SeepientError("secret-tool command not found", "KEYCHAIN_UNAVAILABLE", false));
              }
              return reject(error);
            }
            resolve();
          },
        );
        if (child.stdin) {
          child.stdin.on("error", () => {});
          child.stdin.write(password);
          child.stdin.end();
        }
      });
    } else {
      throw new SeepientError(`Platform ${platform} keychain is not supported`, "KEYCHAIN_UNAVAILABLE", false);
    }
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const platform = os.platform();
    if (platform === "darwin") {
      try {
        await execFileAsync("security", [
          "delete-generic-password",
          "-s",
          service,
          "-a",
          account,
        ]);
        return true;
      } catch {
        return false;
      }
    } else if (platform === "linux") {
      try {
        await execFileAsync("secret-tool", [
          "clear",
          "service",
          service,
          "account",
          account,
        ]);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * OS Keychain CredentialStore (kind: 'keychain').
 * Strictly throws KEYCHAIN_UNAVAILABLE if the platform keychain fails or is absent.
 * NEVER silently falls back to plaintext.
 */
export class KeychainCredentialStore implements CredentialStore {
  private defaultService: string;
  private provider?: PlatformKeychainProvider;

  constructor(customProvider?: PlatformKeychainProvider | null, defaultService = "seepient") {
    this.provider = customProvider === null ? undefined : (customProvider ?? new DefaultPlatformKeychainProvider());
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
              try {
                const parsed = JSON.parse(val);
                if (parsed && typeof parsed === "object" && parsed.kind === "oauth") {
                  return { kind: "pi_oauth", piAuthContext: parsed };
                }
              } catch {}
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

  async get(id: string): Promise<CredentialRecord | undefined> {
    if (!this.provider) return undefined;
    try {
      const val = await this.provider.getPassword(this.defaultService, id);
      if (!val) return undefined;
      const now = new Date().toISOString();
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === "object") {
          return {
            id,
            materialKind: parsed.kind === "oauth" ? "oauth" : "api_key",
            createdAt: parsed.createdAt ?? now,
            updatedAt: parsed.updatedAt ?? now,
            meta: parsed.meta,
          };
        }
      } catch {}
      return {
        id,
        materialKind: "api_key",
        createdAt: now,
        updatedAt: now,
      };
    } catch {
      return undefined;
    }
  }

  async getRecord(id: string): Promise<PersistedCredentialRecord | undefined> {
    if (!this.provider) return undefined;
    try {
      const val = await this.provider.getPassword(this.defaultService, id);
      if (!val) return undefined;
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === "object") {
          const { meta: _m, ...rec } = parsed;
          if (rec.kind === "oauth" || rec.kind === "api_key") {
            return rec as PersistedCredentialRecord;
          }
        }
      } catch {}
      return { kind: "api_key", keyValue: val };
    } catch {
      return undefined;
    }
  }

  async put(id: string, record: PersistedCredentialRecord, meta?: CredentialMeta): Promise<void> {
    if (!this.provider) {
      throw new SeepientError(
        "OS Keychain is not available on this platform",
        "KEYCHAIN_UNAVAILABLE",
        false,
      );
    }
    try {
      const payload = record.kind === "api_key" && !meta
        ? record.keyValue
        : JSON.stringify({ ...record, ...(meta ? { meta } : {}) });
      await this.provider.setPassword(this.defaultService, id, payload);
    } catch (err: any) {
      throw new SeepientError(
        `OS Keychain put failed: ${err?.message}`,
        "KEYCHAIN_UNAVAILABLE",
        false,
      );
    }
  }

  async list(): Promise<CredentialRecord[]> {
    return [];
  }

  async delete(id: string): Promise<void> {
    if (!this.provider) {
      throw new SeepientError(
        "OS Keychain is not available on this platform",
        "KEYCHAIN_UNAVAILABLE",
        false,
      );
    }
    try {
      await this.provider.deletePassword(this.defaultService, id);
    } catch (err: any) {
      throw new SeepientError(
        `OS Keychain delete failed: ${err?.message}`,
        "KEYCHAIN_UNAVAILABLE",
        false,
      );
    }
  }
}
