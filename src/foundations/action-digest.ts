/**
 * Action digests — Foundations (spec 027: moved out of the full-side tools
 * analyzers so the domain prepared-action validator can hash actions without
 * importing a full-package module).
 */
import { createHash } from "node:crypto";
import type { PreparedOperation } from "./contracts/prepared-action.js";
import type { EffectRequest } from "./contracts/tool-effects.js";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** SHA-256 digest of args object for action id derivation (key-order independent). */
export function digestArgs(args: unknown): string {
  return createHash("sha256").update(stableJson(args), "utf8").digest("hex");
}

export function digestAction(input: {
  operation: PreparedOperation;
  effects: EffectRequest[];
  principalId: string;
  toolName: string;
  argsDigest: string;
  runId?: string;
  toolCallId?: string;
}): string {
  const payload = JSON.stringify({
    operation: input.operation,
    effects: input.effects,
    principalId: input.principalId,
    toolName: input.toolName,
    argsDigest: input.argsDigest,
    runId: input.runId,
    toolCallId: input.toolCallId,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
