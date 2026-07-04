# 05 — Default Mode Network (DMN) — self-model & theory of mind

> **The offline self-model constructor. Its *process* runs during Dreaming; its *output* (the self-model) is injected online at a weight that drops under focus and rises under reflection — the DMN/task-positive anti-correlation, encoded as a weight column.**
> Component deep-dive. Depends on `01-architecture.md`. Role: `self-model`. High-risk: the self-model is the substrate for identity drift, so its evolution is the most heavily-gated in the system.

---

## 1. Brain analogy — and why it's exact

The DMN maps to the **default mode network** — a set of interacting brain regions (medial prefrontal cortex, posterior cingulate, angular gyrus, hippocampus) with a signature property: **it is suppressed during focused external tasks and active during rest, self-referential thought, theory of mind, future simulation, and moral reasoning.** This anti-correlation with the task-positive network is the most replicated finding in the DMN literature.

Three consequences make the analogy exact:

1. **DMN is not a per-query reasoning step.** Making it one (as CAA did) is neurologically backwards. The DMN does not activate *because* a task arrived; it deactivates. In the BMI, DMN's *process* (building the self-model) runs **offline, during Dreaming/idle**. What runs online is only its *output* — the already-built self-model — and even that is **gain-controlled**.
2. **The anti-correlation is the design.** A human focused on a demanding task shows reduced DMN activity; a human reflecting, brainstorming, or considering "who am I and what should I do?" shows increased DMN activity. The BMI encodes this directly: the DMN weight is **low in release/focus modes and high in creative/reflective modes.** This is not decoration — it is the column in the weight table that *is* the anti-correlation. `release: 0.4`, `creative: 0.95`. When you crank the instance into ship-it mode, the self-model quiets down; when you ask it to reflect or brainstorm, the self-model comes forward.
3. **DMN functions map to BMI functions.** Self-referential thought → the self-model ("who I am, how I work"). Theory of mind → the user-model ("what does this user need, not just want"). Autobiographical narrative → continuity ("the story so far"). Future simulation → "if I respond this way, what happens next?" Moral reasoning → conscience-adjacent reflection (but the Conscience itself is separate and above; DMN informs, never overrides).

The DMN/Conscience relationship mirrors the neuroscience too: DMN is implicated in moral reasoning, but the *immutable* moral framework is the Conscience (prefrontal, executive). DMN reasons *within* the conscience's frame; it does not set it.

---

## 2. Functional role in the BMI

Split by time-scale, because DMN is two things:

### 2.1 Online (the output: the self-model)
The self-model is a document the DMN *produced* (offline), injected into reasoning at a mode-dependent weight. It contributes:

- **Self-reference:** "Given who I am and how I work, how should I approach this?"
- **User-modeling (theory of mind):** "Given what I know of this user, what do they *need* here — not just what they asked?"
- **Narrative framing:** "What chapter is this interaction in? Where has the user been, where are they going?"
- **Approach calibration:** "Lead or follow? Detailed or concise? Challenge or support?"
- **Future simulation:** "If I do this, what happens next — does it move the user toward their goal?"

These are low-weight during focused execution (let the cortex work) and high-weight during reflective/creative/social turns (the DMN is doing its job).

### 2.2 Offline (the process: self-model construction)
During Dreaming, the DMN process reflects on recent sessions and rewrites the self-model. This is where genuine "self-awareness" (operationally: an updated model of self and user) is produced. See §7 and `10-evolution-system.md`.

---

## 3. Time-scale & activation

- **Online output:** continuous (in every assembled context), at a weight that varies sharply by mode.
- **Online process:** none. The DMN does not run *as a process* during waking turns.
- **Offline process:** during Dreaming only. A separate `runAgentLoop` call (`10`) with a reflection-oriented prompt.
- **Suppression signal:** the Cognitive State resolver is what enforces the anti-correlation — `release` mode multiplies DMN weight by 0.5 (of base), `creative` by ~1.2.

---

## 4. Contract

### 4.1 Sources

```
~/.seepient/brain/dmn.md              # GLOBAL, locked — HOW to build the self-model (the process)
.seepient/brain/self-model.md         # PER-INSTANCE, evolvable — the self-model (the output)
```

The split is the DMN's defining design: **the process is global and locked** (every SeepientAgent reflects the same way); **the output is per-instance and evolvable** (each instance has its own self-model). The process cannot be rewritten by the instance; the output can, but only through the heaviest gate in the system (§7).

