import type {
  DiscoverySource,
  ProviderAccountContext,
} from "../../foundations/contracts/backend-ports.js";

export interface AccountDiscoveryRecord {
  account: string;
  modelIds: string[];
  lastRefreshedAt: string | null;
  lastRefreshError?: string;
}

/**
 * In-memory / persistent cache for per-account auto-discovered models.
 * Strictly adheres to P4.4a failure-safe rules:
 * 1. Account save succeeds even if discovery is down (records lastRefreshError).
 * 2. Cached models are retained after a refresh failure (never cleared on error).
 * 3. Surfaces lastRefreshedAt + lastRefreshError.
 * 4. Manual refresh method available.
 * 5. Background refresh is non-blocking.
 */
export class DiscoveryCache {
  private cache = new Map<string, AccountDiscoveryRecord>();

  get(account: string): AccountDiscoveryRecord | undefined {
    return this.cache.get(account);
  }

  set(account: string, record: AccountDiscoveryRecord): void {
    this.cache.set(account, record);
  }

  list(): AccountDiscoveryRecord[] {
    return Array.from(this.cache.values());
  }

  /**
   * Refreshes an account's model list failure-safely using the provided discovery source.
   */
  async refreshAccount(
    accountContext: ProviderAccountContext,
    discoverySource: DiscoverySource,
  ): Promise<AccountDiscoveryRecord> {
    const accountName = accountContext.providerAccount;
    const existing = this.cache.get(accountName);

    try {
      const result = await discoverySource.discover(accountContext);
      const now = new Date().toISOString();

      if (result.error) {
        // Retain prior cached models on error
        const record: AccountDiscoveryRecord = {
          account: accountName,
          modelIds: existing?.modelIds ?? [],
          lastRefreshedAt: existing?.lastRefreshedAt ?? null,
          lastRefreshError: result.error,
        };
        this.cache.set(accountName, record);
        return record;
      }

      const record: AccountDiscoveryRecord = {
        account: accountName,
        modelIds: Array.from(new Set(result.modelIds)),
        lastRefreshedAt: now,
        lastRefreshError: undefined,
      };
      this.cache.set(accountName, record);
      return record;
    } catch (err: any) {
      // Retain prior cached models on exception
      const record: AccountDiscoveryRecord = {
        account: accountName,
        modelIds: existing?.modelIds ?? [],
        lastRefreshedAt: existing?.lastRefreshedAt ?? null,
        lastRefreshError: err?.message || "Discovery failed",
      };
      this.cache.set(accountName, record);
      return record;
    }
  }

  /**
   * Schedules a non-blocking background refresh for an account.
   */
  scheduleBackgroundRefresh(
    accountContext: ProviderAccountContext,
    discoverySource: DiscoverySource,
  ): void {
    setImmediate(() => {
      this.refreshAccount(accountContext, discoverySource).catch(() => {});
    });
  }
}
