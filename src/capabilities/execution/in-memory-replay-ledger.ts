import type { ReplayLedger } from "./persisted-replay-ledger.js";

/**
 * In-memory replay ledger for isolated execution in multi-tenant environments.
 * Stores consumed request IDs purely in process memory with zero disk writes.
 */
export class InMemoryReplayLedger implements ReplayLedger {
  private readonly consumed = new Set<string>();

  async load(): Promise<void> {
    // In-memory ledger is always loaded
  }

  async has(requestId: string): Promise<boolean> {
    return this.consumed.has(requestId);
  }

  hasSync(requestId: string): boolean {
    return this.consumed.has(requestId);
  }

  async consume(requestId: string): Promise<boolean> {
    if (this.consumed.has(requestId)) {
      return false; // Already consumed (replay detected)
    }
    this.consumed.add(requestId);
    return true;
  }
}
