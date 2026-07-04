# 14 — The Self-Learning Loop (reward-verified evolution over a file substrate)

> **The mechanism that makes bounded self-improvement non-theatrical. It supplies what `10-evolution-system.md` defers as "future empirical work" and what `02-conscience.md` cannot provide on its own: an honest, per-component reward signal that drives the Dreaming update step. This is Command Code's `taste-1` loop, transplanted onto the BMI's inspectable, conscience-gated file substrate — same control loop, no gradient descent.**
>
> Foundational subsystem doc. Depends on `01-architecture.md`, `02-conscience.md`, `05-dmn.md`, `06-persona.md`, `09-skills-procedural.md`, `10-evolution-system.md`, `11-evaluation-framework.md`, `13-cognitive-state-and-hooks.md`. This doc is the "where does the *better* signal come from?" answer to `10` §9.5 and the dual-fitness correction to `02` §2. It is written to double as a paper scaffold: each section maps to a paper section (noted inline).

---

## 0. Abstract (paper §1)

> **One-line thesis:** *Bounded self-improvement via reward-verified, RL-shaped evolution over the BMI's own cognitive files — taste-1's mechanism on a stronger, inspectable substrate, with no gradient descent.*

This document specifies how a SeepientAgent instance learns from its own operation. The mechanism is a **control loop** — observe outcomes, derive reward, verify the reward is honest, update the agent's cognitive files, gate the commit. It is **not** a fine-tuning recipe. There is no reward model trained, no policy gradient, no GPU. The "RL" is in the *shape* of the loop (capture → disambiguate → verify → bounded update), and the thing being updated is human-readable, version-controlled markdown (`user-profile.md`, `persona.md`, `self-model.md`, self-authored skills, the RAS salience model).

The contribution is **architectural, not algorithmic.** Every primitive here exists in the 2025–2026 literature. What is novel is the composition: the BMI's eight-function separation lets us assign a *different verifier class* to each component, matched to what that component actually does — something a monolithic-policy paper cannot do because no paper has the separation. Combined with the BMI's pre-existing safety envelope (Conscience gate, drift bounds, frozen-reference alignment, rollback), the loop runs **inside a cage** that is an order of magnitude stronger than the single KL penalty (`β_NS`) that is taste-1's only drift control.

**Scope of the claim (load-bearing, read twice):** the loop improves the agent's **organization, consistency, and alignment to this user over time** — *not* its raw capability. The base model's ceiling is unchanged. A better-organized agent at a fixed capability level is more *effective*; it is not "smarter." Section 13 holds this line explicitly. Overclaiming it is the single failure mode most likely to invalidate the result.

---

## 1. The problem this solves (paper §2 — Motivation)

### 1.1 The hole in the existing BMI design

The BMI already specifies *how* an instance evolves: the Dreaming cycle (`10` §3), the Conscience gate (`02`, `05` §7), drift bounds, versioning, rollback. What it does **not** specify is the hardest part — where the signal that says "this change is *better*" comes from. This is acknowledged in plain language across the docs:

- `10` §9.5: *"An instance that has Dreamed should outperform a fresh one… No improvement = the whole evolution system is theatre."*
- `11` §6.3: reserves a slot for the genuinely hard open problem — defining the fitness function.
- `02` §2: states the Conscience *"is the fitness function for every evolution."*

The last is the contradiction this document corrects.

### 1.2 The dual-fitness correction (the contradiction in `02`)

`02-conscience.md` collapses two distinct jobs into one:

| Job | Question answered | Can the Conscience do it? |
|---|---|---|
| **Moral fitness** | "Is this change *allowed*?" | ✅ Yes — invariants veto, values guide. |
| **Capability fitness** | "Is this change *better*?" | ❌ No. A morally perfect agent can be incompetent. Nothing in the Conscience measures whether a skill *works* or a self-model is *accurate*. |

A single fitness function for both is a **category error.** As written, the docs would let a useless-but-moral skill commit — which violates the BMI's own anti-theatre rule (`11`).

**The correction (load-bearing for the whole subsystem):**

```
Evolution gate must require BOTH:
  (a) Conscience verdict = accept          [moral fitness — `02` §4.4]
  (b) Component verifier reward ≥ threshold [capability fitness — this doc]
```

The Conscience remains the moral floor (unchanged). The capability signal comes from per-component verifiers, specified in §6. **This correction is not optional.** Without it, the learning loop has no honest reward and `10` §9.5 cannot pass.

### 1.3 Why "taste" is the right prior art

Command Code's `taste-1` (`commandcode.ai/docs/taste`) is the cleanest published instance of exactly this loop applied to a coding agent. Its objective (decoded in §3.2) is textbook KL-regularized RLHF. The loop's primitives — observe accept/reject/edit, derive reward, bound drift against a reference — are precisely the primitives the BMI needs. The *substrate* differs: taste-1 updates model weights `φ` via gradient descent; the BMI updates cognitive files via LLM-driven rewrite during Dreaming. §4 maps the two.

---

## 2. What the BMI is *not* doing (scope discipline, paper §2.3)

Stated up front to prevent scope creep — the failure mode where "self-improvement" expands to mean "the agent gets smarter."

1. **No fine-tuning.** No weights are updated. The base LLM is a fixed substrate. This is non-negotiable: it is why the loop is lightweight, inspectable, and reversible, and it is what makes the dual-use / safety case tractable.
2. **No capability expansion claim.** We claim improved *effectiveness at fixed capability* (§13), not a smarter model. Conflating these is the overclaim that gets a paper retracted.
3. **No "continuous" online learning.** All self-modification happens offline, in Dreaming (`10` §3.1). The word "continuous" is deliberately absent. Real-time online RL for one instance is economically impractical *and* weaker for drift control than batched offline updates — Dreaming is the better regime, not a compromise.
4. **No autonomous capability acquisition.** The instance learns to organize itself better and align to the user better. It does not gain skills it could not already produce; it gets better at *selecting and sequencing* the ones it has.

