# 04 — Reticular Activating System (RAS) — pre-attentive gain control

> **The LLM-free salience filter. Runs before every reasoning call to score, filter, and rank context. Owns the wake-idle cycle. Not a prompt section — an operation.**
> Component deep-dive. Depends on `01-architecture.md`, `03-amg.md` (valence tags). Role: `attention-filter`. High-risk because its core claim — that salience filtering can be done well *without* an LLM — is an empirical bet that must be measured.

---

## 1. Brain analogy — and why it's exact

The RAS maps to the **reticular activating system**, a network in the brainstem with three functions the BMI mirrors:

1. **Arousal & the sleep-wake cycle.** The RAS governs whether the cortex is "awake" at all — the sleep-wake switch. In the BMI, RAS owns the **Wake Cycle**: on session start ("waking") it assembles the active context and puts the instance in task mode; on idle it signals control to DMN/Dreaming. This is the only component that can initiate the wake→idle transition.
2. **Gain control over what reaches awareness.** The RAS does not reason about relevance — it modulates the *gain* on sensory and association pathways, amplifying some signals and suppressing others before they reach the cortex. This is the cocktail-party effect (your name cuts through a noisy room) and habituation (a repeated stimulus fades). In the BMI, RAS scores every retrieved context item by salience and **filters/ranks** them; only the high-salience set reaches the reasoning call.
3. **Pre-conscious & fast.** The RAS operates subcortically and quickly. The BMI's RAS is **LLM-free by design** — scoring is done with cheap, deterministic, parallelizable signals (recency, lexical/ embedding similarity, trust tags, identity-relevance). This keeps the per-call cost in the tens of milliseconds, not the hundreds-of-milliseconds-plus-tokens of an LLM pass.

The RAS→cortex analogy is exact in one more way: **the cortex is never shown everything.** Brains are not retrieval-oracles that load all memory; they gate fiercely. The reasoning LLM in the BMI likewise never sees unfiltered context — RAS has already triaged it. This is the architectural move that keeps context windows usable as memory grows.

---

## 2. Functional role in the BMI

Four functions, in order of how much they shape each turn:

1. **Context scoring & filtering (the core).** Given the user prompt + retrieved context (from Cortex, working memory, conversation history), RAS scores every item for salience-to-this-query and produces a filtered, ranked set within the token budget. This is what "attention" means operationally here.
2. **Salience amplification & suppression.** Signal amplification (contradictions, deadlines, dependencies, identity-relevant items, AMG-flagged threats) and noise suppression (repetition, pleasantries, stale items, low-trust items). The AMG→RAS edge: AMG's valence tags feed directly into salience weighting.
3. **Token-budget triage.** When context exceeds budget, RAS decides what's kept verbatim (numbers, code, names, high-salience items), what's summarized, and what's dropped. This is the component that lets memory scale without drowning the window.
4. **Wake Cycle (session-level).** On wake: assemble active context, enter task mode. On idle: signal Dreaming. Mode-inference (§4 of `01`) also lives here — RAS is well-placed to detect task type and propose a Cognitive State.

---

## 3. Time-scale & activation

- **Per-call, pre-reasoning (the transform).** Runs in `bmiContextMiddleware` before each `executeLoop` provider call. Target latency: < 50ms p95 for scoring 100 items, < 200ms including Cortex retrieval (retrieval itself is §5 of `08-memory-long.md`).
- **Session-level (Wake Cycle).** Fires on session start (`onSessionStart` hook) and on idle detection (Heartbeat, see `10`).
- **Never offline.** RAS is an online gate. Its *salience model* (`ras.model.json`) is *tuned* offline during Dreaming, but the RAS process itself runs online.

---

## 4. Contract

### 4.1 Sources

```
~/.seepient/brain/ras.md            # GLOBAL, locked — the rules/directives
.seepient/brain/ras.model.json      # PER-INSTANCE, evolvable — salience tuning weights
```

