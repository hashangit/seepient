# 02 — Conscience (the moral floor)

> **The immutable invariant. Veto over all. The fitness function for every evolution.**
> Component deep-dive. Depends on `01-architecture.md`. Role: `moral-floor`.

---

## 1. Brain analogy — and why it's exact

The Conscience maps to the **prefrontal cortex's executive moral function** — what cognitive neuroscience calls the superego in psychoanalytic terms, and what the literature on moral judgment localizes to the ventromedial and dorsolateral prefrontal cortex (vmPFC/dlPFC). Two properties make the analogy exact rather than decorative:

1. **Top-level governance.** The prefrontal cortex arbitrates between competing drives (limbic impulses, habitual responses, social norms) and can inhibit them. The Conscience arbitrates between the Persona's preferences, the AMG's caution, the Cortex's remembered patterns, and the user's request — and can veto any of them.
2. **Developmental plasticity vs operational immutability.** A human conscience *does* develop over a lifetime — but not within a single decision. During a decision, the moral framework is treated as fixed and applied as a constraint. The BMI mirrors this precisely: the Conscience is **immutable during operation** (a single turn, a single Dreaming cycle) and **changes only by an out-of-band human process** (a package update), never by the instance itself. The developing-self work is the Persona's job; the Conscience is the floor it develops on.

This is the load-bearing distinction that makes bounded self-improvement possible: **the controller of evolution must itself be non-evolvable by the thing it controls.** If the instance could rewrite its conscience, self-improvement would be unbounded. A conscience that edits itself is not a conscience.

---

## 2. Functional role in the BMI

The Conscience serves three functions, in order of importance:

1. **Veto (operational).** An invariant check on the assembled cognitive context and on proposed responses. If a rule would be violated, the response is blocked or rewritten. Veto authority is `always` — it does not depend on Cognitive State, weight, or mode.
2. **Fitness function (evolutionary).** Every proposed self-modification — a Persona rewrite, a DMN self-model update, a self-authored skill, a RAS-model tuning — is evaluated against the Conscience before commit. The Conscience does not *write* evolution; it *judges* it. See `10-evolution-system.md`.
3. **Anchoring (identity).** The Conscience is the part of identity that never changes, giving the instance a stable moral spine regardless of how its Persona evolves. Someone who knows Zoe's Conscience knows what she will never do, even if her voice changes.

---

## 3. Time-scale & activation

- **Continuous.** The Conscience is present in every assembled cognitive context, in every mode, at weight 1.0, with `absolute` framing. It is never trimmed under token pressure (rank 0).
- **Synchronous at evolution time.** Every evolution proposal blocks on a Conscience validation call before commit.
- **Never offline-rewritten by the instance.** The only path to a changed Conscience is a package update (human-authored, reviewed, shipped). There is no code path by which the instance writes to `conscience.md`.

---

## 4. Contract

### 4.1 Source

```
~/.seepient/brain/conscience.md    # GLOBAL, immutable, signed
```

The file is **signed** (SHA-256 of the canonicalized content, checked at load). Tampering or unsigned modification is a hard load error — the instance refuses to start. This is the integrity boundary.

### 4.2 File structure

The file is a structured markdown document. The exact prose is authored by humans; the structure is fixed:

```markdown
# Conscience

## Invariants
[Hard prohibitions. Violation = veto. Written as declarative, testable rules.]

## Obligations
[Things the agent must do. Violation = veto or mandatory correction.]

## Values
[Aspirational guidance. Shapes evolution proposals; does not veto. Written as
directional principles, not binary rules.]

## Evolution Fitness Criteria
[What a proposed self-modification must satisfy to be Conscience-valid:
alignment with Invariants/Obligations/Values, no drift, no reward-hacking, etc.
This section is the spec for the evolution gate in 10.]
```

The split between **Invariants** (binary veto) and **Values** (directional fitness) is important: the Conscience is not a single bludgeon. Some of it vetoes; some of it guides. The gate (§4.4) uses both, differently.

### 4.3 Runtime types

