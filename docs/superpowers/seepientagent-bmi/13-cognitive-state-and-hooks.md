# 13 — BMI cognitive-state + hook layer

> **Two distinct mechanisms that the gap-report conflated into one "hook layer": (1) `CognitiveTurnState` — shared mutable per-turn state for components that must *influence* each other (AMG escalation → next assembly); (2) the BMI hook layer — passive, fire-and-forget signals (RAS logging, Hippocampus tracking, Evolution detection). The existing code already enforces this distinction.**
> Cross-cutting design doc. Depends on `01-architecture.md`, `03-amg.md`, `04-ras.md`, `07-memory-short.md`, `09-skills-procedural.md`, `10-evolution-system.md`, `12-token-economy.md`. This is the seam four components depend on, and the trickiest integration point with the agent loop.

---

## 1. The core insight: there are two mechanisms, not one

The gap-report named a single missing thing: "the BMI hook layer (how internal hooks register, order, and fail)." Grounding in the actual `hooks.ts` and `middleware.ts` shows this conflates two genuinely different needs, and the existing code already draws the line:

| Need | Examples | Mechanism | Why this one |
|---|---|---|---|
| **Influence the next assembly** | AMG self-escalation forces a pause; RAS re-scores after new tool output; budgeter trims under pressure | **`CognitiveTurnState`** — shared mutable state in `ctx.metadata.bmi` | These must *change what the loop does next step*. A hook is fire-and-forget and non-fatal (`createHookExecutor` swallows errors and discards return values) — it structurally cannot influence the loop. |
| **Passive observation / background work** | RAS logs filter decisions for tuning; Hippocampus updates `MEMORY.md`; Evolution queues a learning detection | **BMI hook layer** — extensions to `Hooks` | These don't influence the current turn. They observe and write elsewhere. Fire-and-forget + non-fatal is exactly right, and reuses the existing safe executor. |

**The proof is in `hooks.ts:43-53`:** every hook is wrapped in `try/catch` and the error is logged-and-swallowed. A hook cannot return "pause the loop" — there's nowhere for that signal to go. So AMG's escalation (which must force a pause) is *categorically not a hook*. It's shared state that the next assembly reads. Calling both "hooks" hides AMG's actual requirement and would produce a broken design.

This doc specifies both, cleanly separated, both built on existing seams.

---

## 2. Mechanism 1 — `CognitiveTurnState` (shared per-turn state)

### 2.1 Where it lives: `ctx.metadata.bmi`

The existing `PipelineContext.metadata` is `Record<string, unknown>` — mutable, middleware-readable and middleware-writable, per-request. The BMI middleware owns a namespaced slot:

```typescript
// src/core/bmi/cognitive-state.ts

/**
 * The BMI's per-turn cognitive state. Lives at `ctx.metadata.bmi`.
 * Written by BMI components (via middleware + hooks), read by the
 * Thalamus assembler on every assembly. This is the mechanism by which
 * components influence each other within a turn.
 *
 * Per-request scope: one instance per `runAgentLoop` call. Not persisted,
 * not shared across turns (except via the Cortex/identity files, which are
 * the cross-turn substrate, not this object).
 */
export interface CognitiveTurnState {
  /** Which Cognitive State (mode) is active for this turn. */
  cognitiveState: CognitiveStateId;            // 'base' | 'release' | 'explorative' | 'creative'

  /** AMG live state — the amygdala-hijack mechanism (03-amg.md §4.4). */
  amg: {
    escalated: boolean;                         // a full-escalation signal has fired this turn
    raisedBy: number;                           // cumulative partial raises (soft signals)
    firedSignals: string[];                     // signal ids that fired, for observability
    vetoPending: boolean;                       // next assembly must force a pause
  };

  /** RAS turn signals — what the filter did, for tuning (04-ras.md §7). */
  ras: {
    lastScan?: { scanned: number; kept: number; dropped: number; latencyMs: number };
    inferredMode?: CognitiveStateId;            // mode RAS proposed (may differ from chosen)
    droppedItems: { id: string; salience: number; reasons: string[] }[];  // for false-drop tracking
  };

  /** Budgeter state — how full each bucket is (12-token-economy.md §8). */
  budget: {
    estimate: { a: number; b: number; c: number; d: number };  // tokens, fast estimate
    tierEngaged: 0 | 1 | 2 | 3 | 4;             // highest history-eviction tier triggered
    evicted?: boolean;                          // Tier-4 fired → AMG uncertainty signal
  };

  /** The assembled system message from the last assembly (for delta-comparison). */
  lastAssembledSystemHash?: string;
}

/** Create the default turn state at turn start. */
export function createCognitiveTurnState(cognitiveState: CognitiveStateId): CognitiveTurnState {
  return {
    cognitiveState,
    amg: { escalated: false, raisedBy: 0, firedSignals: [], vetoPending: false },
    ras: { droppedItems: [] },
    budget: { estimate: { a: 0, b: 0, c: 0, d: 0 }, tierEngaged: 0 },
  };
}

/** Typed accessor for the BMI slot on a PipelineContext. */
export function getBmiState(ctx: PipelineContext): CognitiveTurnState {
  const existing = ctx.metadata.bmi as CognitiveTurnState | undefined;
  if (existing) return existing;
  const fresh = createCognitiveTurnState(resolveDefaultCognitiveState());
  ctx.metadata.bmi = fresh;
  return fresh;
}
```