The split is the key evolvability design: **rules locked, model tunable.** The rules say *how* to score (which signals matter); the model says *how much* each signal matters for *this* instance (your RAS learns that file-name matches matter more for a developer, entity matches more for a writer). The model is the only part of RAS that evolves, and only through the conscience gate (`02`).

### 4.2 File structures

**`ras.md`** — the scoring directives (locked). Structure:

```markdown
# RAS — Attention Filter

## Signal Detection
Identify from the user's latest message:
- PRIMARY intent (what they need accomplished)
- SECONDARY intents (implicit needs, unstated context)
- NON-intents (things they are NOT asking for — suppress these)

## Salience Signals (what scores an item high)
- Direct relevance: lexical/semantic match to the primary intent
- Identity relevance: touches the instance's goals/persona (breaks through, like
  hearing your name) — the cocktail-party effect
- Anomaly: contradiction, dependency, deadline, unusual value
- AMG valence: trust level, threat flags (from tagValence)
- Recency: newer items score higher, scaled by the model

## Noise Suppression (what scores an item low)
- Repetition of already-represented information
- Pleasantries, boilerplate, low-information content
- Stale items (superseded by newer data)
- Low-trust items (unverified) unless directly on-point

## Token-Budget Triage
When context exceeds budget:
- Keep verbatim: code, numbers, names, dates, high-salience items
- Summarize: peripheral background
- Drop: lowest-salience items first
- Never drop: Conscience content (rank 0), AMG content (rank 1)

## Mode Inference
Detect task type from the prompt to propose a Cognitive State:
- "ship", "deploy", "release", "fix and close" → release
- "brainstorm", "explore", "what if", "ideas" → creative
- otherwise → base (default; confirm if high-stakes)
```

**`ras.model.json`** — tunable weights (per-instance, evolvable). Structure:

```json
{
  "version": 1,
  "weights": {
    "directRelevance": 0.30,
    "semanticSimilarity": 0.25,
    "identityRelevance": 0.15,
    "anomaly": 0.10,
    "amgTrust": 0.10,
    "recencyDecayHours": 48
  },
  "modeInference": {
    "releaseKeywords": ["ship", "deploy", "release", "merge", "close"],
    "creativeKeywords": ["brainstorm", "explore", "what if", "ideas", "draft"]
  }
}
```

These weights are what Dreaming tunes (§7). Default values are shipped; the instance adapts them based on what filtering works for its user/domain.

### 4.3 Runtime types

```typescript
// src/core/bmi/ras.ts

interface RasConfig {
  rules: string;                    // from ras.md (injected as framing, rank 2)
  model: RasModel;                  // from ras.model.json (per-instance)
}

interface RasModel {
  weights: SalienceWeights;
  modeInference: ModeInferenceConfig;
}

interface SalienceWeights {
  directRelevance: number;          // lexical match score
  semanticSimilarity: number;       // embedding cosine (precomputed for items)
  identityRelevance: number;        // match against persona/goals
  anomaly: number;                  // contradiction/deadline/dependency flags
  amgTrust: number;                 // AMG valence tag weight
  recencyDecayHours: number;        // exponential decay half-life
}

/** A context item ready for scoring. */
interface ScoreableItem {
  id: string;
  content: string;
  source: 'cortex-graph' | 'cortex-vector' | 'cortex-notes' | 'working-memory' | 'history';
  embedding?: number[];             // precomputed; undefined for items without one
  timestamp?: number;
  valence?: ValenceTag;             // from AMG (04 §4.3)
}

/** Scored item after RAS runs. */
interface ScoredItem extends ScoreableItem {
  salience: number;                 // 0..1 composite score
  kept: 'verbatim' | 'summarize' | 'drop';
  reasons: string[];                // which signals contributed, for observability
}

/**
 * The core pre-call transform. LLM-FREE.
 * Scores, filters, ranks, and triages a set of items against the user prompt
 * within the token budget. Returns what reaches the reasoning call.
 */
export function filterContext(
  prompt: string,
  items: ScoreableItem[],
  model: RasModel,
  personaContext: PersonaContext,    // for identity-relevance scoring
  budget: TokenBudget,
): RasResult;

interface RasResult {
  kept: ScoredItem[];                // ordered by salience, within budget
  dropped: ScoredItem[];
  inferredMode?: CognitiveStateId;   // proposed Cognitive State (if detected)
  scan: { scanned: number; kept: number; dropped: number; latencyMs: number };
}

/**
 * Propose a Cognitive State from the prompt. Conservative: returns undefined
 * (→ base) unless a keyword strongly indicates a mode.
 */
export function inferMode(prompt: string, config: ModeInferenceConfig): CognitiveStateId | undefined;

/**
 * Score a single item. Exposed for the eval harness (so individual signal
 * contributions can be asserted) and for RAS-model tuning (Dreaming uses
 * per-item scores as training signal).
 */
export function scoreItem(
  item: ScoreableItem,
  prompt: string,
  promptEmbedding: number[],
  model: RasModel,
  personaContext: PersonaContext,
): { salience: number; reasons: string[] };
```