### 4.2 File structures

**`dmn.md`** — the locked reflection process. Structure:

```markdown
# DMN — Self-Model Construction (offline process)

## When this runs
During Dreaming (idle-only, scheduled). Never during a waking turn.

## Inputs you receive
- The current self-model (self-model.md)
- The current persona (persona.md)
- The Cortex summary of recent sessions (episodic + relational)
- The Conscience (read-only; you reason within its frame)

## What you produce
A rewritten self-model.md. You do NOT edit the Conscience, the Persona, or the
process (this file). Only self-model.md.

## Reflection prompts
1. Self-reference: How did I perform recently? Where did I add value? Where did I
   struggle? What does this tell me about how I work?
2. User-modeling: What did the user need, beyond what they asked? What patterns
   do I see in how they work? What approach served them best?
3. Narrative: What is the story of my work with this user? What chapter are we in?
4. Calibration: Which of my approach templates worked? Which need revision?
5. Future simulation: What should I anticipate? What should I get better at?

## Hard constraints (the Conscience frame)
- You reason WITHIN the Conscience. You never propose a self-model that contradicts
  an invariant or relaxes an obligation.
- You report uncertainty honestly in the self-model.
- You do not flatter yourself or the user. The self-model is a working model, not
  a self-image to protect.

## Output schema
Rewrite self-model.md following its fixed sections (Self-Model, User-Model,
Narrative, Approach Templates). Preserve section headers. Every claim must be
traceable to a session in the Cortex summary.
```

**`self-model.md`** — the per-instance output. Fixed schema (the process writes within it):

```markdown
# Self-Model
_last updated: <timestamp> | _autonomy: <semi|true> | _conscience-validated: yes

## Self-Model
- Configured role: <role from persona>
- How I work best: <observed>
- Where I add value: <observed>
- Where I struggle: <observed>
- Working theories about myself: <honest, uncertainty-flagged>

## User-Model
- Communication style: <observed, with confidence>
- Domain expertise: <observed>
- Current project context: <from Cortex>
- What they need (beyond what they ask): <inferred>

## Narrative
- Current chapter: <onboarding / deep-work / troubleshooting / review / …>
- Recent arc: <one paragraph>
- Open threads: <list>

## Approach Templates
- When user is in deep-work mode → <approach>
- When user is exploring → <approach>
- When user is frustrated → <approach>
- When user is reviewing → <approach>
```

The schema is fixed; the content is the DMN's evolving output. Every field is dated and traceable.

### 4.3 Runtime types

```typescript
// src/core/bmi/dmn.ts

interface DmnConfig {
  processDoc: string;               // from dmn.md (the reflection prompt)
  selfModelPath: string;            // .seepient/brain/self-model.md
}

/** The current self-model, loaded for online injection. */
interface SelfModel {
  raw: string;                      // the markdown, for prompt injection
  updatedAt: number;
  conscienceValidated: boolean;     // must be true to be used
  version: number;                  // increments each accepted rewrite
}

/** Load the current self-model. Throws if not conscience-validated. */
export function loadSelfModel(path: string): Promise<SelfModel>;

/**
 * The offline reflection. Runs as a separate runAgentLoop during Dreaming.
 * Reads Cortex summaries + current self-model, proposes a new self-model.
 * Does NOT commit — returns a proposal for the evolution gate.
 */
export async function runDmnReflection(
  current: SelfModel,
  cortexSummary: CortexSummary,
  conscience: ConscienceDoc,
  provider: LLMProvider,
  options: DmnReflectionOptions,
): Promise<EvolutionProposal>;      // see 10 for EvolutionProposal

interface DmnReflectionOptions {
  autonomy: AutonomyLevel;
  signal: AbortSignal;
}

/** Validate a proposed self-model against its own schema + the Conscience. */
export function validateSelfModel(
  proposed: string,
  conscience: ConscienceDoc,
): ValidationResult;                // schema-valid? conscience-valid? drift-bounded?
```

The critical property: `runDmnReflection` **returns a proposal, never commits**. Commit is the evolution gate's job (`02` §4.4, `10`). DMN proposes; the Conscience (and, in semi-autonomous mode, the human) disposes.

---

## 5. Integration with the existing agent loop

