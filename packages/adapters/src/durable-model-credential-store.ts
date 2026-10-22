/**
 * S10 durable credential adapter (029 T010, bridge-inventory B-9): the
 * engine-side credential store for `model-oauth` accounts.
 *
 * Refresh write-back (`put`) and retirement (`delete`) land in the PRODUCT
 * secret rows under the run path's existing fences:
 * - per-credential lock (`withModelCredentialLock`),
 * - freshness CAS (never overwrite a newer stored token; identical material
 *   is a no-op),
 * - failed-secret match on retire (a stale failure must not delete material a
 *   concurrent refresh or reconnect already persisted) → `needs-reauth`.
 *
 * Reads (`getRecord`, lease secrets) decrypt the CURRENT row on every call, so
 * a refresh persisted by a concurrent run is picked up mid-run.
 *
 * Structural mirror of the engine `CredentialStore` contract
 * (`src/foundations/contracts/credential-store.ts`): this package does not
 * import the engine; the app compositions pass the instance where a
 * `CredentialStore` is expected and the shapes check structurally.
 * `MemoryCredentialStore` remains only for api-key bindings (request-borne,
 * per-run by design).
 */
import type { PrismaClient } from "@seepients/db";
import { retireModelCredential } from "@seepients/db";
import type { AgentModelOAuthCredential, SecretStore } from "@seepients/adapter-kit";
import {
  matchesFailedOAuthSecret,
  parseModelSecret,
  persistStoredModelSecret,
  serializeModelSecret,
  withModelCredentialLock,
} from "./pi-oauth.js";
import { toOAuthCredential } from "./pi-credentials.js";

/** App-side secret store surface the adapter needs. */
export type DurableStoreSecretStore = Pick<SecretStore, "load" | "put">;

/** Engine record shapes (structural mirrors; see foundations/schemas). */
export interface DurableStoreRecord {
  kind: "api_key" | "oauth";
  keyValue?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}

export interface DurableStoreHandle {
  readonly id: string;
  readonly ref: { kind: "seepient"; id: string };
  isResolvable(): Promise<boolean>;
  acquireLease(): {
    readonly leaseId: string;
    readonly isReleased: boolean;
    secret(): Promise<
      | { kind: "api_key"; value: string }
      | { kind: "pi_oauth"; piAuthContext: DurableStoreRecord }
      | { kind: "none" }
    >;
    release(): Promise<void>;
  };
  readonly activeLeaseCount: number;
}

export interface DurableModelCredentialStoreOptions {
  prisma: Pick<PrismaClient, "secret"> & {
    $transaction: PrismaClient["$transaction"];
  };
  secretStore: DurableStoreSecretStore;
  /** Run scope the credential belongs to. */
  scope: { userId: string; spaceId: string };
  /** Opaque protected handle from the run resolution (row identity only). */
  handle: { credentialId: string; secretId: string };
  /** Engine account-key id bound to this store (one store per run account). */
  accountId: string;
  /** Upstream provider — recorded as the lookup hint the pi-ai auth adapter matches. */
  provider: string;
}

export class DurableModelCredentialStore {
  readonly isIsolated = false;
  /** The last oauth material read from the row — the failed-secret-match
   * state for a later retire, mirroring the executor's fence. */
  private lastSeen: { access: string; refresh: string; expires: number } | undefined;

  constructor(private readonly opts: DurableModelCredentialStoreOptions) {}

  async resolve(ref: { kind: string; id?: string }): Promise<DurableStoreHandle> {
    if (ref.kind !== "seepient" || ref.id !== this.opts.accountId) {
      throw new Error(
        `CREDENTIAL_REQUIRED: DurableModelCredentialStore cannot resolve credential kind "${ref.kind}" id "${String(ref.id)}"`,
      );
    }
    let activeLeases = 0;
    const store = this;
    return {
      id: `seepient:${ref.id}`,
      ref: { kind: "seepient", id: ref.id },
      get activeLeaseCount() {
        return activeLeases;
      },
      isResolvable: async () => (await store.getRecord(ref.id!)) !== undefined,
      acquireLease() {
        activeLeases++;
        let released = false;
        return {
          leaseId: `durable-lease-${ref.id}`,
          get isReleased() {
            return released;
          },
          secret: async () => {
            if (released) {
              throw new Error("CREDENTIAL_LEASE_EXPIRED: lease released");
            }
            const record = await store.getRecord(ref.id!);
            if (!record) {
              throw new Error(
                "CREDENTIAL_REQUIRED: the model credential row is gone (revoked or re-authenticated)",
              );
            }
            if (record.kind === "oauth") {
              return { kind: "pi_oauth" as const, piAuthContext: record };
            }
            if (!record.keyValue) {
              throw new Error("CREDENTIAL_REQUIRED: credential record has no key value");
            }
            return { kind: "api_key" as const, value: record.keyValue };
          },
          release: async () => {
            if (!released) {
              released = true;
              activeLeases = Math.max(0, activeLeases - 1);
            }
          },
        };
      },
    };
  }

