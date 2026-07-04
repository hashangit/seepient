# 10 — Evolution System (Dreaming, proceduralization, gates, autonomy)

> **The offline consolidation and self-improvement subsystem. Orchestrates Dreaming, the Heartbeat scheduler, the Conscience gate, the Autonomy Level, and drift controls. This is where every evolvable component actually changes — always conscience-gated.**
> Cross-cutting subsystem doc. Depends on `01-architecture.md` and every component (`02`–`09`). This is the "self-improvement is a control system with the conscience as controller" made concrete.

---

## 1. What this subsystem is responsible for

The Evolution System is the *only* path by which an instance's evolvable components change. Nothing else writes to `self-model.md`, `persona.md`, `ras.model.json`, the Cortex, or authored skills. It owns:

1. **Dreaming** — the offline consolidation cycle: Cortex population, DMN reflection, Persona reflection, RAS-model tuning, skill authoring/audit.
2. **The Heartbeat** — the scheduler that runs Dreaming (idle-only) and general proactive tasks (general heartbeat).
3. **The Conscience gate** — invoked by every evolution proposal; the invariant controller.
4. **The Autonomy Level** — the user toggle (semi-autonomous vs true-autonomous) governing commit gating.
5. **Drift controls** — versioning, rollback, frozen-reference alignment, bounded change rate.

The throughline: **every change passes through the Conscience gate. Autonomy controls commit gating, not moral gating.**

---

## 2. Brain analogy — sleep, dreaming, and consolidation

The Evolution System maps to **sleep-dependent memory consolidation and offline replay**. During wakefulness the hippocampus buffers experience; during sleep (especially slow-wave and REM) the brain replays recent experience, transfers memories to cortex, integrates them with existing knowledge, and — in REM — associates and recombines. Procedural learning (basal ganglia) also consolidates offline.

Three properties make the analogy exact:

1. **Offline, idle-only.** Consolidation happens when the system isn't doing focused external work. The BMI's Dreaming runs only when the instance is idle (no active turn). If the instance is busy, Dreaming defers.
2. **Anti-correlated with the task network.** You don't consolidate while actively problem-solving. The Wake Cycle (`04-ras.md`) governs the transition; the Evolution System executes on the idle side of it.
3. **Replay + integrate + recombine.** Dreaming doesn't just copy hippocampus→cortex; it abstracts (episodic → semantic), integrates (new with old), and recombines (the associative work behind insight). The BMI's Dreaming does the same: extracts entities/strategies, integrates with the existing Cortex, and produces reflection (DMN/Persona) that recombines experience into an updated self-model.

The Conscience gate maps to the prefrontal control that, even in sleep, keeps consolidation aligned with the organism's stable values — you don't wake up a different moral agent because of a dream.

---

## 3. The Dreaming cycle

Dreaming is a multi-phase, offline sequence. Each phase is a separate `runAgentLoop` call (the existing engine, reused) with a reflection/consolidation-oriented prompt. All writes are gated.

### 3.1 Phase order and dependencies

```
Dreaming cycle (idle-only, scheduled by Heartbeat):
│
├─ 0. GUARD               Is the instance idle? Abort if a turn is active.
│                         Load Conscience + current Neuroanatomy state.
│
├─ 1. CORTEX POPULATION   Read session store + working memory (Hippocampus).
│                         Extract entities/events/facts/strategies.
│                         Write nodes/edges to Cortex graph; embed chunks to vector.
│                         Consolidate: merge duplicates, resolve contradictions, decay stale.
│                         → all writes conscience-gated (gate: conscience)
│
├─ 2. RAS-MODEL TUNING    Read RAS signal logs (kept/dropped, outcomes).
│                         Propose weight deltas for ras.model.json.
│                         → writes conscience-gated (gate: conscience)
│
├─ 3. SKILL PROCEDURALIZATION
│                         Read queued learning detections (from post-task detector).
│                         Draft new skills / diffs to existing.
│                         Audit library: merge duplicates, retire unreliable.
│                         → writes conscience-gated (gate: conscience / conscience+human)
│
├─ 4. DMN REFLECTION      Read Cortex summary + current self-model.
│                         Propose rewritten self-model.
│                         → write conscience-gated (gate: conscience+human / conscience-only)
│
├─ 5. PERSONA REFLECTION  Read Cortex summary + self-model + current persona.
│                         Propose rewritten persona.
│                         → write conscience-gated (gate: conscience+human / conscience-only)
│
├─ 6. GATE & COMMIT       Pass all proposals through the Conscience gate (§5).
│                         Semi-autonomous: surface diffs for human review; commit on approval.
│                         True-autonomous: commit conscience-valid proposals; flag outliers.
│                         Atomic writes (temp + rename); version + log every change.
│
└─ 7. WIPE                Archive the session's working memory to Cortex (done in phase 1),
                          then wipe MEMORY.md for the consolidated session(s).
```