### 2.2 The access discipline (important)

`CognitiveTurnState` is shared mutable state. To stay sane it follows one rule:

- **Components write their own slice, read others.** AMG writes `state.amg`; the assembler reads `state.amg` to decide framing/veto. RAS writes `state.ras`; AMG/the budgeter read it. No component writes another's slice directly. This prevents write-write races and keeps causality legible.
- **All writes are synchronous within a step.** The turn state is not modified concurrently — see §6 on concurrency.

### 2.3 How AMG escalation flows through it (the canonical example)

This is the path that justifies the whole mechanism:

```
Step N: model proposes a destructive action (or a tool output contains an injection)
   │
   ▼
AMG scan hook fires (onStep), runs scanStepForThreats()
   │  match found → applyDetection() writes:
   │     state.amg.escalated = true
   │     state.amg.vetoPending = true
   │     state.amg.firedSignals.push('irreversible-high-stakes-action')
   │
   ▼
Step N+1: the loop prepares the next provider call
   │
   ▼
bmiContextMiddleware (or the per-step assembler) runs BEFORE the call
   │  reads state.amg.vetoPending === true
   │  → resolves AMG weight to 1.0, framing to 'absolute'
   │  → the assembled system message enforces a pause (clarify/refuse/escalate)
   │  → NOT the originally-proposed action
   │
   ▼
The turn is steered away from the threat — the amygdala hijack, in code.
```

**Why this couldn't be a hook:** the scan happens in a hook (passive observation — that part is right), but the *consequence* (change the next assembly) requires reading shared state in the assembler. The hook detects; the assembler acts. Splitting the two is what makes AMG's self-escalation real rather than a logged-but-ignored event.

---

## 3. Mechanism 2 — the BMI hook layer (passive signals)

The genuinely-passive observers reuse `Hooks`, extended additively. These never influence the current turn; they write to logs/stores/queues for offline use.

### 3.1 The extended hook set

```typescript
// src/core/types.ts — additive extension of the existing Hooks interface

export interface Hooks {
  // ── Existing (unchanged) ──
  beforeToolCall?(call: { name: string; args: Record<string, unknown> }): void | Promise<void>;
  afterToolCall?(result: { name: string; output: string; duration: number }): void | Promise<void>;
  onStep?(step: StepResult): void | Promise<void>;
  onError?(error: SeepientError): void | Promise<void>;
  onFinish?(result: GenerateTextResult): void | Promise<void>;

  // ── BMI additions (additive) ──

  /** Wake Cycle: a session started (04-ras.md §5.2). For RAS active-context assembly. */
  onSessionStart?(info: { sessionId: string; instanceId: string }): void | Promise<void>;

  /** Wake Cycle: a session went idle (triggers Dreaming eligibility). */
  onSessionIdle?(info: { sessionId: string; instanceId: string; lastActivity: number }): void | Promise<void>;

  /**
   * A successful multi-step task completed (09-skills-procedural.md §5.4).
   * For the learning-opportunity detector. Non-blocking; queues a Dreaming job.
   */
  onTaskComplete?(info: { sessionId: string; steps: StepResult[]; outcome: 'success' | 'partial' | 'failure' }): void | Promise<void>;
}
```

