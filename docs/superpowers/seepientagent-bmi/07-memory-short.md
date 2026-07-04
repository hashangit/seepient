# 07 — Hippocampus (working memory)

> **The per-session volatile scratchpad. Updated live via `onStep`, wiped after Dreaming. High weight because it is immediately relevant.**
> Component deep-dive. Depends on `01-architecture.md`. Role: `working-memory`.

---

## 1. Brain analogy — and why it's exact

The Hippocampus maps to the **hippocampus proper** in its short-term/working-memory role — the fast, small, volatile buffer that holds active facts, current goals, and recent context, bridging immediate perception and long-term consolidation. Three properties make the analogy exact:

1. **Volatile and session-scoped.** The hippocampus holds *currently relevant* information; it is not where long-term memories live. The BMI's working memory (`MEMORY.md`) is per-session, wiped after consolidation. It is not a growing store.
2. **Bridged perception and consolidation.** In the brain, the hippocampus is where experience lands first, and where consolidation *reads from* during sleep to form cortical long-term memories. The BMI mirrors this exactly: the live session writes to working memory; Dreaming reads from working memory to write to the Cortex. Working memory is the input to consolidation.
3. **Small and high-priority.** Working memory is capacity-limited and always-relevant — it's what's "on your mind." Hence high weight (0.8) and rank 3 (trimmed only after Conscience/AMG/RAS).

The Hippocampus is distinguished from the Cortex (`08`) precisely because collapsing them breaks the architecture: one is volatile foreground (high weight, wiped), the other is stable background (lower weight, persistent). They must be independently gain-controllable, and consolidation must be a real phase transition between them, not a blur.

---

## 2. Functional role in the BMI

1. **Active-fact buffer.** Holds currently-relevant facts, open questions, in-progress task state, recent decisions — the things a human holds "in mind" during a working session.
2. **Context-bloat prevention.** Rather than growing the conversation history until it drowns the window, working memory distills the salient state into a compact buffer that persists across the session. The full history can be summarized; the working memory keeps the load-bearing facts.
3. **Input to consolidation.** Dreaming reads working memory (+ session store) to produce Cortex writes. This is the hippocampal→cortical transfer.

---

## 3. Time-scale & activation

- **Per-session.** One `MEMORY.md` per session, created on session start, wiped after that session's Dreaming.
- **Live, throttled updates.** Updated via `onStep` every N steps (configurable; default 10), non-blocking. Not updated every step (cost), not never (staleness).
- **Wiped post-Dreaming.** After consolidation, the working memory is cleared. If the session resumes before Dreaming ran, the buffer persists (graceful).

---

## 4. Contract

### 4.1 Source

```
.seepient/sessions/<sid>/MEMORY.md    # PER-SESSION
```

Per-session, stored alongside session JSON (the BMI-aware `PersistenceBackend` saves both). This mirrors the existing session-store layout (`~/.seepient/sessions/` / `.seepient/sessions/`).

### 4.2 File structure

```markdown
# Working Memory — session <sid>
_updated: <timestamp> | _turn: N | _words: <count, capped at 500>

## Active Facts
- <currently-true facts: "User is refactoring the auth module", "Deadline: Friday">

## Current Goals
- <in-progress task state: "Migrating session store to SQLite backend">

## Open Questions
- <unresolved: "Should we keep the legacy SessionStore API?">

## Recent Decisions
- <made this session: "Chose SQLite over Postgres for embeddability">

## Recent Context
- <last few interactions, one line each>
```

Hard cap: ~500 words. Over-cap triggers a compaction pass (drop oldest Recent Context, fold into Active Facts). The cap is what makes this a *scratchpad*, not a transcript.

### 4.3 Runtime types

```typescript
// src/core/bmi/hippocampus.ts

interface WorkingMemory {
  raw: string;                      // markdown for injection
  sessionId: string;
  updatedAt: number;
  turn: number;
}

/** Load working memory for a session (creates empty on first access). */
export function loadWorkingMemory(sessionId: string): Promise<WorkingMemory>;

/**
 * The onStep tracker. Called (throttled) from the agent loop's onStep hook.
 * Spawns a NON-BLOCKING background LLM call using the session's active
 * provider/model. Reads recent messages + current MEMORY.md, writes an update.
 */
export function startMemoryTracker(
  sessionId: string,
  provider: LLMProvider,
  model: string,
  messages: () => Message[],        // accessor to current history
  options: MemoryTrackerOptions,
): MemoryTracker;

interface MemoryTrackerOptions {
  intervalTurns: number;            // default 10
  maxWords: number;                 // default 500
  signal: AbortSignal;
}

interface MemoryTracker {
  /** Force an update now (e.g. on session pause). */
  flush(): Promise<void>;
  /** Stop tracking. */
  stop(): void;
}

/** The extraction prompt the tracker uses. */
export const MEMORY_EXTRACTION_PROMPT = `
Review the recent conversation and the current working memory. Update the
working memory to reflect the current state of the session:
- Add new active facts that are currently true.
- Update changed states (mark old ones resolved/removed).
- Remove resolved short-term goals.
- Keep it under <maxWords> words.
Do not editorialize. Facts only.
`;
```