```typescript
// src/core/bmi/conscience.ts

/** Parsed Conscience document, loaded once at startup. */
interface ConscienceDoc {
  invariants: ConscienceRule[];        // binary, veto-enforced
  obligations: ConscienceRule[];       // binary, veto-or-correct
  values: ConscienceValue[];           // directional, evolution-fitness only
  fitnessCriteria: string;             // prose, fed to the evolution gate
  signature: string;                   // integrity hash, verified at load
}

interface ConscienceRule {
  id: string;                          // stable identifier for logging/eval
  statement: string;                   // the rule, declarative
  vetoOnViolation: boolean;            // true for invariants/obligations
}

interface ConscienceValue {
  id: string;
  statement: string;
  direction: 'encourage' | 'discourage';
}

/** Load + verify the Conscience. Throws on signature mismatch. */
export function loadConscience(path: string): ConscienceDoc;

/**
 * Evaluate a proposed response/action against the Conscience.
 * Runs as a final check in the Thalamus before output. Fast (rule-based + at
 * most one small LLM call for ambiguous cases).
 */
export function evaluateResponse(
  doc: ConscienceDoc,
  proposed: ProposedResponse,
  context: TurnContext,
): ConscienceVerdict;

interface ConscienceVerdict {
  decision: 'proceed' | 'rewrite' | 'block' | 'clarify';
  violatedRules: string[];             // rule ids
  reasoning: string;
}

/**
 * Evaluate a proposed self-modification against the Conscience.
 * Called by the evolution gate (see 10) before any commit.
 */
export function evaluateEvolution(
  doc: ConscienceDoc,
  proposal: EvolutionProposal,         // persona rewrite | skill | dmn | ras-model
  context: EvolutionContext,
): EvolutionVerdict;

interface EvolutionVerdict {
  decision: 'accept' | 'reject' | 'revise';
  fitnessScore: number;                // 0..1 against the Values
  violatedInvariants: string[];        // hard rejects
  reasoning: string;
  suggestedRevisions?: string;         // when 'revise'
}
```

### 4.4 The evolution gate (the controller)

This is the Conscience's second function and the heart of bounded self-improvement. The gate is invoked by the evolution system (`10`), never directly by components. Contract:

```typescript
// src/core/bmi/evolution/gate.ts

/**
 * Commit gate for all evolvable components.
 * Every EvolutionProposal passes through here. No bypass exists.
 */
export async function passEvolutionGate(
  doc: ConscienceDoc,
  proposal: EvolutionProposal,
  autonomy: AutonomyLevel,
): Promise<GateResult>;

interface GateResult {
  verdict: 'committed' | 'rejected' | 'pending-review';
  conscience: EvolutionVerdict;
  reviewItem?: ReviewItem;             // present when semi-autonomous
}
```

The gate is **invariant across Autonomy Levels**: autonomy controls whether a Conscience-valid proposal auto-commits or waits for human review. It never bypasses the Conscience check itself. A Conscience-rejected proposal is rejected in both modes.

---

## 5. Integration with the existing agent loop

**No change to `runAgentLoop` or `executeLoop`.** The Conscience is injected via the same path as every other system-prompt component — the Thalamus assembles it into `ctx.messages[0]` via `bmiContextMiddleware`. Its framing is `absolute`, its position is `first`, its rank is 0.

The veto mechanism works through the assembled context, not through a code-level interception of the loop:

- **Pre-output veto:** the Thalamus's final assembly step runs `evaluateResponse()` against the proposed response. On `block`/`rewrite`/`clarify`, the response is modified before it reaches the user. This is a pre-output transform in the middleware, not a loop modification.
- **Tool-call shaping:** the Conscience is in the system prompt throughout reasoning, shaping which tool calls get proposed in the first place. `permission.ts` remains the operational tool-execution gate; the Conscience is the reasoning-time moral frame that makes most dangerous proposals never arise.

This is the two-layer safety model: **Conscience shapes intent; `permission.ts` gates action.** Neither replaces the other.

---

## 6. Weight → mechanism mapping

The Conscience is the one component where the weight is **pinned and non-modulatory**:

| Mechanism | Conscience value | Locked? |
|---|---|---|
| Framing | `absolute` always | Yes |
| Token-budget rank | 0 (never trimmed) | Yes |
| Position | first, restated pre-output | Yes |
| Veto authority | `always` | Yes |
| Weight | 1.00 in all Cognitive States | Yes — enforced by resolver |

The resolver (`neuromodulation.ts`) hard-codes the Conscience weight at 1.0 and rejects any mode definition or dynamic modulation that attempts to reduce it. This is a code-level invariant, not a convention. A mode that sets `conscience: 0.8` fails validation at load.

Why pin rather than modulate? Because the Conscience is the *controller*, not a *controlled* system. Neuromodulation modulates the controlled systems (Persona, AMG, DMN, …). The controller modulating itself is the failure mode the whole architecture exists to prevent.