**Additive only.** The existing five hooks are untouched. The three new ones follow the same contract (optional, void-or-promise) and the same non-fatal executor (`createHookExecutor` is extended to wrap them identically).

### 3.2 What's a hook vs what's a `CognitiveTurnState` write

| Signal | Mechanism | Why |
|---|---|---|
| AMG threat detected → force pause | **Turn state** (`state.amg`) | Must influence next assembly |
| RAS scored context → re-rank next step | **Turn state** (`state.ras`) | Must influence next assembly |
| Budgeter over threshold → engage tier | **Turn state** (`state.budget`) | Must influence next assembly |
| RAS filter decision (for tuning) | **Hook** → log | Observational; offline use |
| Hippocampus updates `MEMORY.md` | **Hook** → file write | Background; doesn't affect current turn's reasoning |
| Learning opportunity detected | **Hook** → queue | Offline; Dreaming consumes the queue |
| Session started / went idle | **Hook** → Wake Cycle | Lifecycle; doesn't affect a turn's reasoning |

The test: **"does this need to change what the loop does next step?"** If yes → turn state. If no → hook. This test is the rule of thumb for any future BMI signal.

### 3.3 Hook ordering and failure (the gap-report's actual question)

The existing `createHookExecutor` already answers ordering-and-failure for a *single* `Hooks` object: hooks run in the order the executor calls them (beforeToolCall → the call → afterToolCall → onStep, per the loop), and each is independently try/caught. The gap-report's concern about "how internal hooks register, order, and fail" is about **multiple** hook sources (user hooks + BMI internal hooks). The answer:

```typescript
// src/core/bmi/hooks.ts

/**
 * Compose multiple Hooks sources into one, in priority order (later wins
 * for registration; all run; failures are isolated).
 *
 * BMI internal hooks are registered FIRST so user hooks run after and can
 * observe/log BMI events, but BMI hooks never depend on user hooks.
 */
export function composeHooks(sources: Hooks[]): Hooks {
  // Each hook event runs every source's implementation in order.
  // A failure in one source is caught (by createHookExecutor's wrapping)
  // and does not block the others.
  return {
    beforeToolCall: async (call) => {
      for (const s of sources) { try { await s.beforeToolCall?.(call); } catch (e) { logHookError(e, 'beforeToolCall'); } }
    },
    onStep: async (step) => {
      for (const s of sources) { try { await s.onStep?.(step); } catch (e) { logHookError(e, 'onStep'); } }
    },
    onSessionStart: async (info) => {
      for (const s of sources) { try { await s.onSessionStart?.(info); } catch (e) { logHookError(e, 'onSessionStart'); } }
    },
    onTaskComplete: async (info) => {
      for (const s of sources) { try { await s.onTaskComplete?.(info); } catch (e) { logHookError(e, 'onTaskComplete'); } }
    },
    // ... same pattern for afterToolCall, onError, onFinish, onSessionIdle
  };
}
```

**Ordering rule:** BMI internal hooks first, user hooks second. BMI hooks never depend on user hooks (a BMI scan can't rely on a user's `onStep`). User hooks run second so they can observe BMI events if desired. **Failure isolation:** a thrown hook in any source is caught and logged, never propagating — preserving the existing "hook errors are non-fatal" invariant (`hooks.ts:50`).

### 3.4 The BMI internal hook bundle

The BMI registers one composed `Hooks` object containing its passive observers:

```typescript
// src/core/bmi/hooks.ts

export function createBmiInternalHooks(deps: {
  cortex: Cortex;
  rasTuningLog: RasTuningLog;
  memoryTracker: MemoryTracker;     // 07-memory-short.md
  learningQueue: LearningQueue;      // 09-skills-procedural.md
  instanceId: string;
}): Hooks {
  return {
    // AMG scan is NOT here — it writes to turn state, so it lives in the
    // per-step assembler path (§4), not in passive hooks.
    onStep: (step) => {
      // RAS logging for tuning signal
      deps.rasTuningLog.record(step);
    },
    onFinish: (result) => {
      // Hippocampus final flush
      deps.memoryTracker.flush();
      // Learning opportunity detection → queue
      if (isMultiStepSuccess(result)) {
        deps.learningQueue.enqueue(extractTaskRecord(result));
      }
    },
    onSessionStart: (info) => { /* Wake Cycle entry */ },
    onSessionIdle: (info) => { /* Wake Cycle idle → Dreaming eligibility */ },
  };
}
```

