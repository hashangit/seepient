/**
 * Per-call context seam (spec 029 S09, FR-039/040; data-model §3.4).
 *
 * One neutral seam between the caller's hydrated history and the provider
 * request: `{ strategy, maxInputTokens, compaction }`. Applied to the per-call
 * message copy immediately before the model call — never to stored history,
 * and never by deleting messages to fit a prompt (overflow is a typed error).
 *
 * Strategies (vocabulary lifted from the imported app's context policy):
 *  - `retrieval` (default): the caller's hydration IS the selection — send as-is.
 *  - `cache-aware`: send as-is; prefix stability is the point, reuse is observed
 *    through usage cache tokens.
 *  - `current`: send only the protected current request.
 *  - `snapshots`: shorten older free text to head/tail snapshots; tool-protocol
 *    messages (assistant calls + tool results) and images pass untouched.
 */
import type { ContextSeam, Message } from "../../foundations/types.js";
import { ContextBudgetExceededError } from "../../foundations/errors.js";

const SNAPSHOT_MAX = 400;
/** Rough per-image token cost used only for budget estimation. */
const IMAGE_TOKEN_ESTIMATE = 1000;

/** Head/tail snapshot with an explicit shortening marker (imported policy shape). */
function snapshotText(content: string, maxLength = SNAPSHOT_MAX): string {
  if (content.length <= maxLength) return content;
  return `${content.slice(0, Math.floor(maxLength * 0.7))}\n[… snapshot shortened; read original …]\n${content.slice(-Math.floor(maxLength * 0.3))}`;
}

/**
 * Coarse input estimate for the budget gate: chars/4 plus a flat per-image
 * cost. Deliberately conservative-shaped (over-estimate beats silent overflow);
 * provider-exact counts stay in usage accounting.
 */
export function estimateInputTokens(messages: Message[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    chars += m.content.length + (m.reasoning?.length ?? 0);
    images += m.images?.length ?? 0;
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Apply the seam to a per-call copy. The input array is never mutated and the
 * returned rows are new objects when changed; callers pass a throwaway copy.
 */
export function applyContextSeam(messages: Message[], seam: ContextSeam): Message[] {
  let working = messages;

  // Compaction first: replace everything through the cursor with the summary.
  // A cursor that names no row in this call's history is a caller bug.
  const compaction = seam.compaction;
  if (compaction) {
    const idx = working.findIndex((m) => m.id === compaction.cursorMessageId);
    if (idx < 0) {
      throw new Error(
        `COMPACTION_CURSOR_NOT_FOUND: cursor "${compaction.cursorMessageId}" names no message in the per-call history`,
      );
    }
    const summaryMessage: Message = {
      id: `compacted-${compaction.cursorMessageId}`,
      role: "user",
      content: compaction.summary,
      timestamp: working[idx].timestamp,
    };
    working = [summaryMessage, ...working.slice(idx + 1)];
  }

  // Protected current request: the last user row is never dropped or shortened.
  const protectedIdx = working.findLastIndex((m) => m.role === "user");

  let applied: Message[];
  switch (seam.strategy) {
    case "current":
      applied = protectedIdx >= 0 ? [working[protectedIdx]] : [];
      break;
    case "snapshots":
      // Tool-protocol pairing (contract §6): assistant calls and the tool
      // messages that answer them are never shortened or split.
      applied = working.map((m, i) => {
        if (i === protectedIdx || m.role === "tool" || (m.toolCalls?.length ?? 0) > 0) return m;
        if (m.content.length <= SNAPSHOT_MAX) return m;
        return { ...m, content: snapshotText(m.content) };
      });
      break;
    case "retrieval":
    case "cache-aware":
    default:
      applied = working;
      break;
  }

  if (seam.maxInputTokens !== undefined) {
    const estimated = estimateInputTokens(applied);
    if (estimated > seam.maxInputTokens) {
      throw new ContextBudgetExceededError(estimated, seam.maxInputTokens);
    }
  }
  return applied;
}
