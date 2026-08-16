import type {
  CredentialRef,
  CredentialRecord,
  PersistedCredentialRecord,
  CredentialMeta,
} from "../schemas/credential-store.js";

export type CredentialSecret =
  | { kind: "api_key"; value: string }
  | { kind: "pi_oauth"; piAuthContext: unknown }
  | { kind: "none" };

export interface CredentialLease {
  readonly leaseId: string;
  secret(): Promise<CredentialSecret>;
  release(): Promise<void>;
  readonly isReleased: boolean;
}

export interface CredentialHandle {
  readonly id: string;
  readonly ref: CredentialRef;
  isResolvable(): Promise<boolean>;
  acquireLease(): CredentialLease;
  readonly activeLeaseCount: number;
}

export interface CredentialStore {
  resolve(ref: CredentialRef): Promise<CredentialHandle>;
  get(id: string): Promise<CredentialRecord | undefined>;
  put(id: string, record: PersistedCredentialRecord, meta?: CredentialMeta): Promise<void>;
  list(): Promise<CredentialRecord[]>;
  delete(id: string): Promise<void>;
}