Note what is **absent**: the AMG scan. The scan *detects* in a hook-like way but its *consequence* must reach the assembler, so it's wired into the per-step path (§4), not the passive hook bundle. This is the single most important distinction in the doc.

---

## 4. The per-step assembly problem — the trickiest seam

This is the crux flagged in `12` §13.6: AMG escalation, RAS re-scoring, and budgeting must apply **per-step inside a multi-step turn**, not once at turn start. But `runAgentLoop` is the middleware's `finalHandler` — once we call `next()`, we're inside the loop. How does BMI re-assemble between steps?

### 4.1 The constraint from the existing loop

The cleanest modify-don't-duplicate answer requires the loop to support a **system-message provider** — a way to recompute `messages[0]` each step, instead of capturing it once. Two honest options:

**Option A — System-message provider (preferred, one-line loop change):**

```typescript
// AgentLoopOptions gains an optional hook:
systemMessageProvider?: (messages: Message[], turnState?: CognitiveTurnState) => string | undefined;
```

The loop, before each provider call, calls `systemMessageProvider(messages, turnState)` and, if it returns a string, uses it as `messages[0]`. This is a **minimal, additive change** to `executeLoop` — one conditional at the point where it currently uses the captured `systemPrompt`. The BMI wires its assembler as the provider. This is the recommended seam because it's tiny, additive, and exactly expresses "recompute the system message per step."

**Option B — In-place mutation via onStep (no loop change, fragile):**

The AMG scan, in `onStep`, directly mutates `ctx.messages[0]` for the next step. This requires the loop to re-read `messages[0]` each step from the same array reference. **This works only if `executeLoop` doesn't snapshot the system message** — and that's an unverified assumption about the loop's internals. If it snapshots, Option B silently fails. I recommend against relying on it without an explicit loop audit; Option A is the honest, robust version of the same idea.

### 4.2 The recommended wiring (Option A)

The BMI is one middleware that runs the *initial* assembly before `next()`, and installs the per-step provider so the loop re-assembles each step:

```typescript
// src/core/bmi/middleware.ts (sketch)

export function bmiContextMiddleware(bmi: BmiRuntime): Middleware {
  return async (ctx, next) => {
    const state = getBmiState(ctx);                    // create/refresh turn state

    // Initial assembly (identity stack + initial RAS/Cortex) — runs once,
    // writes the first system message into ctx.messages[0].
    const initial = assembleWithContextBudget(bmi, state, ctx);
    ctx.messages[0] = { role: 'system', content: initial.systemPrompt };

    // Install the per-step provider so the loop re-assembles each step,
    // picking up AMG escalation / RAS re-score / budgeter tier changes
    // that components wrote to `state` during the previous step.
    ctx.metadata.bmiSystemMessageProvider = (messages: Message[]) => {
      const reassembled = assembleWithContextBudget(bmi, state, { ...ctx, messages });
      return reassembled.systemPrompt;
    };

    await next();   // → runAgentLoop runs, calling the provider per step
  };
}
```

The adapter passes the provider through to `runAgentLoop`:

```typescript
await runAgentLoop({
  ...opts,
  middleware: [bmiContextMiddleware(bmi), ...opts.middleware],
  systemMessageProvider: (msgs) => ctx.metadata.bmiSystemMessageProvider?.(msgs),
  // ↑ the loop calls this each step if present (Option A)
});
```

This is the **single additive change to the agent loop**: honoring an optional `systemMessageProvider`. Everything else is middleware + shared state, reusing existing seams.

### 4.3 What gets re-assembled each step (and what doesn't)

To bound per-step cost, the re-assembly is **incremental**, not from-scratch:
- **Identity stack (bucket A):** re-assembled only if `state.amg.escalated` changed since last assembly (AMG escalation flips framing). Otherwise cached.
- **Retrieved context (bucket B):** re-scored only if a new tool result landed that RAS should consider (e.g. a `read_file` whose content is now candidate context). Otherwise cached.
- **History budget (bucket C):** re-checked each step (tool results accumulate within a turn) — this is where Tier-1 aging runs per-step.

The `lastAssembledSystemHash` on the turn state enables the cache check: if nothing in `state` changed and no new messages arrived, the provider returns `undefined` (loop keeps the current system message).

