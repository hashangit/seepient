/**
 * T3 — Hashline types.
 *
 * See `contracts/hashline-edit.md`.
 */

export interface HashlineSection {
  path: string;
  tag: string;
  operations: HashlineOp[];
}

export type HashlineOp =
  | { type: 'swap'; startLine: number; endLine: number; body: string[] }
  | { type: 'swap_block'; startLine: number; body: string[] }
  | { type: 'del'; startLine: number; endLine: number }
  | { type: 'del_block'; startLine: number }
  | { type: 'ins_pre' | 'ins_post' | 'ins_head' | 'ins_tail'; line?: number; body: string[] };
