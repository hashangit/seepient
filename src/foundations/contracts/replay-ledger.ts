/**
 * Replay-ledger contract — Foundations (spec 027: moved out of the full-side
 * persisted implementation so the core in-memory store can conform without
 * pulling a full-package module into its emit).
 */
export interface ReplayLedger {
  load(): Promise<void>;
  has(requestId: string): Promise<boolean>;
  hasSync?(requestId: string): boolean;
  consume(requestId: string): Promise<boolean>;
}