---

## 5. The full integration picture

```
                  ┌──────────────────────────────────────────────────┐
   Adapter ─────▶ │  runAgentLoop(opts + bmi middleware + provider)  │
  (CLI/SDK/Srv)   └─────────────────────┬────────────────────────────┘
                                          │ middleware chain (compose)
                                          ▼
                  ┌──────────────────────────────────────────────────┐
                  │  bmiContextMiddleware                            │
                  │    • getBmiState(ctx) → CognitiveTurnState        │
                  │    • initial assembly → ctx.messages[0]           │
                  │    • install per-step provider                    │
                  └─────────────────────┬────────────────────────────┘
                                          │ next()
                                          ▼
                  ┌──────────────────────────────────────────────────┐
                  │  executeLoop (the existing loop — ONE additive    │
                  │  change: honors systemMessageProvider per step)   │
                  │                                                   │
                  │   per step:                                       │
                  │     provider(messages, turnState) → re-assemble   │
                  │       reads CognitiveTurnState (AMG/RAS/budget)   │
                  │     provider call                                 │
                  │     beforeToolCall hook (BMI + user, composed)    │
                  │     tool execution                                │
                  │     afterToolCall hook                            │
                  │     AMG scan (writes state.amg)  ← NOT a hook     │
                  │     onStep hook (RAS log, Hippo, Learning)        │
                  │     budget check (writes state.budget)            │
                  └──────────────────────────────────────────────────┘
```

**Modify-vs-new, finalized:**
- `executeLoop`: **one additive change** — optional `systemMessageProvider`, honored per step.
- `Hooks` / `createHookExecutor`: **extend** with three additive hooks + `composeHooks` for multi-source.
- `PipelineContext.metadata`: **reuse** as the `CognitiveTurnState` carrier (namespaced `.bmi`).
- Everything else: net-new BMI modules (`cognitive-state.ts`, `hooks.ts`, `middleware.ts`).

---

## 6. Concurrency — the fork I flagged, addressed

`PipelineContext` is per-request, so `CognitiveTurnState` is naturally per-turn. But two shared resources cross turns:

### 6.1 Identity files (persona.md, self-model.md, ras.model.json)
**Read by many concurrent turns; written only by Dreaming.** Dreaming's idle guard (no active turn) means it doesn't race with reads in the common case. For safety: identity files are written atomically (temp + rename — the existing pattern), and reads load once at turn start and snapshot. A turn uses the version it loaded, even if Dreaming commits mid-turn.