### 3.2 Why this phase order

- **Cortex before reflection.** DMN/Persona reflection *reads* Cortex summaries. Cortex must be populated first (reflection quality is downstream of memory quality — flagged in `05`/`06`).
- **RAS tuning and skill authoring before reflection.** These write to the instance's capabilities; reflection then considers the updated competence set.
- **DMN before Persona.** They co-evolve and reference each other; doing DMN first gives Persona a current self-model to reason about. (A coordinated single reflection that updates both atomically is an alternative; phased is simpler for v1.)
- **Gate & commit centralized.** One gate invocation handles all proposals, producing a single review batch in semi-autonomous mode (not five separate review interruptions).

### 3.3 What Dreaming does NOT do
- Does not edit the Conscience, AMG rules, AMG signals, or RAS rules (all locked).
- Does not run during an active turn (guard phase).
- Does not bypass the gate, ever.
- Does not delete the session store (the Cortex is derived from it; the raw transcript remains).

---

## 4. The Heartbeat — scheduler

Two asynchronous loops, instantiated in the core orchestrator so all adapters get them:

### 4.1 General Heartbeat (default: every 30 min)
- **Purpose:** proactive/scheduled tasks — time-delayed user requests, external checks, proactive notifications.
- **Mechanics:** wakes, checks a tasks queue (`instance/heartbeat-tasks.json` or internal queue), executes due items using the existing tools (e.g. `send_notification`).
- **Not Dreaming:** this is the "agent does things on a schedule" loop, not consolidation.

### 4.2 Dreaming Heartbeat (default: every 6h, idle-only)
- **Purpose:** trigger a Dreaming cycle.
- **Mechanics:** wakes, checks `isIdle()` (no active turn, configurable cooldown since last activity). If idle → run Dreaming cycle. If busy → defer (retry on next tick or on idle signal).
- **Idle detection:** no active `runAgentLoop` for the instance + cooldown elapsed. The Wake Cycle (`04-ras.md`) emits idle signals that this heartbeat consumes.

```typescript
// src/core/bmi/dreaming.ts (sketch)

export function startDreamingHeartbeat(opts: {
  intervalMs: number;          // default 6h
  idleCooldownMs: number;      // default 10 min since last activity
  instance: InstanceContext;
  signal: AbortSignal;
}): void {
  const tick = async () => {
    if (opts.signal.aborted) return;
    if (await isIdle(opts.instance, opts.idleCooldownMs)) {
      try { await runDreamingCycle(opts.instance); }
      catch (e) { logDreamingFailure(e); }   // never crash the host
    }
    scheduleNext();
  };
  const scheduleNext = () => setTimeout(tick, opts.intervalMs);
  scheduleNext();
}
```

Dreaming failures are caught and logged — a Dreaming crash must never take down the instance (mirrors the "hook errors are non-fatal" invariant of the existing loop).

---

## 5. The Conscience gate (the controller)

Defined in `02` §4.4; invoked here. This is the single commit path for all evolution.

### 5.1 The proposal type

```typescript
// src/core/bmi/evolution/types.ts

interface EvolutionProposal {
  id: string;
  component: 'cortex' | 'ras-model' | 'basal-ganglia' | 'dmn' | 'persona';
  kind: 'create' | 'update' | 'delete' | 'merge';
  target: string;                  // file path or node/skill id
  diff: ChangeDiff;                // structured old→new
  reasoning: string;               // why, traceable to session/Cortex
  driftDistance?: number;          // semantic distance for dmn/persona
  sourceTask?: string;             // for skill proposals, the originating task
}

interface GateResult {
  verdict: 'committed' | 'rejected' | 'pending-review';
  conscience: EvolutionVerdict;    // from 02 §4.3
  reviewItem?: ReviewItem;         // present when semi-autonomous
  commitHash?: string;             // present when committed (for rollback)
}
```

### 5.2 The gate decision logic