  async get(id: string): Promise<
    | {
        id: string;
        materialKind: "api_key" | "oauth";
        createdAt: string;
        updatedAt: string;
        meta?: { providerAccountHint?: string; description?: string; source?: string };
      }
    | undefined
  > {
    if (id !== this.opts.accountId) return undefined;
    const row = await this.row();
    return {
      id,
      materialKind: "oauth",
      createdAt: (row?.createdAt ?? new Date(0)).toISOString(),
      updatedAt: (row?.createdAt ?? new Date(0)).toISOString(),
      meta: {
        providerAccountHint: this.opts.provider,
        description: `Model OAuth credential for ${this.opts.provider}`,
        source: "disk",
      },
    };
  }

  async getRecord(id: string): Promise<DurableStoreRecord | undefined> {
    if (id !== this.opts.accountId) return undefined;
    const row = await this.row();
    if (!row) return undefined;
    let plaintext: string;
    try {
      plaintext = await this.opts.secretStore.load(row.ciphertext, row.id);
    } catch {
      return undefined;
    }
    const parsed = parseModelSecret(plaintext);
    if (parsed.kind === "oauth") {
      const record = {
        kind: "oauth" as const,
        access: parsed.credential.access,
        refresh: parsed.credential.refresh,
        expires: parsed.credential.expires,
      };
      this.lastSeen = {
        access: record.access,
        refresh: record.refresh,
        expires: record.expires,
      };
      return record;
    }
    if (parsed.kind === "api_key") {
      return { kind: "api_key", keyValue: parsed.key };
    }
    return undefined;
  }

  async list(): Promise<
    Array<{ id: string; materialKind: "api_key" | "oauth"; createdAt: string; updatedAt: string }>
  > {
    const record = await this.get(this.opts.accountId);
    return record ? [record] : [];
  }

  /**
   * Durable refresh write-back. Freshness CAS under the per-credential lock:
   * a newer stored token wins, identical material is a no-op, anything older
   * is overwritten through the shared persist fence.
   */
  async put(
    id: string,
    record: DurableStoreRecord,
    _meta?: { providerAccountHint?: string; description?: string; source?: string },
  ): Promise<void> {
    if (id !== this.opts.accountId) {
      throw new Error(`DurableModelCredentialStore bound to "${this.opts.accountId}", got "${id}"`);
    }
    if (record.kind !== "oauth") {
      throw new Error(
        "CREDENTIAL_CLASS_MISMATCH: the durable model store only carries oauth material; " +
          "api-key bindings stay on the per-run MemoryCredentialStore",
      );
    }
    await withModelCredentialLock(this.opts.handle.secretId, async () => {
      const row = await this.row();
      if (!row) return;
      let currentMaxTokens: number | undefined;
      try {
        const current = parseModelSecret(
          await this.opts.secretStore.load(row.ciphertext, row.id),
        );
        if (current.kind === "oauth") {
          const stored = current.credential;
          if (stored.expires > record.expires!) return;
          if (
            stored.access === record.access &&
            stored.refresh === record.refresh &&
            stored.expires === record.expires
          ) {
            return;
          }
          currentMaxTokens = current.maxTokens;
        }
      } catch {
        // Unreadable current row: the incoming refresh is still newer than nothing.
      }
      const persist = persistStoredModelSecret(
        this.opts.prisma,
        this.opts.secretStore,
        this.opts.scope,
        this.opts.handle.secretId,
      );
      await persist(
        serializeModelSecret({
          kind: "oauth",
          credential: toOAuthCredential({
            type: "oauth",
            access: record.access!,
            refresh: record.refresh!,
            expires: record.expires!,
          }),
          ...(currentMaxTokens !== undefined ? { maxTokens: currentMaxTokens } : {}),
        }),
      );
    });
  }

  /**
   * Retire through the shared fence → the product row flips to its
   * re-authentication state (`needs-reauth` semantics: the credential row is
   * removed and preferences drop). The failed-secret match keeps a stale
   * failure from deleting material a concurrent refresh already renewed.
   */
  async delete(id: string): Promise<void> {
    if (id !== this.opts.accountId) return;
    const failedState = this.lastSeen;
    await retireModelCredential(this.opts.prisma, {
      userId: this.opts.scope.userId,
      credentialId: this.opts.handle.credentialId,
      secretId: this.opts.handle.secretId,
      matchesFailedSecret: failedState
        ? matchesFailedOAuthSecret(
            (ciphertext, secretId) => this.opts.secretStore.load(ciphertext, secretId),
            failedState,
          )
        : undefined,
    });
  }

  private async row(): Promise<{ id: string; ciphertext: string; createdAt: Date } | undefined> {
    const row = await this.opts.prisma.secret.findFirst({
      where: { id: this.opts.handle.secretId, userId: this.opts.scope.userId, spaceId: null },
      select: { id: true, ciphertext: true, createdAt: true },
    });
    return row ?? undefined;
  }
}

/** The oauth material the composition seeds the engine with (type-level only). */
export type DurableOAuthSeed = AgentModelOAuthCredential;