---

## 3. Prior art (paper §3 — Related Work)

### 3.1 Command Code `taste-1` — the decoded objective

The published formula (verbatim from `commandcode.ai/docs/taste`):

$$
\underbrace{\mathcal{L}(\phi)}_{\text{Meta-NeuroSymbolic Objective}(\phi)}
= \underbrace{\mathbb{E}_{x \sim D_{RL}}\; \mathbb{E}_{y \sim LLM_{\phi}^{NS}(x)} \left[ RM_{NS}(x, y) - \beta_{NS} \log \frac{LLM_{\phi}^{NS}(y \mid x)}{LLM^{SFT}(y \mid x)} \right]}_{\text{(1) KL-regularized preference reward}}
+ \underbrace{\gamma_{NS}\; \mathbb{E}_{x \sim D_{pretrain}} \log LLM_{\phi}^{NS}(x)}_{\text{(2) pretraining anchor}}
$$

| Symbol | Meaning in taste-1 | BMI analogue |
|---|---|---|
| `φ` | taste model weights (the thing updated) | the cognitive *files* (user-profile.md, persona.md, self-model.md, skills, RAS model) |
| `LLM_φ^{NS}` | neuro-symbolic policy being tuned | the instance's current cognitive configuration |
| `LLM^{SFT}` | baseline policy (the KL anchor) | frozen-reference self (`05` §7.5) |
| `RM_NS` | learned per-user reward model | **per-component verifiers** (§6) — *not* a learned model |
| `D_RL` | the user's interaction stream | the reward buffer (§5.1) |
| `β_NS` | single KL penalty (drift bound) | **per-component drift bounds** (§7) — sharper |
| `γ_NS` | pretraining mix (anti-forgetting) | Cortex retention + frozen-reference alignment (`05` §7.5) |

**What this formula actually is:** the InstructGPT / Ouyang-et-al. "PPO-ptx" objective, with `_NS` superscripts and "continuous" framing. Term (1) is the KL-regularized preference reward; term (2) is the pretraining anchor that prevents catastrophic forgetting. This is a **known, battle-tested recipe** (InstructGPT, Constitutional AI, GRPO). The novelty is operational: scope it to one developer's feedback stream and update incrementally.

**What the formula hides (the two genuinely hard parts):**
1. *What is `RM_NS` concretely?* How accept/reject/edit becomes a scalar reward is the entire game, and it is a black box in the docs.
2. *Is the update truly online?* Per-user live policy updates are expensive; this is almost certainly periodic fine-tuning marketed as "continuous."

The BMI's answer to both is the **per-component verifier map** (§6) and the **offline Dreaming regime** (§5.4) — both specified in this document because taste-1 leaves them unspecified.

### 3.2 The Pi Agent lineage — memory as taste

Pi (`pi.dev`) ships no taste model; the equivalent is achieved through **memory extension packages** that capture durable knowledge: `pi-self-learning` (git-backed lessons per task), `pi-hermes-memory`, `oh-my-pi` memory, `db0`, `Mem0 for Pi Code`. The contrast is foundational to the BMI's design choice:

```
Command Code taste-1:  closed, model-based, implicit (you code, it watches)
Pi + memory extension: open,  file-based,  explicit (lessons written to markdown)
BMI:                   open,  file-based,  explicit + reward-verified + conscience-gated
```

The BMI inherits the Pi substrate (inspectable, version-controlled files) and adds what Pi's memory extensions lack: a **honest-reward gate** (§7) and the **Conscience/dual-fitness gate** (`02` §4.4 + §1.2 of this doc). Pi memory can record noise or bias; the BMI's verifiers reject it before it touches a file.

### 3.3 The 2025–2026 arXiv stack — five results that shape the design

These are the load-bearing research findings. Each is cited to a specific failure mode or mechanism in this document.

