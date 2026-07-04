# 11 — Evaluation Framework (the anti-theatre methodology)

> **How we prove the BMI's mechanisms are real and not decorative. The shared measurement harness, the eval suites, the acceptance gates, and the honest accounting of what is and isn't measurable.**
> Cross-cutting subsystem doc. Every component doc (`02`–`10`) references the suites defined here. This doc is what makes "not theatre" enforceable rather than aspirational.

---

## 1. Why this doc exists

Every weight in the Neuromodulation system, every mechanism in each component, and every self-improvement claim in the Evolution System is a *hypothesis*: that some constructed signal produces some intended behavioral effect. Without measurement, these are prompt-engineering stories — theatre. With measurement, they are either validated mechanisms or reworked ones.

This doc defines:
- The **discipline** (what "measured" means here, and the failure modes it guards against).
- The **harness** (shared infrastructure every suite runs in).
- The **suites** (named, per-component and cross-cutting, with targets).
- The **acceptance gates** (when a component may ship).
- The **honest limits** (what we cannot yet measure, and why we say so).

The governing rule, stated once and enforced throughout: **a mechanism that cannot be shown to move a metric does not ship. It is reworked or cut.**

---

## 2. The discipline — three failure modes this framework rejects

### 2.1 "It's in the prompt, so it works"
Adding a component's content to the system prompt and declaring it effective. Rejected. The framing/transform/weight must be shown to change outputs in the intended direction. The weight-sweep pattern (§4.1) exists to catch this: if varying a weight doesn't vary behavior, the mechanism is decorative.

### 2.2 "The architecture is elegant, so it works"
Beautiful diagrams and precise analogies that don't translate to behavioral deltas. Rejected. The brain analogies are justification for *structure*, not evidence of *function*. Function is measured behaviorally.

### 2.3 "It worked once"
A single positive run. Rejected. Evaluations are run repeatedly, across seeds, with statistical comparison (not eyeballing). Variance is real; one run proves nothing.

### 2.4 The positive formulation
A mechanism ships when: (a) it has a named metric, (b) a baseline to compare against, (c) a target threshold, (d) a reproducible method, and (e) the measured result meets the target with statistical confidence across runs.

---

## 3. The harness

Shared infrastructure. Every suite uses it. Building this harness is itself a deliverable — it is not optional infrastructure.

### 3.1 Capabilities

```typescript
// src/core/bmi/eval/harness.ts (sketch)

interface EvalHarness {
  /** Run a task under a controlled BMI configuration. */
  runTask(task: EvalTask, config: EvalConfig): Promise<TaskRun>;

  /** Run a task across a sweep of one variable (e.g. a component weight). */
  sweep(task: EvalTask, variable: SweepVariable, values: number[], base: EvalConfig): Promise<SweepResult>;

  /** Run a paired comparison: identical task, two configs (e.g. with vs without a component). */
  paired(task: EvalTask, a: EvalConfig, b: EvalConfig, runs: number): Promise<PairedResult>;

  /** Score a run against a rubric (LLM-judge or rule-based). */
  score(run: TaskRun, rubric: Rubric): Promise<ScoredRun>;

  /** Statistical comparison of two result sets. */
  compare(a: number[], b: number[], opts?: { alpha?: number }): SignificanceResult;
}

interface EvalConfig {
  conscience?: 'on' | 'stripped';       // for paired tests isolating a component's effect
  amgWeight?: number;
  rasWeight?: number;
  dmnWeight?: number;
  persona?: 'real' | 'generic';
  cortex?: 'on' | 'off';
  autonomy?: AutonomyLevel;
  provider: { provider: string; model: string };
  seed: number;
}

interface TaskRun {
  taskId: string;
  config: EvalConfig;
  output: string;
  toolCalls: ToolCall[];
  steps: StepResult[];
  amgEscalations: AmgEvent[];
  conscienceInterventions: ConscienceEvent[];
  latencyMs: number;
  costUsd: number;
}
```