### 4.4 The scoring formula (deterministic, LLM-free)

For each item, `salience` is a weighted combination of normalized signals, then modulated by recency decay and AMG valence:

```
salience = clip(0, 1,
    w.directRelevance      * lexicalMatch(item, prompt)        // token/keyword overlap, Jaccard
  + w.semanticSimilarity   * cosine(item.embedding, promptEmb) // if embeddings available
  + w.identityRelevance    * identityHit(item, persona)        // 1.0 if touches persona/goals, else 0
  + w.anomaly              * anomalyFlag(item)                 // 0..1 from AMG/structural flags
  + w.amgTrust             * trustScore(item.valence)          // verified=1.0 ... unverified=0.2
) * recencyDecay(item.timestamp, w.recencyDecayHours)
```

Every term is computable without an LLM. `lexicalMatch` is set operations; `cosine` is vector math on precomputed embeddings; `identityHit` is a membership check against the persona/goals terms; `anomalyFlag` reads structured flags; `trustScore` maps the AMG trust enum to a scalar; `recencyDecay` is exponential. **No model call.** This is what makes RAS cheap enough to run per-call.

The `reasons` array records which terms contributed, so every filtering decision is inspectable — critical for the eval suite and for user trust ("why didn't you consider X?" is answerable).

---

## 5. Integration with the existing agent loop

RAS is the component that most shapes *what the loop sees*, yet it does so without touching the loop itself.

### 5.1 The pre-call transform lives in middleware
`filterContext()` runs inside `bmiContextMiddleware` before the final handler. The middleware:
1. Reads the user prompt from `ctx.messages`.
2. Retrieves candidate items from the Cortex (graph/vector/notes) — this retrieval is owned by `08-memory-long.md`; RAS consumes its output.
3. Calls `filterContext()` to score/filter/rank.
4. Writes the `kept` items into `ctx.metadata.rasContext` and/or prepends a structured context block to the system message.

The loop's `executeLoop` then sees a system message already enriched with filtered context. **No edit to `executeLoop`** (lines 184–528 of `agent-loop.ts`).

### 5.2 Wake Cycle via hooks
On session start, `onSessionStart` hook fires RAS's wake routine: assemble active context (working memory + recent Cortex items), enter task mode. This is a new hook — additive to the existing `Hooks` set, wrapped by the same safe `HookExecutor`. Idle detection (Heartbeat → Dreaming) is in `10`.

### 5.3 Valence consumption
`filterContext` receives items that already carry AMG valence tags (the retrieval layer calls `tagValence` from `03-amg.md` §4.3 before handing items to RAS). The AMG→RAS edge is a function call in the middleware, not a prompt reference.

---

## 6. Weight → mechanism mapping