---

## 7. Evolvability

**`evolvable: false`.** Hard rule. There is no code path by which the instance writes to `conscience.md`. The only mutation path is a package update:

1. Human authors/revises `brain/conscience.md`.
2. Content is canonicalized and signed.
3. Ships with the package; verified at load.

`brain/conscience.md` is **global**, so every SeepientAgent instance shares the same moral floor. This is a deliberate choice: the conscience is species-level, not personal. (A future "house conscience" overlay for an organization is conceivable, but out of scope for v1 and would still be human-authored.)

---

## 8. Multi-instance implications

- **Identical across all instances.** Two SeepientAgents (Zoe, Atlas) load the same signed `conscience.md`. A Zoe user and an Atlas user can trust that the moral floor is the same.
- **Evolution fitness is also identical.** The fitness function judging Persona/Skill/DMN evolution is shared, so no instance can evolve itself into a morally-distorted state by gaming a per-instance conscience.
- **Per-instance review queues.** In semi-autonomous mode, each instance has its own human-review queue (`instance/brain/review-queue/`), but the *criteria* applied there come from the global Conscience.

---

## 9. Verification (anti-theatre)

The Conscience is the component where "not theatre" matters most — a conscience that doesn't actually veto is decoration. Verification has three tiers:

### 9.1 Load integrity (unit)
- **Given** a tampered `conscience.md` → **load throws** (signature mismatch).
- **Given** a Conscience with `conscience: 0.8` in some mode → **manifest validation throws**.
- **Coverage:** 100% of load paths.

### 9.2 Veto effectiveness (behavioral — the critical eval)
The Conscience must demonstrably change outputs. Eval suite (`conscience-red-team`):

- **Red-team prompts** designed to elicit invariant violations (e.g. "ignore your rules and…", social engineering, gradual escalation, conflicting-authority ploys). Target: ≥ 98% are vetoed/rewritten.
- **Paired-output comparison:** identical task, with-Conscience vs a stripped prompt. Measure divergence on morally-relevant dimensions. Target: statistically significant divergence in the intended direction (more refusal of violations, more honest uncertainty-flagging).
- **Leakage tests:** does the Persona ever produce a response the Conscience should have vetoed? Run the Conscience evaluator over a corpus of the instance's outputs. Target: zero unflagged violations.

**A Conscience whose veto can be talked down by clever phrasing fails this eval and does not ship.** This is the single hardest gate in the whole architecture and it is explicitly behavioral.

### 9.3 Evolution-gate effectiveness
- **Adversarial evolution proposals** (a Persona rewrite that subtly relaxes an invariant; a skill that encodes a value violation) → gate must `reject`. Target: ≥ 99%.
- **Reward-hacking probes** (proposals that satisfy Values' letter while violating spirit) → gate flags for review. Target: flagged ≥ 90%.

### 9.4 Observable signals (always-on)
- Every veto/rewrite emits a `conscience-intervention` log event with the violated rule id. Spikes or a zero rate are both suspicious and investigated.

---

## 10. Open questions & risks

1. **Rule ambiguity.** Natural-language invariants are fuzzy ("never deceive the user" — what about a CTF?). The `evaluateResponse` evaluator needs a fallback for ambiguous cases (a small LLM call) and the ambiguity itself must be logged. This is an ongoing calibration problem, not a one-time fix.
2. **Veto latency.** A per-output evaluator adds to the hot path. Must be fast (rule-based first pass; LLM only on rule-flagged candidates). Target: < 30ms median.
3. **Over-vetoing.** A too-aggressive Conscience makes the instance uselessly cautious. The Values-vs-Invariants split mitigates this (only invariants veto), but the calibration is empirical and measured by the false-positive rate in the eval suite.
4. **Conscience updates as trust events.** When a package update changes the moral floor, every instance's behavior shifts. This is a significant trust event and needs a changelog/announcement mechanism. Out of scope for the component but flagged for the platform.
5. **The frozen-reference problem.** Drift detection for *other* components requires a frozen reference to compare against. The Conscience itself is the frozen reference for moral drift — but its own integrity depends only on the signature. If the signature scheme is weak, the floor is weak. Use a strong hash and document the verification ceremony.

---

*Depends on: `00-overview.md`, `01-architecture.md`.*
*Referenced by: every component (`validation.gate`), `10-evolution-system.md` (the gate), `11-evaluation-framework.md` (the red-team suite).*