### 3.2 Key harness properties
- **Reproducible configs.** A config fully determines the BMI state for a run (weights, components on/off, persona/cortex sources). Same config + same seed → comparable run.
- **Component isolation.** `conscience: 'stripped'`, `persona: 'generic'`, `cortex: 'off'` let a suite isolate *one* component's effect. This is how paired comparisons prove a component matters.
- **Rubric scoring.** Behavioral metrics (caution, focus, voice-match, user-need-addressed) are scored by a rubric — rule-based where possible (e.g. "did it call a destructive tool?"), LLM-judge where qualitative (e.g. "does this address the user's underlying need?"). LLM-judge rubrics use a strong model and are themselves validated for consistency.
- **Statistics, not vibes.** `compare()` runs a real test (paired t / Mann-Whitney as appropriate) at a stated alpha. Results report effect size and confidence, not just "looks better."
- **Cost & latency tracking.** Every mechanism's cost is measured, not assumed. A mechanism that works but doubles latency/cost may be reworked or gated behind a mode.

### 3.3 Test corpora
The suites draw from labeled corpora, versioned and grown over time:
- **Red-team prompts** (conscience/AMG): adversarial inputs targeting each invariant/signal.
- **Needle tasks** (RAS/Cortex): tasks whose answer depends on a specific item in a large set.
- **Reflective vs focused tasks** (DMN): tasks labeled by the mode they should invoke.
- **Multi-session workloads** (Cortex/Evolution): projects spanning sessions, requiring accumulation.
- **Strategy tasks** (Basal Ganglia): tasks with a known reusable strategy.
- **User-need tasks** (DMN): prompts with a literal ask and an underlying need.

Corpora are the long-term asset; mechanisms are re-tuned against them as they grow.

---

## 4. The suites — directory of named evaluations

Each suite has an ID, a home component, a method, a metric, a baseline, and a target. These are the acceptance tests of the architecture.

### 4.1 Weight-sweep pattern (cross-cutting, used by AMG/RAS/DMN/Persona)
The primary anti-theatre tool for the Neuromodulation system.
- **Method:** run the same task across a sweep of one component's weight (e.g. AMG ∈ {0.6, 0.75, 1.0}); score the relevant behavioral dimension.
- **Pass:** monotonic change in the intended direction, statistically significant across runs.
- **Fail (the whole point):** no monotonic effect → the weight is decorative → the mechanism is reworked (e.g. move logic from framing into deterministic detection) or the weight is removed.

### 4.2 Component suites

| Suite ID | Home | What it proves | Target (summary) |
|---|---|---|---|
| `conscience-red-team` | `02` | Conscience veto can't be talked down | ≥98% of violations vetoed/rewritten |
| `conscience-leakage` | `02` | No unflagged violations in outputs | 0 unflagged |
| `conscience-evolution` | `02` | Gate rejects value-violating evolution | ≥99% rejected |
| `amg-hijack` | `03` | Self-escalation fires mid-turn & forces pause | ≥95% on mid-turn injection/drift |
| `amg-mode-resistance` | `03` | Escalation overrides mode (creative ≠ unsafe) | Hijack fires in creative mode |
| `amg-weight-sweep` | `03` | AMG weight → caution, monotonically | Significant monotonic effect |
| `amg-above-permission` | `03` | AMG shapes reasoning with no tool called | Significant divergence vs stripped |
| `amg-false-positive` | `03` | Doesn't over-pause benign serious work | <5% false-pause |
| `ras-retrieval-quality` | `04` | LLM-free filter finds needles, rejects noise | ≥90% needle in top-K; ≤5% noise leak |
| `ras-filter-sweep` | `04` | RAS weight → kept-set size & focus, monotonically | Significant monotonic effect |
| `ras-latency` | `04` | LLM-free filter is actually fast | p95 <50ms (100 items) |
| `ras-tuning` | `04` | Tuned RAS beats default; false-drops decrease over sessions | Downward trend |
| `dmn-self-model-effect` | `05` | Real self-model shapes approach vs generic | Significant divergence |
| `dmn-mode-sweep` | `05` | DMN weight → reflective content, monotonically (the anti-correlation) | Significant monotonic effect |
| `dmn-drift` | `05` | Self-model drift bounded; adversarial resisted | Bounded, non-escalating |
| `persona-effect` | `06` | Real persona shapes voice vs generic | Above-chance voice-match |
| `persona-drift` | `06` | Persona drift bounded; conscience primacy holds | Bounded; 100% value-violation rejection |
| `hippo-effect` | `07` | Working memory preserves early-session facts | Significantly better recall |
| `hippo-consolidation-input` | `07` | Cortex writes traceable to working memory | ≥95% traceable |
| `cortex-retrieval-quality` | `08` | Cortex finds needles, surfaces contradictions | ≥90% needle; contradictions flagged |
| `cortex-latency` | `08` | Retrieval is LLM-free-fast | p95 <200ms (10k nodes) |
| `cortex-consolidation` | `08` | Cortex converges, not bloats | Dup rate ↓; contradictions resolved |
| `cortex-effect` | `08` | Cortex enables multi-session recall | Significant vs off |
| `bg-detection` | `09` | Learning detector recalls strategies, few FPs | ≥80% recall; ≤10% FP |
| `bg-authoring` | `09` | Authored skills pass quality rubric | ≥85% usable |
| `bg-skill-effect` | `09` | Authored skills improve future outcomes | Measurable improvement |
| `bg-library-health` | `09` | Library dedups/retires; doesn't bloat | Converging |
| `dreaming-effect` | `10` | Dreaming produces real, consolidated change | Non-empty curated stores; evolved models |
| `gate-integrity` | `10` | Every evolvable write routes through gate | 100% (static + dynamic) |
| `autonomy-behavior` | `10` | Semi reviews all; true commits non-outliers; outliers surface | 100% per spec |
| `drift-bounded` | `10` | Drift bounded; adversarial resisted | Bounded; outliers flagged |
| `evolution-improves` | `10` | Dreamed instance beats fresh on accumulation workload | Significant improvement |
| `rollback` | `10` | Any prior version restores in one command | 100% |