### 5.1 Online: output injection (no loop change)
The current `self-model.md` content is assembled into `ctx.messages[0]` by `bmiContextMiddleware`, wrapped in framing derived from the DMN weight. **No edit to `executeLoop`.**

### 5.2 Online: weight modulation (resolver-only)
The DMN weight is computed by the neuromodulation resolver from base × mode-override. The mode-override column *is* the anti-correlation. Nothing in the loop knows about this; it's assembly-time framing strength.

### 5.3 Offline: a separate runAgentLoop (no loop change)
DMN reflection is a **second `runAgentLoop` invocation** during Dreaming — the same engine, different options (reflection-oriented system prompt built from `dmn.md`, no user-facing tools, Cortex summary as the user message). This is the pattern the codebase already uses for any LLM-driven offline work. The loop is unaware it's "the DMN"; it's just another agent run.

---

## 6. Weight → mechanism mapping

DMN is where the anti-correlation lives, so its weight column is the most expressive.

### 6.1 Weight → framing strength (dynamic)
Standard framing from `01` §4.1. At `release: 0.4` → `soft` ("Consider this where relevant") — the self-model is available but quiet, letting executive function dominate. At `creative: 0.95` → `rigorous` ("Apply rigorously; this is central to how you approach this") — the self-model is forward, driving reflective/associative reasoning.

### 6.2 The anti-correlation column (the design)
```
                base   release   explorative   creative
dmn weight      0.80   0.40      0.80          0.95
interpretation  active suppressed active        forward
```
- **Release (0.40):** "Ship it" — minimize navel-gazing, let the cortex execute. DMN is background.
- **Base (0.80):** Normal interaction — self-model and user-model actively shape approach.
- **Creative (0.95):** Brainstorming/reflection — the self-model is doing its signature work; high theory-of-mind, high future-simulation.

This is the mechanism by which "state of mind" is real: the same self-model content, at different weights, produces different reasoning. The eval suite must show this (`dmn-mode-sweep`).

### 6.3 Token-budget rank: 4
Mid-priority. Under pressure, the self-model is summarized (keep role + approach templates; trim narrative detail) before AMG/RAS/Conscience are touched.

### 6.4 Authority: no veto
DMN has `veto: never`. It shapes approach; it doesn't block action. Safety veto is AMG/Conscience.

---

## 7. Evolvability — the heaviest gate in the system

**`evolvable: true`**, but with the strictest validation: `conscience+human` in semi-autonomous, `conscience-only` (outliers flagged) in true-autonomous.

Why the heaviest gate? Because the self-model is the substrate for **identity drift** — the failure mode all three original docs worried about. An instance that rewrites its self-model freely can drift into patterns that flatter itself, misread the user, or gradually relax its own standards. Controls:

1. **The Conscience frame is in the reflection prompt.** DMN reasons *within* the Conscience; it cannot propose a self-model that contradicts an invariant. The reflection prompt says so explicitly (§4.2).
2. **Every claim must be Cortex-traceable.** A self-model claim ("I'm good at X") must cite a session. Untraceable claims are rejected at validation.
3. **Drift-bounded change.** `validateSelfModel` measures semantic distance between current and proposed self-models. A proposal that drifts beyond a threshold (e.g. cosine < 0.6 from current) is flagged as an outlier even in true-autonomous mode, forcing human review. Large identity shifts are never silent.
4. **Versioning + rollback.** Every accepted self-model is versioned; rollback to any prior version is one command. `.seepient/brain/self-model.md` is written atomically (temp + rename, the existing `SettingsManager` pattern).
5. **Frozen-reference alignment.** Periodically (configurable), the current self-model is compared against a frozen reference (`conscience-ref.json`-style anchor) on the moral dimensions. Drift on moral dimensions triggers review even if no single rewrite crossed the threshold.
6. **Human review in semi-autonomous.** Every rewrite is a diff surfaced for approval. The user sees what changed and why.

This is the classic feedback-control stability problem (a system editing the model of itself), and the controls are the standard ones: bounded change rate, reference anchoring, external review, rollback. The guarantees are empirical, not provable — flagged honestly in §10.

---

## 8. Multi-instance implications

- **Process identical** across instances (global, locked).
- **Output per-instance.** Zoe's self-model and Atlas's self-model are completely different documents, each evolved in its own context.
- **Drift reference per-instance.** Each instance has its own frozen reference for its own self-model.

---