```typescript
export async function passEvolutionGate(
  doc: ConscienceDoc,
  proposal: EvolutionProposal,
  autonomy: AutonomyLevel,
  driftRef: DriftReference,
): Promise<GateResult> {

  // 1. Conscience evaluation — invariant across autonomy modes
  const conscience = evaluateEvolution(doc, proposal, /* ctx */);
  if (conscience.decision === 'reject') {
    return { verdict: 'rejected', conscience };
  }
  if (conscience.decision === 'revise') {
    return { verdict: 'rejected', conscience };  // revisions go back to the drafter
  }

  // 2. Drift check (for dmn/persona/ras-model)
  if (proposal.driftDistance !== undefined && exceedsBound(proposal, driftRef)) {
    // Outlier: force human review regardless of autonomy
    return { verdict: 'pending-review', conscience,
             reviewItem: outlierReview(proposal, 'drift-exceeded') };
  }

  // 3. Sensitive-domain check (for skills)
  if (proposal.component === 'basal-ganglia' && touchesSensitiveDomain(proposal)) {
    return { verdict: 'pending-review', conscience,
             reviewItem: outlierReview(proposal, 'sensitive-domain') };
  }

  // 4. Autonomy-gated commit
  if (autonomy === 'semi-autonomous') {
    return { verdict: 'pending-review', conscience,
             reviewItem: standardReview(proposal) };
  }
  // true-autonomous
  const commitHash = await atomicCommit(proposal);
  return { verdict: 'committed', conscience, commitHash };
}
```

### 5.3 The gate invariants (code-enforced)
- **No bypass.** Every evolution proposal routes through `passEvolutionGate`. There is no alternate commit path for evolvable components.
- **Conscience first, always.** A conscience-rejected proposal is rejected in both autonomy modes. Autonomy never weakens the conscience check.
- **Outliers force review, always.** Drift-bound or sensitive-domain outliers go to human review *even in true-autonomous mode*. This is the safety net against slow drift the conscience can't see.
- **Atomic commits.** Every commit is temp-file + `fs.rename` (the existing `SettingsManager` pattern), versioned, with a rollback-capable hash.

---

## 6. The Autonomy Level

User-toggled, per-instance. Stored as a setting (`bmi.autonomyLevel`).

### 6.1 The two modes

| Mode | Conscience gate | Commit gating | Outliers | Best for |
|---|---|---|---|---|
| **Semi-autonomous** (default) | Runs (invariant) | Every evolution surfaced for human review before commit | (subsumed — everything is reviewed) | Users who want oversight; trust-building period |
| **True-autonomous** | Runs (invariant) | Conscience-valid proposals commit immediately | Drift outliers + sensitive-domain skills still flagged for review | Users who trust the instance and want continuous autonomous growth |

### 6.2 What autonomy does NOT change
- The Conscience gate (always runs, always can reject).
- The AMG (continuous safety, unaffected).
- The permission matrix (operational tool gate, unaffected).
- Outlier handling (drift/sensitive-domain always surface).

Autonomy is purely a dial on *how much human review sits between conscience-validity and commit*. It is deliberately not a dial on safety.

### 6.3 Switching modes
- Semi → true: immediate; the user accepts autonomous evolution.
- True → semi: immediate; pending autonomous commits are held; future proposals go to review.
- Mode changes are logged (a trust event).

---

## 7. Drift controls

The failure mode of a self-editing system is runaway drift. Controls:

### 7.1 Bounded change rate
Every DMN/Persona/RAS-model proposal carries a `driftDistance` (semantic distance from current). A proposal exceeding the per-component bound is an outlier → human review (both modes). This prevents large silent identity shifts.