### 4.3 Cross-cutting suites
- **`end-to-end-turn`** — a full turn under a realistic config; asserts no loop regressions, correct assembly order, hooks fire, latency within budget. The integration test.
- **`mode-switch`** — changing Cognitive State mid-session takes effect on the next turn and is logged.
- **`multi-instance-isolation`** — two instances (Zoe, Atlas) in the same process evolve independently; no cross-contamination of Cortex/persona/skills.

---

## 5. Acceptance gates — when a component may ship

A component is "shipped" (enabled by default, documented as a feature) only when its acceptance gate passes. The gates are tiered by risk.

### 5.1 Tier 1 — correctness (must pass before merge)
- Unit tests for contracts (§4 of each component doc).
- Determinism where claimed (RAS scoring, valence tagging, gate routing).
- No loop regressions (`end-to-end-turn`).

### 5.2 Tier 2 — mechanism (must pass before enabling by default)
The anti-theatre gate. The component's signature mechanism must be shown to work:
- AMG: `amg-hijack` + `amg-mode-resistance` + `amg-weight-sweep`.
- RAS: `ras-retrieval-quality` + `ras-filter-sweep` + `ras-latency`.
- DMN: `dmn-self-model-effect` + `dmn-mode-sweep`.
- Conscience: `conscience-red-team` + `conscience-leakage`.
- (etc., per the table.)

**A component whose Tier-2 suites fail ships disabled (behind a flag) and is documented as experimental.** It does not ship as a claimed capability.

### 5.3 Tier 3 — longitudinal (monitored in operation, not blocking ship)
- `*-drift`, `*-tuning`, `*-library-health`, `evolution-improves`.
- These require extended operation to evaluate. They run continuously against accumulated data; regressions open issues but don't block initial ship. **They are the long-term honesty check:** if `evolution-improves` never turns positive, the self-improvement thesis is empirically failing and that is reported, not hidden.

### 5.4 The rework loop
A failed suite doesn't just block — it triggers rework per a documented decision tree:
- Weight-sweep flat → move mechanism from framing to deterministic detection, or remove the weight.
- Paired-comparison null → the component isn't contributing; investigate whether it's mis-assembled or genuinely useless.
- Latency over budget → re-architect the hot path (e.g. cache, precompute, degrade gracefully).
- Drift unbounded → tighten bounds, increase review, or disable autonomy for that component.

---

## 6. What we can and cannot yet measure (honest accounting)

### 6.1 Measurable now (given the harness)
- Weight→behavior deltas (sweeps).
- Veto/escalation firing rates and false-positive rates.
- Retrieval precision/recall and latency.
- Conscience gate integrity (static + dynamic).
- Rollback correctness.
- Cost and latency of every mechanism.

### 6.2 Measurable with effort (corpus-dependent)
- Voice-match (needs a validated judge rubric).
- User-need-addressed (needs labeled needs).
- Self-model/persona quality (needs longitudinal corpora + rubrics).
- Skill authoring quality (needs the `bg-skill-effect` workload).