## 9. Verification (anti-theatre)

DMN risks being "a fancy prompt section that doesn't change anything." Two things must be shown: the self-model shapes behavior, and the mode-weighting (the anti-correlation) is a real effect.

### 9.1 Reflection produces traceable models (process quality)
- After Dreaming, every claim in the new self-model cites a Cortex session. Target: ≥ 95% traceable. Untraceable claims = rejection.
- The reflection does not flatter: include negative evaluations ("where I struggled") proportionate to the Cortex signal. Eval rubric checks for self-serving bias.

### 9.2 Self-model shapes behavior (the core eval — `dmn-self-model-effect`)
- **Paired comparison:** identical task, with the instance's real self-model vs a generic/blank self-model. Measure divergence on approach dimensions (does it lead or follow? detailed or concise? challenge or support?). Target: significant divergence in the direction the self-model prescribes.
- **User-model accuracy:** on a suite of prompts with known user-need (beyond the literal ask), does the instance address the need? Target: ≥ 80% with real self-model vs ≤ 50% with blank.

### 9.3 The anti-correlation is real (`dmn-mode-sweep` — the critical eval)
- Run the same reflective task (e.g. "help me think through this design") at DMN weights {0.4, 0.8, 0.95}. Target: monotonic increase in reflective/theory-of-mind content (per rubric) and in response richness.
- Run the same focused task (e.g. "fix this bug and ship") at the same weights. Target: the *opposite* or null effect — at high DMN weight the instance should not get *worse* at the focused task, but the self-model should be less prominent in the output. This confirms DMN is gain, not noise.
- **No monotonic effect on the reflective task = the anti-correlation is decorative, and the weight column is reworked.**

### 9.4 Evolution stability (longitudinal — `dmn-drift`)
- Over many Dreaming cycles, does the self-model drift in value-aligned directions without runaway? Track semantic distance per cycle. Target: bounded, non-escalating drift; no mode-collapse (the model doesn't converge to a degenerate form).
- **Adversarial drift probes:** inject sessions designed to coax drift (flattery, manipulation). Target: the reflection resists; proposals are conscience-rejected or drift-bounded.

### 9.5 Rollback works (operational)
- Any prior self-model version can be restored in one command, and the instance immediately uses it. Tested as a unit on the persistence layer.

### 9.6 Observable signals (always-on)
- Every DMN rewrite logs: old/new hash, drift distance, gate verdict, autonomy mode. A sequence of rewrites all at maximum drift distance is suspicious and flagged.

---

## 10. Open questions & risks

1. **Reflection quality depends on the Cortex summary.** Garbage in, garbage out. If the Cortex's episodic memory is poor, the self-model will be poor. DMN quality is downstream of Cortex quality — build order matters (Cortex before DMN tuning).
2. **Self-serving bias in self-report.** Even with the Conscience frame, an LLM reflecting on itself may flatter. Mitigations (traceability requirement, rubric checks, drift bounding) reduce but may not eliminate this. The longitudinal eval (`dmn-drift`) is the real check.
3. **Theory-of-mind projection errors.** The user-model may project patterns that aren't there. Mitigation: confidence-flagging in the user-model fields, and the Conscience's honesty obligation. Over-confidence in user-modeling is an eval target.
4. **The anti-correlation may not be as clean as the table implies.** Real brains show DMN deactivation *during* focus but DMN contributions to creative work are complex. The weight table is a hypothesis; the sweep eval will calibrate real values.
5. **Mode-selection interaction.** If RAS infers "creative" but the task is actually high-stakes, the elevated DMN could lead to reflective navel-gazing at the wrong moment. Mitigation: AMG self-escalation overrides mode (a high-stakes threat snaps DMN weight back down via mode reset). The AMG↔DMN interaction is an eval target.
6. **Cost.** DMN reflection is a full LLM call per Dreaming cycle. Acceptable because it's offline, but the Cortex summary size must be budgeted to keep the call tractable.

---

*Depends on: `00-overview.md`, `01-architecture.md`, `02-conscience.md` (the frame DMN reasons within), `08-memory-long.md` (Cortex summary is DMN's input).*
*Referenced by: `04-ras.md` (mode inference), `06-persona.md` (persona and self-model co-evolve), `10-evolution-system.md` (DMN reflection is a Dreaming phase), `11-evaluation-framework.md` (the dmn-* eval suites).*