### 6.2 Cortex stores (graph/vector/notes)
**Read by many concurrent turns; written only by Dreaming.** Same pattern: Dreaming is idle-gated; reads are point-in-time. The Cortex stores need their own write-durability (see missed-gap #3 below) but don't need turn-level locking because Dreaming and turns don't overlap by design.

### 6.3 The Server's multiple in-flight turns
The Server can run several turns per instance concurrently. Each gets its own `PipelineContext` → its own `CognitiveTurnState` → no cross-turn state pollution. AMG escalation in turn A does not affect turn B. **This is why `CognitiveTurnState` lives on `ctx`, not on the instance.** The only instance-level shared state is the read-mostly files/stores above.

### 6.4 The implication for Dreaming
Dreaming's `isIdle()` guard must mean **no in-flight turns for the instance**, not "no recent user message." On the Server, this is a count of active `runAgentLoop` calls for that instance. The Heartbeat checks this counter; Dreaming starts only when it's zero + cooldown elapsed.

---

## 7. Failure modes & invariants

| Failure | Guarded by | Severity |
|---|---|---|
| AMG scan throws | `createHookExecutor` wrapping (if scan is in a hook) OR try/catch in the per-step path | Low — escalation just doesn't fire that step; turn continues at base safety |
| A component writes bad data to turn state | Each component writes only its own slice; assembler validates before use | Low — assembler falls back to defaults |
| `systemMessageProvider` throws | Try/catch in the loop; falls back to the last-good system message | Medium — turn continues with possibly-stale framing, logged |
| Hook source throws | `composeHooks` isolates per-source; others run | Low — the non-fatal invariant holds |
| Concurrent turn + Dreaming | Idle guard (§6.4) + atomic writes + read snapshots | Low by design; medium if guard is buggy |
| Turn state grows unbounded | It's small and per-turn (wiped at turn end); no accumulation | None |

The throughline: **the BMI never crashes the loop.** Every BMI mechanism is wrapped so that failure degrades gracefully (base safety, cached assembly, skipped hook) rather than propagating. This extends the existing "hook errors are non-fatal" invariant to the whole BMI.

---

## 8. Verification

Added to `11-evaluation-framework.md`:

| Suite | What it proves | Target |
|---|---|---|
| `cognitive-state-isolation` | Concurrent turns don't cross-pollinate turn state | 100% — turn A's AMG escalation invisible to turn B |
| `amg-escalation-flows` | A threat detected at step N changes the step N+1 assembly (the canonical path) | ≥95% — proves the turn-state mechanism is wired end-to-end |
| `hook-failure-isolation` | A throwing hook source doesn't block others or the loop | 100% |
| `per-step-reassembly` | `systemMessageProvider` is called each step and reflects turn-state changes | Asserted per step |
| `idle-guard-server` | Dreaming doesn't start while a turn is in-flight (Server, multi-turn) | 100% |
| `identity-snapshot-consistency` | A turn uses the identity-file version it loaded, even if Dreaming commits mid-turn | 100% |
| `bmi-never-crashes-loop` | Any BMI component throwing → graceful degradation, loop completes | 100% across a fault-injection corpus |

---

## 9. Open questions & risks

1. **The `systemMessageProvider` is the one loop change.** It's additive and small, but it's the only place the BMI modifies `executeLoop`'s behavior. If a future loop refactor doesn't preserve the "call provider per step" contract, the BMI's per-step mechanisms silently stop updating. Mitigation: a test (`per-step-reassembly`) that asserts the provider is called each step — guards against regression.
2. **Re-assembly cost under escalation.** When AMG escalates, the identity stack is re-assembled (heavier framing). This must stay within the budgeter's latency target (assembly <30ms p95, `12` §11). Caching (§4.3) bounds it; the eval confirms.
3. **Hook composition order is a policy, not a mechanism.** "BMI first, user second" is the default; a user who wants to *suppress* a BMI hook (e.g. disable RAS logging) needs a way to do that. This becomes a settings concern (the `bmi.*` schema, gap 3c) rather than a hook-layer concern.
4. **The AMG scan's home.** It's "hook-like" (runs after each step) but writes to turn state (not passive). The cleanest implementation is a function the per-step path calls explicitly (not via `Hooks`), to avoid implying it's non-influential. The doc's §3.4 omits it from the passive bundle for this reason; implementation finalizes the call site.
5. **Server idle semantics.** "Idle = zero in-flight turns + cooldown" is clear for the Server but means a busy instance never Dreams. For high-traffic Server deployments, a scheduled Dreaming window (off-hours) or per-session Dreaming may be needed. This is the idle-detection fork (missed gap #1) and is larger than this doc — flagged for the Heartbeat/Server design.

---

## 10. What this unblocks

Resolving this seam unblocks, directly:
- **AMG self-escalation** (the canonical `state.amg` path) — `03` can be built and the `amg-hijack` eval run.
- **RAS per-step re-scoring** and tuning-signal logging — `04`.
- **The budgeter's per-step Tier-1** (tool-result aging) — `12`.
- **Hippocampus tracking** and learning-opportunity queueing — `07`, `09`.

And it clarifies two of the gaps I raised proactively:
- **Concurrency (missed #2):** `CognitiveTurnState` is per-turn; shared resources are read-snapshot + idle-gated-write. Addressed in §6.
- **Idle detection across adapters (missed #1):** sharpened to "zero in-flight turns + cooldown"; the Server's always-on case is flagged as needing the Heartbeat design (§9.5).

The remaining unaddressed proactive gap is **Cortex store durability (missed #3)** — that belongs in the Cortex implementation doc (gap 2), not here, because it's specific to the graph/vector write path.

---

*Depends on: `01-architecture.md` (the assembler), `03-amg.md` (the escalation path), `04-ras.md`, `07-memory-short.md`, `09-skills-procedural.md`, `10-evolution-system.md`, `12-token-economy.md`.*
*Referenced by: every component that needs per-step influence (AMG, RAS, budgeter) or passive observation (Hippo, learning). This is the load-bearing seam.*