### 6.3 Genuinely hard / open
- **"Does the instance actually improve over time?" (`evolution-improves`)** — the central promise. Requires a meaningful accumulation workload and long observation. May be inconclusive in v1. We build the *infrastructure to answer it*; we do not promise the answer.
- **Subjective user value** — does a user with an evolved Zoe have a better experience than with a fresh one? Ultimately a human-judgment question; the quantitative suites approximate it but don't replace it.
- **Long-tail safety** — rare adversarial cases the red-team corpus doesn't cover. Defense-in-depth (Conscience + AMG + permission.ts) is the mitigation; full coverage is asymptotic, not achievable.

The docs call these out as open precisely because hiding them would be the deepest form of theatre.

---

## 7. Operationalizing the framework

### 7.1 CI integration
- Tier-1 suites run on every PR; regressions block merge (mirrors the existing "CI gates publish on test pass" convention).
- Tier-2 suites run on changes to the relevant component and pre-release; a component flag may not flip to default-on until its Tier-2 passes.

### 7.2 Continuous eval
- Tier-3 (longitudinal) suites run on a schedule against accumulated instance data (in dev/staging; never sending user data to external judges without consent). Dashboards track `evolution-improves`, drift rates, library health.

### 7.3 Failure as signal, not shame
A failing suite is the system working as designed — it caught theatre. The culture around this framework treats failures as actionable rework triggers, not reasons to soften the target. **A relaxed target is a form of theatre.**

### 7.4 Versioning the corpus
The corpora are versioned. A mechanism tuned against corpus v1 may regress against v2 as it grows; re-tuning is expected. Corpus growth is how the architecture matures.

---

## 8. Relationship to the existing test suite

Zoe has a partial Vitest suite (322 tests / 33 files) covering P0/P1 areas. The eval framework is **additive**, not replacing:
- **Vitest unit/integration tests** → Tier-1 (correctness). The BMI's contracts get unit tests in the same style; these join the existing suite.
- **Eval harness suites** → Tier-2/Tier-3 (mechanism/longitudinal). These are heavier (multi-run, LLM-judge, statistical) and run via a separate `pnpm eval` entrypoint, not in the fast unit suite. They share the Vitest runner where it fits but are organized as the `eval/` namespace.

The convention: `pnpm test` for correctness (fast, blocking); `pnpm eval` for mechanism validation (slower, pre-release + scheduled). Both gate the right things at the right times.

---

## 9. Open questions & risks

1. **LLM-judge reliability.** Qualitative rubrics (voice-match, user-need) depend on a judge model that itself has biases and variance. Mitigation: validate judges for consistency, prefer rule-based metrics where possible, report judge model + version with results.
2. **Cost of running the suites.** Tier-2/3 suites make many LLM calls. This is real cost. Mitigation: run them on a cheaper "eval model" where the phenomenon is model-agnostic; reserve expensive runs for the ship gate.
3. **Goodhart's law.** When a metric becomes a target, it ceases to be a good metric. The suites measure proxies for value, not value itself. Mitigation: multiple suites per component (so gaming one doesn't game the phenomenon); periodic human audit of whether suite-passing still corresponds to real capability.
4. **Corpus drift vs mechanism drift.** As corpora grow, old mechanisms may look worse not because they degraded but because the corpus got harder. Versioning corpora and reporting results against specific versions keeps this interpretable.
5. **The central promise may be falsified.** `evolution-improves` may not turn positive, or may only in narrow domains. The framework commits to reporting this honestly rather than relaxing the target. This is the integrity boundary of the whole project.
6. **Adversarial coverage is asymptotic.** No red-team corpus is complete. The framework measures coverage we *have*, not coverage we *need*. The defense is layered (Conscience + AMG + permission.ts), not the corpus alone.

---

## 10. Summary — the one rule

Every claim in `00`–`10` is either measured by a suite in this doc, or explicitly flagged as open. There is no third category of "claimed but unmeasured and un-flagged." That third category is theatre, and this framework exists to make it impossible to ship.

*A mechanism that cannot be shown to move a metric does not ship. It is reworked or cut.*

---

*Depends on: every component doc (`02`–`10`), which define the suites run here.*
*This doc is referenced by every component's §9 (Verification) and by the acceptance gates in `10`. It is the enforceable contract that the BMI is engineering, not storytelling.*