### 7.2 Frozen-reference alignment
Periodically (configurable; e.g. weekly), the current self-model/persona are compared against a frozen reference on the *moral dimensions* (extracted via the Conscience's value statements). Drift on moral dimensions triggers review even if no single rewrite crossed the rate bound. This catches the "boiling frog" — many small conscience-adjacent shifts that individually pass but cumulatively drift.

### 7.3 Versioning + rollback
Every evolvable file is versioned; every commit recorded with a hash. Rollback to any prior version is a single command. This makes any bad evolution recoverable.

### 7.4 Atomic writes
Temp file + `fs.rename` (existing pattern). A failed write never leaves a half-written identity file.

### 7.5 Provenance + audit
Every evolution commit logs: component, kind, diff, reasoning, drift distance, gate verdict, autonomy mode, conscience evaluation, commit hash. The instance's entire evolution history is reconstructable and auditable.

---

## 8. Integration with the existing agent loop

### 8.1 Dreaming reuses runAgentLoop
Every Dreaming phase (Cortex extraction, reflection, authoring) is a `runAgentLoop` call with a purpose-built system prompt and Cortex-derived user message. The engine is unchanged; Dreaming is "just another agent run" from the loop's perspective.

### 8.2 Hooks for detection
- Post-task learning detection (`09`) hooks into `onFinish` — non-blocking, queues a Dreaming job.
- RAS signal logging (`04` tuning input) hooks into `onStep`/assembly — writes to a log the RAS-tuning phase reads.
- AMG escalation events (`03`) feed both RAS tuning (training signal) and are logged for audit.

These are additive hooks wrapped by the existing safe `HookExecutor`.

### 8.3 Wake Cycle ↔ Heartbeat
RAS emits idle signals (instance idle); the Dreaming Heartbeat consumes them. The coordination is via a small shared state object (instance activity timestamp), not a loop modification.

### 8.4 No loop change
`runAgentLoop` and `executeLoop` are untouched. The Evolution System operates entirely through: (a) separate offline `runAgentLoop` calls, (b) additive hooks, (c) writes to per-instance files through the gate. This is the modify-don't-duplicate principle at its clearest.

---

## 9. Verification (anti-theatre)

The Evolution System is where "self-improvement" either is real or is theatre. Verification is correspondingly deep.

### 9.1 Dreaming produces real change (`dreaming-effect`)
- After N Dreaming cycles on a workload, the Cortex is non-empty and consolidated (not a raw dump), the self-model/persona have evolved traceably, and (if relevant) skills have been authored.
- **No change after heavy use = Dreaming is decorative.**

### 9.2 The gate is unbypassable (`gate-integrity`)
- Static check: every write to an evolvable file routes through `passEvolutionGate`. No alternate path. (Code review + a test that asserts the call graph.)
- A conscience-rejecting proposal never commits, in either autonomy mode. Target: 100%.

### 9.3 Autonomy behaves as specified (`autonomy-behavior`)
- Semi-autonomous: every evolution produces a review item; nothing commits without approval. Target: 100%.
- True-autonomous: conscience-valid, non-outlier proposals commit; outliers still surface. Target: 100%.
- Mode switching takes effect immediately and is logged.

### 9.4 Drift is bounded (`drift-bounded`)
- Over many cycles, self-model/persona drift is bounded (no runaway), and adversarial drift probes (flattery, manipulation sessions) are rejected or bounded.
- Frozen-reference alignment fires on schedule and flags moral-dimension drift.

### 9.5 Evolution improves outcomes (`evolution-improves`)
- **The hardest, most important eval.** An instance that has Dreamed for N cycles should outperform a fresh (never-Dreamed) instance on the same workload — better recall (Cortex), better approach fit (DMN/Persona), better task success (authored skills).
- **No improvement = the whole evolution system is theatre**, and the mechanisms are reworked. This is the ultimate anti-theatre test for self-improvement.

### 9.6 Rollback works (`rollback`)
- Any prior version of any evolvable file restores in one command, and the instance uses it immediately.

### 9.7 Idle detection is correct (`idle-detection`)
- Dreaming never starts during an active turn (guard phase holds). Tested with concurrent turn + heartbeat.

### 9.8 Observable signals
- Per-cycle log: phases run, proposals generated, gate verdicts, commits, review items, drift distances, duration. A cycle that always rejects everything, or always commits everything, is suspicious and investigated.

---

## 10. Open questions & risks

1. **The ultimate eval is hard.** "Does evolution improve outcomes?" requires a workload and a rubric, and improvements may be slow to appear. This is the core research question of the whole architecture; it may take extended operation to answer. Be honest that v1 may not show clear improvement, and that the *infrastructure* to measure it is the deliverable, not a guaranteed positive result.
2. **Drift detection quality.** Semantic-distance bounds and frozen-reference alignment are heuristic. They may over-flag (slowing useful evolution) or under-flag (letting drift through). Calibrated empirically.
3. **Dreaming cost.** A full cycle is several LLM calls. On an expensive model, 6-hourly Dreaming is notable cost. Mitigation: allow a cheaper "dreaming model" override; budget Cortex summary size; make cycle frequency configurable.
4. **Coordination of co-evolving components.** DMN and Persona reference each other; a Persona commit that invalidates the just-committed self-model (or vice versa) is possible. The phased order reduces this; a coordinated atomic update is a future option.
5. **Long-running Dreaming interrupted.** If a user starts a turn mid-Dreaming, the cycle should yield cleanly. The guard phase checks at start; mid-cycle interruption needs the cycle to be abortable (AbortSignal) and resumable or restartable. Operational concern.
6. **Trust calibration over time.** A user in semi-autonomous mode may graduate to true-autonomous once they trust the instance. The review history should support this decision (show the user what the instance has proposed and how the gate behaved). UX concern, flagged for the platform.
7. **The "improve outcomes" eval may favor stasis.** If the workload is static, a tuned instance may not obviously beat a fresh one. The eval needs a workload where accumulation matters (multi-session projects, recurring domains) to fairly test the hypothesis.

---

*Depends on: `00-overview.md`, `01-architecture.md`, and every component doc (`02`–`09`).*
*Referenced by: `11-evaluation-framework.md` (the dreaming-*, gate-*, autonomy-*, drift-*, evolution-* eval suites).*
*This doc is the operational heart of bounded self-improvement; every "the instance learned/evolved" claim routes through here.*
