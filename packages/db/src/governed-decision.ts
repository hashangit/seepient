/**
 * 029 gate repair round 3 (D2/D3) — governed continuation decisions.
 *
 * One authority for the actionDigest binding: the sha256 over canonical JSON
 * of {tool, arguments} of the EXACT suspended request. The adapter computes
 * it where it builds the waiting state (the suspension's own tool call), the
 * accept path stores it on the run.input_decision event, and the resumed
 * attempt's governed dispatch recomputes it from the ACTUAL call before
 * consuming the decision durably.
 */
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "./client.js";

/** Key-order independent canonical JSON (mirrors the engine's stableJson). */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

/** SHA-256 over the canonical JSON of {tool, arguments} — the suspension
 * binding shared by the waiting payload, the decision event, and the
 * dispatch-time verification. */
export function actionDigestOf(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(stableJson({ tool, arguments: args ?? null }), "utf8")
    .digest("hex");
}

/** The decision record was already consumed by another dispatch — never
 * re-arm; fall back to a fresh approval card. The executor catches this to
 * fail SAFE (ask again), never to auto-approve twice. */
export class GovernedDecisionConflictError extends Error {
  constructor() {
    super("Governed input decision was already consumed");
    this.name = "GovernedDecisionConflictError";
  }
}

export interface ConsumeRunInputDecisionInput {
  /** The run.input_decision event row being spent (one-shot). */
  decisionEventId: string;
  /** The decision payload as read at arming; consumedAt is stamped on it. */
  decisionPayload: Record<string, unknown>;
  /** What the answered decision decided — an approve flips the intended
   * externalEffect to approved; a deny spends the decision WITHOUT touching
   * any effect (the denial result goes back to the model instead). */
  outcome: "approve" | "deny";
  /** The intended externalEffect the decision approves. Governed pauses on
   * non-connector tools have no effect row — omit it to spend the decision
   * only. */
  effectId?: string;
}

/**
 * D3 durable consumption: the CAS on the decision payload's consumedAt
 * (null → timestamp) joins the externalEffect intended→approved flip inside
 * ONE transaction (approve). Either both land or neither does:
 * - a crash after the commit leaves the effect approved (replay queue covers
 *   dispatch) and the decision spent (never re-arms);
 * - a racing dispatch loses exactly one CAS and asks again.
 * A deny only spends the decision — durably, exactly once — and the denial
 * result returns to the model; no effect row is created or flipped.
 */
export async function consumeRunInputDecision(
  prisma: Pick<PrismaClient, "$transaction">,
  input: ConsumeRunInputDecisionInput,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (input.outcome === "approve") {
      if (!input.effectId) {
        throw new Error("An approving governed decision requires its externalEffect id");
      }
      const flipped = await tx.externalEffect.updateMany({
        where: { id: input.effectId, status: "intended" },
        data: { status: "approved" },
      });
      if (flipped.count !== 1) return false;
    }
    const consumed = await tx.event.updateMany({
      where: {
        id: input.decisionEventId,
        payload: { path: ["consumedAt"], equals: Prisma.AnyNull },
      },
      data: {
        payload: {
          ...input.decisionPayload,
          consumedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    if (consumed.count !== 1) {
      // Rolls back the flip above: a spent decision never approves an effect.
      throw new GovernedDecisionConflictError();
    }
    return true;
  });
}