The tracker is **non-blocking**: it spawns a background promise from the `onStep` hook. The user never waits for it. If it's mid-update when the next user message arrives, the update completes and the *next* assembly picks it up — the cost is at most one stale turn.

---

## 5. Integration with the existing agent loop

Three integration points, all through existing seams:

### 5.1 Injection (no loop change)
Working memory content is assembled into `ctx.messages[0]` by `bmiContextMiddleware` at weight 0.8 (`guidance` framing). Standard path.

### 5.2 Live updates (existing hook seam)
The tracker hooks into `onStep` — the same `HookExecutor` already in `agent-loop.ts`. The BMI adds a memory-tracker hook alongside any user hooks. **No edit to `executeLoop`.**

```typescript
// conceptual wiring
let turnsSinceUpdate = 0;
const tracker = startMemoryTracker(sessionId, provider, model, () => messages, {
  intervalTurns: 10, maxWords: 500, signal,
});

const hooks = createHookExecutor({
  onStep: async (step) => {
    turnsSinceUpdate++;
    if (turnsSinceUpdate >= 10) {
      turnsSinceUpdate = 0;
      tracker.flush();  // non-blocking; fire-and-forget
    }
  },
});
```

### 5.3 Persistence (existing store seam)
The session store already saves sessions. The BMI-aware backend (an extension of `file` or a new backend via `registerBackend`) saves `MEMORY.md` alongside session JSON. Reuses `PersistenceBackend`.

### 5.4 Wipe (Dreaming, see `10`)
After Dreaming reads and consolidates a session's working memory, it wipes `MEMORY.md`. This is a Dreaming-phase operation, not a loop operation.

---

## 6. Weight → mechanism mapping

### 6.1 Weight → framing strength
Base 0.8 → `strong` ("Apply as a firm constraint"). Working memory is authoritative for the current session — if it says the user is "migrating to SQLite," that *is* the current context. High framing.

### 6.2 Mode-invariance
```
hippocampus weight: base 0.8, all modes 0.8
```
Working memory doesn't vary by Cognitive State — what's on your mind is on your mind regardless of mode. This is a deliberate choice; it could be lowered in a future "fresh-start" mode, but v1 keeps it constant.

### 6.3 Token-budget rank: 3
High priority. Trimmed only after Conscience/AMG/RAS. Under pressure, Recent Context trims first; Active Facts/Current Goals are kept (they're load-bearing).

### 6.4 Authority: no veto
`veto: never`. Working memory informs; it doesn't block.

---

## 7. Evolvability

**`evolvable: false`** (in the component-evolution sense). Working memory is not rewritten by the evolution system — it's updated live by the tracker and wiped by Dreaming. It has no "evolution" path; it's a runtime buffer, not a persistent trait.

(This is distinct from its *contents* changing every session — that's operation, not evolution.)

---

## 8. Multi-instance / multi-session implications

- **Per-session, within an instance.** Each session has its own `MEMORY.md`.
- **Per-instance root.** A SeepientAgent's sessions live under its own `.seepient/sessions/`.

---

## 9. Verification (anti-theatre)

### 9.1 Tracker correctness (unit)
- After 10 turns on a synthetic session, `MEMORY.md` contains the salient active facts and has dropped resolved items. Target: ≥ 90% factual accuracy on a labeled suite.
- Hard cap respected: file ≤ 500 words after compaction.

### 9.2 Non-blocking (performance)
- The tracker's `flush()` does not delay the next user turn measurably (p95 delta < 20ms — it's fire-and-forget).

### 9.3 Injection effectiveness (`hippo-effect`)
- Paired comparison: with working memory vs without. On a long session where early facts would otherwise scroll out of the window, does the instance still act on them? Target: significantly better recall of early-session facts with working memory.

### 9.4 Consolidation input quality (`hippo-consolidation-input`)
- After Dreaming, the Cortex writes are traceable to working-memory entries. Garbage working memory → garbage Cortex; this makes working-memory quality upstream of Cortex quality.

### 9.5 Observable signals
- Every tracker update logs: turn, words, latency. A tracker that never updates (broken) or always maxes the cap (not compacting) is flagged.

---

## 10. Open questions & risks

1. **Extraction quality vs cost.** The tracker uses the active provider/model every 10 turns. On an expensive model, that's notable cost. Mitigation: allow a cheaper "tracker model" override; default to the active model for fidelity.
2. **Stale-buffer races.** If the tracker is mid-update when the next message arrives, one turn uses the pre-update buffer. Acceptable (≤ 1 stale turn) but noted.
3. **What "salient" means to the extractor.** The extraction prompt's quality determines everything downstream. Needs tuning against the factual-accuracy suite.
4. **Pre-Dreaming resume.** If a session resumes before Dreaming ran, the buffer is intact (good). But if the buffer has grown large over a very long session, the cap's compaction may have dropped something load-bearing. Mitigation: compaction prefers Active Facts over Recent Context; long sessions should trigger Dreaming sooner.

---

*Depends on: `00-overview.md`, `01-architecture.md`, `08-memory-long.md` (Dreaming reads working memory to write Cortex).*
*Referenced by: `10-evolution-system.md` (wipe phase), `04-ras.md` (working-memory items are scored like any context).*