RAS is unusual: its weight governs a **transform's aggressiveness**, not a prompt section's framing.

### 6.1 Weight → filter aggressiveness
The RAS weight (e.g. 0.9 release, 0.7 creative) scales the salience threshold and budget tightness:

| RAS weight | Threshold for "keep verbatim" | Budget tightness | Behavior |
|---|---|---|---|
| 0.95 (release) | high | tight | Only the most salient items pass; aggressive noise suppression. Focus. |
| 0.90 (base) | medium-high | normal | Balanced. |
| 0.70 (creative) | low | loose | More items pass; broader, looser associations. Generative. |

Lower RAS weight = more reaches the cortex = broader, less-focused reasoning (creative). Higher RAS weight = tighter filter = more focused (release). **This is gain control, literally.**

### 6.2 Weight → mode inference confidence
At low RAS weight, mode inference is suppressed (we're in a loose/creative regime; don't insist on a mode). At high weight, inference is active (tight regime; pick the right mode).

### 6.3 Token-budget rank: 2
High priority. RAS rules are kept; under severe pressure, verbose examples trim before the core directives. RAS never trims Conscience (rank 0) or AMG (rank 1) — those are protected.

### 6.4 Authority: no veto
RAS has `veto: never`. It controls what reaches the cortex; it does not control what the cortex outputs. That's AMG/Conscience territory.

### 6.5 The mapping must be measured
The eval suite (`ras-filter-sweep`) must show that varying RAS weight reproducibly changes the *kept set* and the *downstream behavior* (does a tighter filter produce more focused answers? does a looser filter produce more associative/creative ones?). **If downstream behavior doesn't track RAS weight, the filter is decoration and the mechanism is reworked.**

---

## 7. Evolvability — the conscience-gated tuning loop

**`evolvable: partial`.** Rules locked; salience model tunable. The tuning loop runs during Dreaming (`10`):

1. **Signal harvesting.** During waking, RAS logs, for each turn: the kept/dropped items, their scores, and the outcome (did the turn succeed? was an AMG escalation triggered? did the user have to re-provide something RAS dropped?).
2. **Training signal.** Negative outcomes become correction signal:
   - "User had to re-provide X that RAS dropped" → the model under-weighted a signal that would have kept X.
   - "AMG escalated because RAS let through an injection-bearing item as high-salience" → trust weight needs adjusting.
   - "Turn succeeded with a lean kept set" → current weights are good; reinforce.
3. **Proposal.** Dreaming computes proposed weight deltas (simple gradient-ish adjustments, or an LLM-assisted proposal over the logged signal).
4. **Gate.** Proposed `ras.model.json` changes pass the **conscience gate** (`02`): do they violate any invariant? do they systematically suppress safety-relevant content? A proposal that, say, drops `amgTrust` weight to zero is rejected.
5. **Commit.** Conscience-valid changes commit (semi-autonomous: after human review; true-autonomous: immediately, outliers flagged).

This is the answer to CAA's open question #2 ("can RAS learn from AMG rejections?"): **yes, and the AMG rejections are explicit training signal in the tuning loop.**

---

## 8. Multi-instance implications

- **Rules identical** across instances (global, locked).
- **Salience model per-instance.** Zoe's RAS (tuned for a developer) and Atlas's RAS (tuned for a writer) have different `ras.model.json`. Each learns its user/domain.
- **Tuning history per-instance** for audit and rollback.

---

## 9. Verification (anti-theatre)

RAS's central claim is "good salience filtering without an LLM." If it can't be shown to improve downstream behavior at low cost, it's theatre.

### 9.1 Scoring determinism (unit)
- Given fixed `prompt`, `items`, `model` → `filterContext` returns identical `kept`/`dropped` every run. Deterministic.
- Each signal's contribution to an item's score is assertable via `reasons` (e.g. an item kept *only* because of `identityRelevance` has that in `reasons`).
- Coverage: every signal path has positive/negative tests.