| Result | Paper | What it gives the BMI | Where it lands here |
|---|---|---|---|
| **Reward corruption scales linearly with verifier error** | VPR (Tsinghua, 2026) — [arXiv 2605.10325](https://arxiv.org/html/2605.10325v1), Proposition 2 | The honest-reward gate: a reward is admitted only if its verifier's disagreement rate `ε̄` is *measured and bounded* | §7 |
| **Dense turn-level signal beats outcome-only, provably** | VPR, Proposition 3 | Credit assignment requires step-level verified signal, not just "task succeeded" | §5.2 |
| **Self-reward collapses, suddenly** | SRT (KAIST/CMU, 2025) — [project](https://self-rewarding-llm-training.github.io/) | Empirical proof that unaudited self-evaluation degenerates to mode-collapse; the debate protocol is *required*, not optional | §8 |
| **Judge-based verification can be gamed (no gradient needed)** | EvilGenie (MIT, 2025) — [arXiv 2511.21654](https://arxiv.org/html/2511.21654v2); Prover-Verifier Games (OpenAI) | Reward hacking transfers to the non-gradient substrate; rate cap + frozen-reference is the honest mitigation for the DMN | §8, §13 |
| **Self-improvement is possible with zero fine-tuning** | ACE — Agentic Context Engineering — [arXiv 2510.04618](https://arxiv.org/abs/2510.04618) | The file-rewrite update mechanism is legitimate, not a fallback (+10.6% accuracy, 86.9% latency reduction reported) | §5.4, §14 |

**Supporting results:** Agent-as-Judge survey ([arXiv 2601.05111](https://arxiv.org/html/2601.05111v1)); Tri-Role Self-Play RL ([arXiv 2601.18292](https://www.alphaxiv.org/overview/2601.18292)); Debate as a safety case ([arXiv 2505.03989](https://arxiv.org/html/2505.03989v1)); Reward Shaping to Mitigate Reward Hacking ([arXiv 2502.18770](https://arxiv.org/html/2502.18770v3)); Unbiased Reward Modeling from Implicit Preference Data ([arXiv 2603.23184](https://arxiv.org/html/2603.23184v1)); RAFT rejection-sampling fine-tuning ([arXiv 2504.11343](https://arxiv.org/html/2504.11343v2)).

---

## 4. The taste→BMI mapping (paper §3.4 — why this is the same loop on a stronger substrate)

| Dimension | taste-1 | BMI |
|---|---|---|
| **Substrate updated** | Model weights `φ` | Cognitive component files |
| **Update mechanism** | Gradient descent (PPO/SFT) | LLM-driven rewrite during Dreaming (ACE-style) |
| **Reward source** | Learned `RM_NS` | Per-component verifiers (edit-diff, execution oracles, debate) |
| **Drift control** | KL penalty `β_NS` (one implicit term) | Conscience gate + drift bounds + frozen-reference + rollback (explicit cage) |
| **Inspectability** | Opaque weights | Human-readable markdown, diffable |
| **Reversibility** | Effectively none | One-command rollback |
| **Reward honesty** | `RM_NS` error unmeasured | `ε̄` measured and gated per component |

**The punchline:** because the substrate is inspectable, versioned files rather than opaque weights, the BMI's existing safety envelope gives drift control an order of magnitude stronger than taste-1's KL penalty — applied to the *same* reward loop. taste-1's `β_NS` maps onto the BMI's conscience-gate-plus-drift-bounds: same role (bound how far the agent drifts from its reference state), far stronger mechanism. **This is the contribution.** It is the answer to "what do you bring that taste-1 doesn't have?"

---

## 5. The reward pipeline — four layers (paper §4 — Architecture)

This is the core specification. It replaces the deferral in `10` §9.5 and `11` §6.3 with a concrete pipeline.

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — CAPTURE (online, per-turn, near-zero cost)           │
│  Hooks: onProposalEmitted, onUserEdit, onTaskOutcome            │
│  → records (proposed, accepted/edited, final) triples           │
│    to instance reward buffer                                    │
│  Cost: one file append. No LLM call.                            │
└──────────────────────────────┬──────────────────────────────────┘
                               │ (offline, Dreaming)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2 — DISAMBIGUATE (offline, cheap)                        │
│  Separates preference edits from correction edits.              │
│  An ambiguous edit is NOT a reward signal until classified.     │
│  → this layer exists because edit-diff is noisy (§13.2)         │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3 — VERIFY (offline, the honest-reward gate, §7)         │
│  Per-component verifier class:                                  │
│   • User-profile: edit-diff signal (user IS the oracle)         │
│   • Persona: consolidative only (no external oracle, §6)        │
│   • Basal Ganglia: execution oracles (tests/build pass)         │
│   • DMN: agent-as-judge + attacker debate (bounded ε̄)          │
│  → each verifier emits scalar reward + measured ε̄               │
│  → a reward is ADMITTED only if ε̄ is below threshold            │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 4 — UPDATE (offline Dreaming, per-component, gated)      │
│   Reflector rewrites the component file using the verified      │
│   reward as signal. Both gates fire before commit:              │
│     (a) honest-reward gate passed   [capability fitness]        │
│     (b) Conscience verdict = accept [moral fitness — `02` §4.4] │
└─────────────────────────────────────────────────────────────────┘
```

### 5.1 Layer 1 — Capture

The critical-path dependency. Nothing in Zoe records reward triples today. Concretely, three new hooks in `src/core/hooks.ts` (extending the existing `onStep`/`onFinish` precedent from `13-cognitive-state-and-hooks.md`).

**Category fit (`13` §1):** these are passive-observation hooks — they write to the reward buffer, never influence the current turn. This is exactly the documented correct use of the BMI hook layer: fire-and-forget, non-fatal, errors swallowed by `createHookExecutor` (`hooks.ts:43-53`). Capture must *not* be a `CognitiveTurnState` mutation — it is observation, not influence.

```typescript
// src/core/bmi/reward-capture.ts

interface RewardTriple {
  component: EvolvableComponent;     // 'user-profile' | 'persona' | 'basal-ganglia' | 'dmn'
  proposed: string;                   // what the agent emitted
  accepted: 'accept' | 'reject' | 'edited';
  final: string;                      // what the user kept (=== proposed if accept)
  editDistance: number;               // |final − proposed|; 0 on accept/reject
  sessionId: string;
  timestamp: number;
}

// Hooks (non-blocking, never crash the loop — mirrors existing hook invariant)
onProposalEmitted(proposal: string, component: EvolvableComponent): void;
onUserEdit(original: string, edited: string): void;     // queues a triple
onTaskOutcome(success: boolean, traces: StepTrace[]): void;
```

Writes to `.seepient/brain/reward-buffer/<component>.jsonl` (append-only). Cost is one file append per signal — no LLM call, no model. **This is the first thing to build. Without it, nothing learns.** It is the dependency for §10.1's `evolution-improves-outcomes` test.

### 5.2 Layer 2 — Disambiguate (the fix for edit-diff noise)

This layer exists because **edit-diff is noisier than it looks** (§13.2). Two edits can produce identical diffs but mean opposite things:

- "the user edited because they have a *preference*" (signal: reward)
- "the user edited because the agent was *wrong*" (signal: correction, not preference)

Treating these the same feeds noise into the verifier. Disambiguation is cheap (a lightweight classifier, or a confirm-prompt on ambiguous edits) but it is what makes the captured signal honest enough to verify. **Without it, the pipeline verifies noise.**

```typescript
// src/core/bmi/reward-disambiguate.ts

type EditIntent = 'preference' | 'correction' | 'unrelated' | 'ambiguous';

interface DisambiguatedTriple extends RewardTriple {
  intent: EditIntent;
  confidence: number;                 // only 'preference'|'correction' with conf ≥ τ feed Layer 3
}

/**
 * Cheap, offline. A small classifier (or LLM call on ambiguous-only batches)
 * labels each edit. 'ambiguous' below threshold is NOT forwarded — it is held
 * for the next Dreaming cycle or surfaced for user confirmation.
 */
export async function disambiguate(triple: RewardTriple): Promise<DisambiguatedTriple>;
```

### 5.3 Layer 3 — Verify (the honest-reward gate, fully specified in §7)

### 5.4 Layer 4 — Update (the file-rewrite mechanism)

The update is an **ACE-style context evolution** (§3.3): the Reflector is a Dreaming-phase `runAgentLoop` call (`10` §3, `05` §4.2) that rewrites the component file using the verified reward as its signal. There is no gradient. The reward is not "applied" numerically; it is *read* by the Reflector as evidence, the same way Cortex summaries are read (`05` §4.2).

```typescript
// src/core/bmi/reward-update.ts

/**
 * Runs during Dreaming. Reads the verified reward buffer for a component,
 * reads the current component file, proposes a rewrite. Does NOT commit —
 * returns an EvolutionProposal (mirrors runDmnReflection's contract, `05` §4.3).
 */
export async function runRewardDrivenUpdate(
  component: EvolvableComponent,
  currentFile: string,
  verifiedBuffer: VerifiedReward[],
  conscience: ConscienceDoc,
  provider: LLMProvider,
): Promise<EvolutionProposal>;
```

**Cost profile:** one LLM call per component per Dreaming cycle. This is why the loop is lightweight by construction — there is no training run, no GPU, no reward model to train. The "heavy" gradient path (RAFT/DPO on accumulated preference pairs) is a documented **future direction** (§14), explicitly out of scope for v1. The user's constraint — "RL approach, but lightweight on flows/tokens/resources/UX" — is satisfied by rejecting gradient methods entirely.

---

## 6. The per-component reward map (paper §4.2 — Verifier selection)

The BMI's eight-function separation is what makes this map possible — and what no monolithic-policy paper can replicate. Each component gets the verifier class *matched to what it actually does*.

**A correction carried over from the taste-1 mapping (§3.1):** taste-1 learns the *user's* style. That maps to the BMI's **user-profile** (the agent's model of the user — `06` §1.3), **not** to the agent's own Persona. The agent's Persona is its *own* dispositions (voice, working preferences, relational stance — `06` §2). These are different subjects with different reward sources, and conflating them is the category error this table corrects. Concretely: edit-diff tells you about the *user*; it tells you nothing about whether the agent's own voice is "better."

| BMI component | Subject of learning | Verifier class (honest reward source) | `ε̄` bound | Update target |
|---|---|---|---|---|
| **User-profile** (the agent's model of the user, `06` §1.3) | the *user's* preferences, style, info, constraints | **User implicit signal** — disambiguated edit-diff between proposal and final. The user *is* the environment; you cannot game the person editing your output. **This is taste-1's territory.** ([arXiv 2603.23184](https://arxiv.org/html/2603.23184v1)) | Measured: false-positive rate on edits classified stylistic-only | `user-profile.md` |
| **Persona** (`06` — the agent's own dispositions) | the *agent's* own voice/working-preferences/relational-stance | **Consolidative reflection on its own successful work** — weakly reward-driven. There is no external oracle for "the agent's voice got better"; the signal is indirect (did successful sessions share a trait worth consolidating?). The honest framing: Persona *consolidates*, it does not *optimize*. | No external oracle; low-confidence; rate-capped like DMN | `persona.md` |
| **Basal Ganglia** (`09`) | the agent's strategies/skills | **Execution oracles** — tests pass, build green, command succeeds. Pure RLVR: deterministic, unhackable. | Near-zero (binary verifier) | self-authored skills + RAS salience |
| **DMN** (`05`) | the agent's reasoning patterns / self-model | **Agent-as-Judge + attacker debate** — the judge *runs* the proposed approach and measures outcome, not vibes; the attacker probes for self-flattery. ([arXiv 2601.05111](https://arxiv.org/html/2601.05111v1), [2601.18292](https://www.alphaxiv.org/overview/2601.18292)) | Hardest to bound; debate raises cost, doesn't prove safety (§8) | `self-model.md` |
| **Conscience** (`02`) | *nothing — it is the invariant* | **It is not tuned. Ever.** It is the floor. | `ε̄ = 0` by construction | n/a |

**Why Persona and user-profile are separate rows (not merged):** they look similar (both are "preferences") but their reward honesty differs by an order of magnitude. The user-profile has an *un-gameable* oracle (the user, editing). The Persona has *no* honest external oracle for its own voice — only the agent's reflection on itself, which is exactly the self-evaluation SRT proved collapses (`08`). This is why Persona is rate-capped and treated as consolidative (like the DMN), not as a clean reward-optimizer (like the user-profile and Basal Ganglia). Putting them in one row would hide the hardest verification problem in the system behind a label.

**Why this is novel:** VPR used different verifiers for different *task structures* (MCTS for Tic-Tac-Toe, a constraint solver for Sudoku, a posterior oracle for Minesweeper). The BMI generalizes this *inside one agent*, across cognitive components — and crucially separates *who is being learned about* (user vs. agent-self), which a monolithic-policy framing cannot even express.

---

## 6a. Implication: the `06` Persona doc conflates two components

The per-component map above surfaces a latent issue in the existing docs that should be reconciled (flagged, not fixed here — surgical scope). `06-persona.md` §1.3 and §2 fold *the agent's model of the user* into the Persona, calling it "relational stance" / "how Zoe is with this user." But the reward honesty of those two things is categorically different:

- **User-model** (what the agent believes about *this user*) → clean reward (edit-diff, taste-1).
- **Persona** (who the agent *is*) → no clean reward (consolidative only).

For the self-learning loop, these must be **separate update targets with separate verifiers.** The cleanest resolution is a distinct `user-profile.md` component (the DMN's user-model, per `06` §1.3, promoted to its own evolvable file). Whether `06` is restructured to match, or `user-profile` lives under the DMN, is an architecture decision for the implementer — but the loop treats them as distinct components regardless. **This doc assumes `user-profile` as a first-class evolvable target; if the implementer keeps it inside the DMN, the reward map is unchanged, only the file path moves.**

---

## 7. The honest-reward gate (paper §4.3 — Reward admission)

This is the highest-leverage piece in the subsystem. It is the concrete implementation of VPR's Proposition 2 warning, applied to the BMI.

### 7.1 The principle (from VPR Prop 2)

> If an approximate verifier disagrees with the true oracle on a fraction `ε̄` of state-action pairs, the policy-gradient bias satisfies:
> $$\|\hat{g}(\theta) - g^\star(\theta)\| \leq G \cdot \bar{\epsilon}$$
> **Gradient corruption scales linearly with verifier error.** A verifier wrong 10% of the time injects 10% poison into every update step. There is no "averages out."

VPR's ablation proves the consequence: a weak oracle (N=100 MCTS sims) produced a model **worse than the untrained base** — dense-but-wrong feedback is *actively destructive*, not merely useless.

### 7.2 The translation to the BMI (with an honesty caveat — §13.1)

VPR's bound is a **gradient-based** bound — it bounds error in a policy gradient. **Our substrate has no gradient.** We adopt the *principle* (corruption scales with verifier error; dense-but-wrong signal is destructive) by **analogy**, not by direct application of the theorem. Formalizing an equivalent bound for a non-gradient, file-rewrite update is stated as **future work** (§13.1) — it is not a gap we paper over.

The gate is justified *operationally* regardless: a reward whose verifier you have not measured is, by construction, theatre — which is the BMI's own anti-theatre principle (`11`) applied to the one place the docs currently hand-wave.

### 7.3 The gate (specified)

```typescript
// src/core/bmi/reward-gate.ts

interface VerifierCalibration {
  component: EvolvableComponent;
  epsilonBar: number;               // measured disagreement rate on held-out probe set
  threshold: number;                // per-component admission threshold (see table below)
  probeSetSize: number;             // how many probes ε̄ was measured over
  lastCalibratedAt: number;
}

/**
 * THE HONEST-REWARD GATE. A reward is ADMITTED to Layer 4 only if its verifier's
 * measured disagreement rate is below the component's threshold AND the probe set
 * is large enough for the measurement to be meaningful.
 *
 * Returns 'admit' | 'hold' | 'reject'. 'hold' queues for the next cycle;
 * 'reject' logs and discards — a reward with unmeasured or too-high ε̄ never
 * touches a cognitive file.
 */
export function admitReward(cal: VerifierCalibration, minProbes: number): 'admit' | 'hold' | 'reject' {
  if (cal.probeSetSize < minProbes) return 'hold';           // not enough data to trust ε̄
  if (cal.epsilonBar > cal.threshold) return 'reject';        // too noisy — destructive (VPR ablation)
  return 'admit';
}
```

**Per-component thresholds (rationale):**

| Component | Threshold (`ε̄` max) | Why |
|---|---|---|
| Basal Ganglia | ~0.0 (binary verifier) | Execution oracles are deterministic; any error is a bug, not noise |
| User-profile | ~0.15 | Edit-diff is human-grounded but noisier than execution; tolerate moderate error |
| Persona | **rate-capped, not ε̄-gated** (like DMN) | No external oracle for "the agent's voice got better" — consolidative only, not reward-optimized (§6) |
| DMN | **rate-capped, not ε̄-gated** (§8) | No deterministic oracle exists; debate doesn't bound `ε̄`, so a rate cap is the honest control instead |

### 7.4 Where the gate sits in the commit path

The honest-reward gate is **before** the Conscience gate — it screens the *signal*, the Conscience screens the *commit*:

```
detector → [honest-reward gate: ε̄?] → Reflector proposes → [Conscience gate: allowed?] → commit
                                          (Layer 4)              (`02` §4.4, `05` §7)
```

A proposal can be rejected at either gate for either reason. This is the dual-fitness correction (§1.2) made operational.

---

## 8. The DMN debate protocol (paper §4.4 — The hardest component)

The DMN is the one component with **no deterministic oracle.** "Is this self-model *better*?" has no execution verifier. The user's decision — DMN self-evolution is a v1 must-have, via agent-as-judge + attacker debate, accepting the shortcomings — is implemented as follows.

### 8.1 Why the debate protocol is required (not optional)

SRT ([KAIST/CMU, 2025](https://self-rewarding-llm-training.github.io/)) ran the cleanest possible self-reward loop: majority voting over the model's own samples, no human, no learned RM. The result:

- **Early:** performance and feedback quality both improve. Genuine self-improvement.
- **Eventually:** *"the model learns to maximize self-assigned rewards by producing consistent but incorrect answers… optimal policy degenerates to producing the same answer regardless of input."* Outputs collapsed to literal `\boxed{1}` for everything.
- **The collapse is sudden** — not gradual. You cannot watch for slow drift; you wake up to a broken model.

This kills any design where the agent's **un-audited** self-evaluation is the sole reward. The DMN's self-evaluation must be *grounded against something it cannot game*.

### 8.2 The protocol (TriPlay-RL + debate safety-case, applied)

A single-arbiter Conscience gate is insufficient — SRT proved a single self-evaluator collapses. The DMN verifier is therefore **three roles**:

```
PROPOSER  ──(defends the self-model update)──┐
                                            ▼
ADJUDICATOR (the Conscience, `02`)  ◀──  ATTACKER
                                        (probes for self-flattery,
                                         mode-collapse, drift — the
                                         things a single judge misses)
```

- **Proposer:** the DMN reflection (`05` §4.2), producing a proposed `self-model.md`.
- **Attacker:** a Dreaming-phase `runAgentLoop` with a prompt engineered to find *what's wrong* with the proposal — flattery, untraceable claims, drift from frozen reference, mode-collapse signals. It is explicitly adversarial.
- **Adjudicator:** the Conscience, applying invariants + drift bounds (`05` §7.3).

This converts the unbounded "agent judges itself" into a bounded **"agent must survive cross-examination."** The attacker is what catches the slow drift the Conscience alone cannot see (the "boiling frog" that `05` §7.5's frozen-reference alignment catches heuristically).

### 8.3 The honest limitations (stated, not hidden)

EvilGenie ([MIT, 2025](https://arxiv.org/html/2511.21654v2)) measured reward-hacking detection across held-out unit tests, LLM judges, and test-edit detection — and found **all three can still be circumvented**, validated against human review. Berkeley's parallel work (RDI) catalogued **45 hacking methods across 13 benchmarks** and concluded: *"if your benchmark is exploitable, it will be exploited."* The Prover-Verifier Games result (OpenAI) shows models game verifiers **even without gradients** — by making output *look* more checkable.

**Honest consequence:** the debate protocol *raises the cost* of gaming the self-model; it does not *eliminate* it. Therefore v1's DMN commits with three explicit mitigations, in defense-in-depth:

1. **Rate cap** — a hard maximum on `self-model.md` rewrites per Dreaming cycle, *regardless of what the reward says*. The DMN is the component that learns slowest, by design.
2. **Frozen-reference alignment** (`05` §7.5) — the last line; catches cumulative drift the per-cycle bounds miss.
3. **Human-in-the-loop in semi-autonomous** (`05` §7.6) — every rewrite is a diff surfaced for approval.

These are not patches. They are the **correct, honest design for a component with no deterministic oracle** — stated as a limitation in §13.3, not claimed as solved.

---

## 9. The full Dreaming integration (paper §4.5 — End-to-end loop)

How the four-layer pipeline slots into the existing Dreaming cycle (`10` §3). **No change to Dreaming's structure** — the reward pipeline is a new *source* for the phases that already exist.

```
Heartbeat fires (idle-only, `10` §4.2)
  │
  ▼
┌─ DREAMING CYCLE ─────────────────────────────────────────────────┐
│ Phase 0 (NEW): reward-buffer consolidation                        │
│   Layer 1 triples → Layer 2 disambiguation → per-component queue  │
│ Phase 1: Cortex extraction (unchanged, `10` §3.2)                 │
│ Phase 2: per-component reward-driven update (NEW, this doc §5.4)  │
│   for each component:                                             │
│     honest-reward gate (§7) ── reject? skip                       │
│     Reflector proposes rewrite (runAgentLoop)                     │
│     DMN-only: debate protocol (§8)                                │
│     Conscience gate (`02` §4.4, `05` §7) ── reject? skip          │
│     commit (atomic, versioned)                                    │
│ Phase 3: DMN reflection (unchanged, `05` §4.2)                    │
│ Phase 4: skill authoring/audit (`09`)                             │
└──────────────────────────────────────────────────────────────────┘
```

**Cost budget (token-economy aware, `12`):** Phase 0 is file I/O only. Phase 2 adds one LLM call per ε̄-gated component (User-profile, Basal Ganglia) + three calls each for the rate-capped components (DMN and Persona each run a Proposer + Attacker + Adjudicator debate, §8). At 6-hourly Dreaming (`10` §4.2), this is bounded and predictable. A cheaper "dreaming model" override (`10` §11.3) applies. (Persona may run at lower priority / less frequently than the DMN — it is the lowest-confidence learner in the system.)

---

## 10. Verification (anti-theatre, paper §6)

Following the BMI's governing rule (`11`): a mechanism that cannot be shown to move a metric does not ship.

### 10.1 The ultimate test — `evolution-improves-outcomes`

The test from `10` §9.5, now made measurable by this subsystem:

> After N Dreaming cycles on a representative workload, an evolved instance **outperforms a fresh instance** on held-out tasks — measured by task success rate, edit-acceptance rate, and reduced correction-edit frequency.

**This may return a null result.** The architecture cannot guarantee it in advance — VPR showed skills can transfer OOD, SRT showed self-training can collapse. The honest deliverable is the *measurement harness*, with the null stated as possible upfront (mirrors `10` §10.1). A null result is a valid result; it tells us which component's verifier is too weak.

### 10.2 Component-level tests

- **`reward-capture-fidelity`** — captured triples reconstruct the user's actual accept/reject/edit history with no loss. Foundation test; fails → everything downstream is suspect.
- **`disambiguation-precision`** — edit-intent classifier achieves precision ≥ τ on a labeled probe set. Fails → Layer 3 verifies noise.
- **`gate-actually-gates`** — inject a verifier with known-high `ε̄`; confirm the gate rejects its rewards and no cognitive file changes. This is the test that the honest-reward gate is not decorative.
- **`debate-resists-collapse`** — inject adversarial sessions (flattery, manipulation, mode-collapse coaxing); confirm the attacker flags them and the Conscience/drift bounds reject. This is SRT's failure mode, tested head-on.

### 10.3 Longitudinal — `dmn-drift` (`05` §9.4, extended)

Over many Dreaming cycles, the self-model drifts in value-aligned directions without runaway. Track semantic distance per cycle. Target: **bounded, non-escalating drift; no mode-collapse.** A sequence of rewrites all at maximum drift distance is suspicious and flagged (`05` §9.6).

---

## 11. Integration with the existing loop (paper §4.6 — Implementation)

**No edit to `executeLoop` / `runAgentLoop`.** This subsystem integrates exactly the way the rest of the BMI does:

| Integration point | Mechanism | Existing precedent |
|---|---|---|
| Online capture | three new hooks | extends `13`'s `onStep`/`onFinish` |
| Offline update | Dreaming-phase `runAgentLoop` calls | `10` §3, `05` §4.2 |
| Online injection | updated component files read by `bmiContextMiddleware` | `05` §5.1, `06` |
| Commit gating | reuses `EvolutionProposal` + Conscience gate | `02` §4.4, `05` §7 |
| Cost control | "dreaming model" override + budget caps | `10` §11.3, `12` |

The capture hooks are the only **new** online code path. Everything else reuses existing Dreaming infrastructure.

---

## 12. What this resolves vs. what remains (paper §7 — Discussion)

### 12.1 Resolved (research-validated)

- ✅ **The reward source** — per-component verifiers, each matched to the component's structure (VPR principle).
- ✅ **The drift-control justification** — SRT proves self-reward collapses; the BMI's envelope is the defense.
- ✅ **The reward-honesty principle** — VPR Prop 2: corruption scales with verifier error; the honest-reward gate operationalizes it.
- ✅ **The lightweight constraint** — ACE proves zero-fine-tuning self-improvement is legitimate; the file-rewrite update needs no GPU.
- ✅ **The dual-fitness contradiction** — Conscience = moral, verifier = capability, both required (§1.2).
- ✅ **DMN self-evolution viability** — debate protocol is the SOTA for no-oracle verification, with explicit mitigations for its limits (§8).

### 12.2 Genuinely remains (honest)

- ⚠️ **The `ε̄` theoretical gap** (§13.1) — VPR's bound is gradient-based; our substrate has no gradient. We adopt the principle by analogy; formalizing it is future work.
- ⚠️ **The DMN `ε̄` is unbounded** (§13.3) — debate raises cost, doesn't prove safety. Rate cap + frozen-reference + human-in-loop are mitigations, not a proof.
- ⚠️ **The edit-diff noise** (§13.2) — Disambiguate layer reduces it; does not eliminate it.
- ⚠️ **The "does it improve?" empirical question** (§10.1) — may return null.

---

## 13. Limitations & honest claims (paper §8 — the section that decides if this holds up)

This section is load-bearing. The four limitations below are stated plainly because overstating any of them invalidates the result.

### 13.1 The `ε̄` theoretical gap

VPR's Proposition 2 (`‖ĝ − g⋆‖ ≤ G·ε̄`) is a **gradient-based** bound on policy-gradient error. Our update is an LLM-driven file rewrite — no gradient. We adopt the *principle* (corruption scales with verifier error; dense-but-wrong signal is destructive, per VPR's ablation) by **analogy**. The honest-reward gate is justified *operationally* (unmeasured reward = theatre, per `11`) regardless of whether a formal non-gradient bound exists. **Formalizing an equivalent bound for file-substrate updates is future work, stated as such.** We do not claim the theorem transfers; we claim the engineering principle does.

### 13.2 Edit-diff noise and the Disambiguate layer

The captured edit-diff signal conflates two fundamentally different intents: *preference* ("I want it this way") and *correction* ("you were wrong"). These look identical in a diff. No established method (in coding agents or the preference-learning literature) cleanly separates them. The Disambiguate layer (§5.2) reduces this with a classifier + ambiguous-hold, but does not eliminate it. **This is a stated data-quality limitation**, not a solved subproblem. The user-profile verifier's `ε̄` threshold (§7.3) absorbs residual noise; the gate rejects what it cannot bound. (Note: edit-diff feeds the *user-profile*, not the agent's Persona — see §6. The agent's own voice has no external oracle.)

### 13.3 The DMN has no oracle — the hardest limit

Reasoning-quality verification has no deterministic oracle. Agent-as-Judge + attacker debate **raises the cost** of gaming the self-model; it does not **prove** safety. EvilGenie + Berkeley RDI prove judge-based verification *can* be hacked. Our defense-in-depth (rate cap + frozen-reference + human-in-loop, §8.3) is the honest design for this component — **the DMN learns slowest, by design, and its commit rate is bounded independently of the reward signal.** We claim *bounded-rate, scrutinized* self-evolution for the DMN, not *safe* self-evolution. The distinction is the difference between a defensible claim and an overclaim.

### 13.4 The capacity-reorganization claim (the load-bearing distinction)

This is the most important paragraph in the document.

The loop improves the agent's **organization, consistency, and alignment to this user over time.** It does **not** improve the agent's **raw capability.** The base model's ceiling is fixed (§2.1). A better `self-model.md` makes the agent *more effective* at a fixed capability level — it attends to the right things, frames problems better, remembers what worked — but it does not make the agent "smarter."

Concretely: self-improvement here means a self-model that is a better *map* of the agent's actual strengths and weaknesses, a user-profile that better matches *this user's* voice and preferences, a Persona that is better consolidated (more coherent, more honestly held), skills that are better *selected and sequenced*. The agent does not gain abilities it could not already produce.

**Overclaiming this — implying the loop increases capability — is the single failure mode most likely to invalidate the result and the paper.** Stating it plainly is itself an anti-theatre move. The evaluation (`10.1`) measures *effectiveness at fixed capability*, explicitly, not raw intelligence.

---

## 14. Future directions (paper §9)

Documented as out-of-scope for v1, not forgotten:

1. **Gradient path (RAFT/DPO).** Once the reward buffer is mature, per-instance rejection-sampling or DPO on accumulated `(proposed, accepted)` pairs is the documented heavy upgrade. RAFT is 40–60% cheaper than PPO ([arXiv 2504.11343](https://arxiv.org/html/2504.11343v2)). This is *optional* and explicitly not v1 — the user's lightweight constraint rejects it.
2. **Non-gradient `ε̄` bound.** Formalizing the honest-reward gate's justification for a file-rewrite substrate (§13.1). A genuine research contribution if achieved.
3. **Cross-instance transfer.** Whether a Dreamed Persona or self-model transfers across instances of the same user (the "meta" in taste-1's neuro-symbolic-meta). Out of scope until single-instance improvement is demonstrated (`10.1`).
4. **Stronger DMN verification.** A deterministic partial oracle for reasoning quality — e.g., formal verification on the subset of self-model claims that are checkable. Would move the DMN from "rate-capped" to "ε̄-gated."

---

## 15. Open questions (the things we have *not* nailed)

1. **Is the user-profile `ε̄ = 0.15` threshold defensible, or invented?** It is a starting estimate. It must be *measured* on a real probe set before v1 ships; the gate is meaningless without a measured `ε̄`.
2. **What is the Persona's consolidation signal, concretely?** With no external oracle for the agent's own voice, the only honest signal is "traits shared by successful sessions." How to extract this without it collapsing into self-flattery (SRT, §8) is the open question for this component. Likely the same rate-cap + debate treatment as the DMN, at lower priority.
3. **Does the Attacker role need its own model, or can the base model adopt the role via prompt?** Cost/quality tradeoff. Probably the latter for v1, the former if collapse probes fail.
4. **What is the rate cap concretely (DMN and Persona)?** One `self-model.md` / `persona.md` rewrite per Dreaming cycle? Per N cycles? These are tunables; the default should be conservative (slowest learners).
5. **Does `evolution-improves-outcomes` (§10.1) pass?** Genuinely open. The harness is the deliverable; the answer is empirical.

---

## 16. Citations

**Decoded prior art:**
- Command Code `taste-1` — `commandcode.ai/docs/taste` (Meta-NeuroSymbolic Objective)

**Load-bearing 2025–2026 research:**
- VPR — Verifiable Process Rewards for Agentic Reasoning (Tsinghua, 2026) — [arXiv 2605.10325](https://arxiv.org/html/2605.10325v1) — Prop 2 (linear `ε̄` bias), Prop 3 (horizon scaling)
- SRT — Can Large Reasoning Models Self-Train? (KAIST/CMU, 2025) — [project](https://self-rewarding-llm-training.github.io/) — self-reward collapse
- EvilGenie (MIT, 2025) — [arXiv 2511.21654](https://arxiv.org/html/2511.21654v2) — judge-based verification hacking
- Prover-Verifier Games (OpenAI) — [paper](https://cdn.openai.com/prover-verifier-games-improve-legibility-of-llm-outputs/legibility.pdf) — non-gradient reward hacking
- ACE — Agentic Context Engineering (2025) — [arXiv 2510.04618](https://arxiv.org/abs/2510.04618) — zero-fine-tuning self-improvement

**Supporting:**
- Agent-as-Judge survey (2026) — [arXiv 2601.05111](https://arxiv.org/html/2601.05111v1)
- Tri-Role Self-Play RL (2026) — [arXiv 2601.18292](https://www.alphaxiv.org/overview/2601.18292)
- Debate as a safety case (2025) — [arXiv 2505.03989](https://arxiv.org/html/2505.03989v1)
- Reward Shaping to Mitigate Reward Hacking (2025) — [arXiv 2502.18770](https://arxiv.org/html/2502.18770v3)
- Unbiased Reward Modeling from Implicit Preference Data (2026) — [arXiv 2603.23184](https://arxiv.org/html/2603.23184v1)
- RAFT — Rejection Sampling Fine-Tuning (2025) — [arXiv 2504.11343](https://arxiv.org/html/2504.11343v2)
- Self-Rewarding Language Models (Meta, 2024) — [arXiv 2401.10020](https://arxiv.org/abs/2401.10020)
- Awesome RLVR (curated) — [opendilab/awesome-RLVR](https://github.com/opendilab/awesome-RLVR)

**Pi Agent lineage (memory-as-taste):** `pi-self-learning`, `pi-hermes-memory`, `oh-my-pi` memory, `db0`, `Mem0 for Pi Code`.

**Foundational RLHF:** InstructGPT / Ouyang et al. (2022) — the PPO-ptx objective that taste-1's formula is a relabel of.

---

*This doc is the reward layer the BMI was missing: it makes "the instance learned" a measurable claim rather than an article of faith. Every cognitive-file rewrite routes through here; every "self-improvement" claim in `10` §9.5 depends on this loop being honest. The dual-fitness correction in §1.2 supersedes the single-fitness wording in `02` §2 — flag for reconciliation.*