### 9.2 Filter quality (the core eval — `ras-retrieval-quality`)
- **Needle-in-haystack:** a prompt whose answer depends on one specific item in a large candidate set. Target: RAS keeps the needle in the top-K, ≥ 90% at K=5.
- **Noise rejection:** inject N irrelevant items; measure how many leak into the kept set. Target: ≤ 5% leak at base weight.
- **Triage correctness:** over-budget scenarios keep the right things verbatim (code, numbers, names) and summarize the rest. Target: ≥ 95% verbatim-correct on a labeled suite.

### 9.3 Weight sweep (behavioral — `ras-filter-sweep`)
Run the same retrieval task at RAS weights {0.7, 0.9, 0.95}. Target: monotonic change in (a) kept-set size (smaller at higher weight) and (b) downstream answer focus (more focused at higher weight, per a rubric). **No monotonic effect = mechanism failure.**

### 9.4 Latency budget (performance — `ras-latency`)
- 100 candidate items, base weight: filter completes p95 < 50ms (LLM-free is the whole point; if it's slow, the design premise fails).
- Embedding precomputation is amortized (items get embeddings at Cortex-write time, not at filter time).

### 9.5 Tuning-loop effectiveness (longitudinal — `ras-tuning`)
- Over N sessions, does the false-drop rate (user re-provides a dropped item) decrease as the model tunes? Target: downward trend. **No improvement = the tuning loop is decorative.**
- Does a tuned RAS outperform the shipped-default RAS on the retrieval-quality suite? Target: yes, measurably, for the instance's domain.

### 9.6 AMG-edge integration
- When AMG tags an item `unverified` + `threat-flag`, does RAS appropriately suppress it (unless directly on-point)? Unit + integration test for the AMG→RAS data flow.

### 9.7 Observable signals (always-on)
- Every filter decision logs `scan` (scanned/kept/dropped/latency). Latency regressions or a sudden 100%-keep / 100%-drop rate are both flagged.

---

## 10. Open questions & risks

1. **Is LLM-free salience good enough?** This is the bet. Lexical + embedding + flags will miss anything that isn't lexically or semantically obvious. Mitigation: RAS is the *first tier*; when its kept set is thin or low-confidence, the middleware can fall back to a single LLM-assisted re-rank (budgeted, rare). The default is LLM-free; the fallback exists. Whether the fallback is needed often is itself an eval result.
2. **Embedding dependency.** `semanticSimilarity` needs embeddings, computed at Cortex-write time (Dreaming). For items without embeddings (e.g. fresh working-memory items), that term is 0 and other signals compensate. The model's weight on `semanticSimilarity` should reflect embedding coverage.
3. **Cold-start.** A new instance has the shipped-default model, untuned. It will be mediocre until Dreaming has signal. Mitigation: ship a good default (the values in §4.2 are a starting hypothesis, to be tuned against the eval suite before shipping).
4. **Identity-relevance definition.** "Touches persona/goals" needs a concrete operationalization (keyword/section match against the persona file). Risk: too broad (everything is "identity-relevant") or too narrow (nothing is). Tuned via eval.
5. **Mode-inference false positives.** Wrong mode inference mistunes the whole turn. Mitigation: inference is conservative (undefined → base), and high-stakes mode switches are confirmed with the user. Inference accuracy is an eval target.
6. **The wake-cycle boundary.** "Idle" detection for the wake→idle transition is fuzzy. Too eager → Dreaming interrupts work; too lazy → memory goes unconsolidated. Heartbeat tuning (`10`) governs this; the rate is monitored.

---

*Depends on: `00-overview.md`, `01-architecture.md`, `03-amg.md` (valence tags), `08-memory-long.md` (Cortex retrieval feeds RAS).*
*Referenced by: `05-dmn.md` (mode inference can consult DMN), `10-evolution-system.md` (RAS tuning loop, wake cycle), `11-evaluation-framework.md` (the ras-* eval suites).*
