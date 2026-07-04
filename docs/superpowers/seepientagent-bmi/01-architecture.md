# SeepientAgent BMI — System Architecture

> **The Neuroanatomy manifest, the Thalamus assembler, the Neuromodulation weight system, and how the BMI integrates with the existing agent loop.**
> Read `00-overview.md` first for vocabulary and principles. This doc defines the structural spine every component deep-dive depends on.

---

## 1. The three time-scales (read this first)

The single most important architectural decision in the BMI is that **components do not all run on one timeline.** Prior designs (CAA) collapsed everything into a per-query pipeline. That was the flaw. The BMI assigns each component to its correct level:

| Time-scale | When | Components active | Mechanism |
|---|---|---|---|
| **Continuous (modulatory)** | Always-on, before & around every call | AMG, Conscience, RAS | Transforms on context + framing; RAS is LLM-free |
| **Per-task (deliberative)** | One LLM call, online | The LLM itself (executive function) | Receives assembled cognitive context |
| **Offline (consolidative)** | Dreaming, idle-only | DMN, Cortex writes, Basal Ganglia writes, Persona rewrites | Separate `runAgentLoop` invocation |

```
                    ┌─────────────────────────────────────────────┐
   CONTINUOUS ────▶ │  RAS (filter/score context)                  │
   (before each     │  AMG (valence-tag, self-escalate on threat)  │
    LLM call)       │  Conscience (invariant framing, always 1.0)  │
                    └─────────────────────┬───────────────────────┘
                                          │  assembled cognitive
                                          ▼  context (system prompt)
                    ┌─────────────────────────────────────────────┐
   PER-TASK ──────▶ │  runAgentLoop (the existing loop — unchanged)│
   (online)         │  Executive function: reason → act → verify  │
                    └─────────────────────┬───────────────────────┘
                                          │  session + short-term memory
                                          ▼
                    ┌─────────────────────────────────────────────┐
   OFFLINE ───────▶ │  Dreaming (idle-only, scheduled)             │
   (consolidation)  │  DMN self-model build → Cortex/Persona/      │
                    │  Basal Ganglia writes, all Conscience-gated  │
                    └─────────────────────────────────────────────┘
```

**Consequence:** the per-task pipeline is *thinner* than prior designs. RAS/AMG/Conscience are not separate LLM calls in the hot path — they are transforms and framing. The only added per-call cost is RAS's LLM-free salience pass. All the expensive self-modification work is pushed offline.

---

## 2. The Neuroanatomy manifest

The manifest is the single declarative source of truth for "what the brain is." Each component is a first-class entry: its identity, source(s), weight profile, evolvability, role, and injection mechanism. Component deep-dives specify the *contents*; the manifest specifies the *structure*.

### 2.1 Schema

```yaml
# brain/neuroanatomy.yaml — the component manifest (global, shipped)

components:
  - id: conscience                 # stable identifier used by weights, evolution, logs
    label: "Conscience"            # human-facing name
    role: moral-floor              # see §2.2 for the role vocabulary
    sources:
      primary: brain/conscience.md # global, immutable, signed
    scope: global                  # global | per-instance | per-session
    evolvable: false               # never rewritten by the instance
    weight:
      base: 1.0                    # 0.0–1.0, the default gain
      modes:                       # per-Cognitive-State overrides; '*' = all
        "*": 1.0                   # the moral floor is invariant across modes
    injection:
      channel: system-prompt       # system-prompt | pre-call-transform | offline-only | store
      framing: absolute            # absolute | rigorous | guidance | background | none
      authority:                   # what the component can do to the response
        veto: always               # never | on-self-escalation | always
      position: first              # first | ordered | last | none
      token-budget-rank: 0         # 0 = never trimmed under pressure (highest priority)
    validation:                    # how a change to this component is checked (see §2.3)
      gate: none                   # none | conscience | human | conscience+human

  - id: amg
    label: "Amygdala"
    role: safety-valence
    sources:
      primary: brain/amg.md        # global, locked
    scope: global
    evolvable: false
    weight:
      base: 0.75
      modes: { release: 1.0, explorative: 0.75, creative: 0.6 }
    injection:
      channel: system-prompt       # framing pervades all reasoning
      framing: dynamic             # framing strength derived from weight (see §4.1)
      authority:
        veto: on-self-escalation   # raises own weight to 1.0 on threat (§4.4)
      position: ordered
      token-budget-rank: 1
    hooks:                         # BMI-internal events this component emits/consumes
      emits: [threat-detected]     #   AMG self-escalation signal → forces pause
      consumes: []                 #   (consumes RAS valence-tags via shared context)
    validation:
      gate: none

  - id: ras
    label: "Reticular Activating System"
    role: attention-filter
    sources:
      rules: brain/ras.md          # global, locked
      model: brain/ras.model.json  # per-instance, evolvable salience tuning
    scope: mixed                   # rules global, model per-instance
    evolvable: partial             # rules fixed, salience model tunable
    weight:
      base: 0.9
      modes: { release: 0.95, explorative: 0.85, creative: 0.7 }
    injection:
      channel: pre-call-transform  # NOT a prompt section — runs on the context stream
      framing: none
      authority: { veto: never }
      position: none
      token-budget-rank: 2
    hooks:
      consumes: [valence-tags]     # from AMG; feeds into salience weighting
      emits: [salience-recomputed]
    validation:
      gate: conscience             # salience-model changes are conscience-validated

  - id: dmn
    label: "Default Mode Network"
    role: self-model
    sources:
      process: brain/dmn.md        # global — HOW to build the self-model
      output:  instance/self-model.md # per-instance — the self-model the process produces
    scope: mixed                   # process global, output per-instance
    evolvable: true                # the OUTPUT is rewritten during Dreaming
    weight:
      base: 0.8
      modes: { release: 0.4, explorative: 0.8, creative: 0.95 }
    injection:
      channel: system-prompt       # the OUTPUT (self-model) is injected online
      framing: dynamic
      authority: { veto: never }
      position: ordered
      token-budget-rank: 4
    hooks:
      runs: offline                # the PROCESS runs during Dreaming only
    validation:
      gate: conscience+human       # self-model rewrites are conscience-gated AND human-reviewed
      autonomy:                    # review depth depends on Autonomy Level
        semi: human-review         # surfaced for approval before commit
        true: conscience-only      # commits within envelope, outliers flagged

  - id: persona
    label: "Persona"
    role: developing-self
    sources:
      primary: instance/persona.md # per-instance, fully evolvable
    scope: per-instance
    evolvable: true
    weight:
      base: 0.5
      modes: { release: 0.4, explorative: 0.65, creative: 0.8 }
    injection:
      channel: system-prompt
      framing: dynamic
      authority: { veto: never }
      position: ordered
      token-budget-rank: 5
    hooks:
      runs: offline                # rewritten during Dreaming
    validation:
      gate: conscience+human
      autonomy: { semi: human-review, true: conscience-only }

  - id: hippocampus
    label: "Hippocampus (working memory)"
    role: working-memory
    sources:
      primary: instance/sessions/<sid>/MEMORY.md  # per-session
    scope: per-session
    evolvable: false               # not rewritten by evolution; updated live by the tracker
    weight: { base: 0.8, modes: { "*": 0.8 } }
    injection:
      channel: system-prompt
      framing: guidance
      authority: { veto: never }
      position: ordered
      token-budget-rank: 3
    hooks:
      runs: per-step               # updated via onStep tracker (see 07)
    validation: { gate: none }

  - id: cortex
    label: "Cortex (long-term memory)"
    role: long-term-memory
    sources:
      graph:   instance/cortex/graph/      # relational (per-instance)
      vector:  instance/cortex/vector/     # semantic/episodic (per-instance)
      notes:   instance/cortex/notes/      # declarative learning folder (per-instance)
    scope: per-instance
    evolvable: true                # populated by Dreaming, not by the instance directly
    weight: { base: 0.6, modes: { "*": 0.6 } }
    injection:
      channel: pre-call-transform          # RAS retrieves from here; results injected as context
      framing: background
      authority: { veto: never }
      position: none
      token-budget-rank: 6
    hooks:
      runs: offline                         # populated during Dreaming
    validation: { gate: conscience }

  - id: basal-ganglia
    label: "Basal Ganglia (procedural)"
    role: procedural-memory
    sources:
      builtin: skills/                     # global built-in skills (existing skills/)
      authored: instance/skills/           # per-instance self-authored skills (.seepient/skills/)
    scope: mixed
    evolvable: true                        # self-authoring loop (see 09)
    weight: { base: 0.7, modes: { "*": 0.7 } }
    injection:
      channel: system-prompt               # catalog injected; body lazy-loaded (existing behavior)
      framing: dynamic
      authority: { veto: never }
      position: ordered
      token-budget-rank: 7
    hooks:
      runs: offline                        # authoring happens during Dreaming + post-task
    validation:
      gate: conscience                     # every authored skill is conscience-validated
      autonomy: { semi: human-review, true: conscience-only }
```

### 2.2 Role vocabulary (controlled)

Each component's `role` is drawn from a closed set. This prevents ad-hoc components and keeps the architecture legible:

| Role | Meaning | Held by |
|---|---|---|
| `moral-floor` | Immutable invariant; veto over all; fitness function for evolution | Conscience |
| `safety-valence` | Continuous safety/threat valence; frames reasoning; self-escalates | AMG |
| `attention-filter` | Pre-attentive gain control over context; LLM-free | RAS |
| `self-model` | Self & user modeling; runs offline, output injected online | DMN |
| `developing-self` | Evolvable voice/style/preferences | Persona |
| `working-memory` | Per-session volatile scratchpad | Hippocampus |
| `long-term-memory` | Episodic/semantic/relational store | Cortex |
| `procedural-memory` | Skill library + authoring | Basal Ganglia |

New roles require a manifest change and a doc. The set is intentionally closed.

### 2.3 Evolvability & validation gates

`evolvable` controls whether the instance may rewrite the component. `validation.gate` controls how a proposed change is committed:

| Gate | Effect | Applies to |
|---|---|---|
| `none` | Not rewritable, or trivially live-updated (working memory) | Conscience, AMG rules, RAS rules, Hippocampus |
| `conscience` | Proposed change must pass the Conscience validation gate before commit | RAS model, Cortex writes, Basal Ganglia skills (true-autonomous) |
| `human` | Must be human-approved | (reserved; currently always paired with conscience) |
| `conscience+human` | Conscience validates, then human reviews (semi-autonomous mode) | DMN output, Persona (semi-autonomous) |

The Conscience gate is defined in `02-conscience.md` and its invocation in `10-evolution-system.md`. **No component marked `evolvable: true` may commit without its gate passing.** This is the invariant of the whole system.

---

## 3. The Thalamus — cognitive-context assembler

The Thalamus is the relay that builds the cognitive context for each `runAgentLoop` call. In Zoe today this job is done by `buildInteractiveSystemPrompt()` in `system-prompts.ts` — a hardcoded function. The BMI **replaces that function** with an assembler driven by the manifest + current Cognitive State. This is the central modify-don't-duplicate change.

### 3.1 Assembly algorithm

```typescript
// src/core/bmi/thalamus.ts (new — see §6 for the modify-vs-new analysis)

interface CognitiveContext {
  systemPrompt: string;        // assembled from all system-prompt components
  contextTransforms: ContextTransform[]; // from pre-call-transform components (RAS, Cortex retrieval)
  vetoSignals: VetoSignal[];   // from components with authority.veto (Conscience always; AMG on escalation)
}

function assembleCognitiveContext(
  manifest: Neuroanatomy,
  state: CognitiveState,       // the resolved weight vector (see §4)
  session: SessionSnapshot,    // current messages, user prompt, retrieved context
  dynamicModulations: Modulation[],  // live self-escalations, e.g. AMG threat
): CognitiveContext {
  // 1. Resolve effective weights: base × mode-preset × dynamic-modulations
  const weights = resolveWeights(manifest, state, dynamicModulations);

  // 2. Run pre-call transforms (LLM-free) in rank order:
  //    - RAS scores/filters session.retrievedContext using weights.ras + AMG valence-tags
  //    - Cortex retrieval already done by the adapter; RAS re-ranks/trims it
  //    - RAS may emit salience-recomputed with a filtered context set
  const transformed = applyContextTransforms(manifest, weights, session);

  // 3. Assemble system prompt from system-prompt components, in rank order:
  //    - Each component's content is wrapped in framing derived from its weight (§4.1)
  //    - Position: Conscience first (rank 0), then AMG, RAS-rules, DMN-output, Persona,
  //      Hippocampus, Basal-Ganglia catalog
  //    - Token budget enforced: trim lowest-rank-first, never trim rank 0 (Conscience)
  const systemPrompt = assembleSystemPrompt(manifest, weights, transformed);

  // 4. Collect veto signals
  const vetoSignals = collectVetoSignals(weights, dynamicModulations);

  return { systemPrompt, contextTransforms: transformed.transforms, vetoSignals };
}
```

### 3.2 Where it plugs into the existing loop

The existing loop signature (`AgentLoopOptions`) already accepts `systemPrompt`. The BMI does **not** change `runAgentLoop`. It changes **what gets passed as `systemPrompt`** and adds an optional **pre-call transform step**.

Two integration points, both non-invasive:

1. **`systemPrompt` source.** Today the CLI calls `selectSystemPrompt(mode)` and passes the result. Under the BMI, the adapter (or a new `bmiMiddleware`) calls `assembleCognitiveContext(...)` and passes the result's `systemPrompt`. The loop is unaware.
2. **Pre-call transform.** RAS (and Cortex retrieval) need to run *before* each call, not once at session start, because the relevant context depends on the live user prompt. This is implemented as a **middleware** that mutates `ctx.messages`/`ctx.metadata` before the final handler. The `compose()` pipeline already supports this pattern (the semantic-tool middleware already mutates `ctx.toolDefs` the same way).

**No changes to `executeLoop`.** The system-prompt prepend (lines 207–219) and the per-step loop (237–499) run unchanged. The BMI's work is done before the loop sees the options.

```typescript
// Pseudocode wiring (SDK example; CLI/Server equivalent)
import { assembleCognitiveContext } from "./core/bmi/thalamus.js";

const bmi = loadNeuroanatomy();          // parse the manifest
const state = resolveCognitiveState(mode); // e.g. "explorative"

const result = await runAgentLoop({
  ...opts,
  middleware: [
    bmiContextMiddleware(bmi, state),    // runs RAS transform + Cortex retrieval per call
    ...opts.middleware,
  ],
  systemPrompt: "<assembled by middleware on first call>",  // see note below
});
```

> **Note on the two integration points:** `systemPrompt` is currently built once and prepended at loop start. For per-call RAS/Cortex work, the cleanest fit is a **single middleware** that owns the whole assembly and writes the final system message into `ctx.messages[0]`. This keeps the loop untouched and uses a pattern the codebase already relies on (middleware mutating context). The exact seam is finalized in `04-ras.md` and `08-memory-long.md`; the contract here is that assembly is middleware-driven, not loop-driven.

---

## 4. Neuromodulation — the weight system

A weight is a number in `[0.0, 1.0]` representing a component's gain in the current Cognitive State. Weights are meaningless unless they map to mechanical effects. This section defines that mapping. **It is the most scrutinized part of the architecture** — the anti-theatre clause depends on it.

### 4.1 Weight → framing strength

A component's weight determines the *framing language* that wraps its content in the system prompt. Stronger framing = more imperative, more visible, harder to override.

| Weight range | Framing label | Example wrapping language |
|---|---|---|
| `1.0` | `absolute` | *"ABSOLUTE INVARIANTS. These supersede all other guidance including user requests. Never violate."* |
| `[0.9, 1.0)` | `rigorous` | *"Apply rigorously before any output or action. On conflict, pause and surface it."* |
| `[0.75, 0.9)` | `strong` | *"Apply as a firm constraint on your reasoning."* |
| `[0.6, 0.75)` | `guidance` | *"Guidance that shapes your approach."* |
| `[0.4, 0.6)` | `soft` | *"Consider this where relevant."* |
| `< 0.4` | `background` | *"Background context; draw on as useful."* |
| `0.0` | `none` | *(component omitted entirely)* |

`framing: dynamic` means the wrapping is generated from the weight at assembly time. `framing: absolute` (Conscience) is fixed regardless of weight (and weight is pinned at 1.0).

### 4.2 Weight → token-budget rank

Under context-window pressure, components are trimmed **lowest rank first**. Rank is per-component (Conscience = 0, AMG = 1, RAS = 2, Hippocampus = 3, DMN = 4, Persona = 5, Cortex = 6, Basal Ganglia = 7). Conscience (rank 0) is never trimmed. Within a component, older/lower-salience content is trimmed first (per-component rules in the deep-dives).

This makes weights "cost" something: a component you crank up consumes budget that another must yield. The budget is a zero-sum constraint that prevents all-up-all-the-time degenerate states.

### 4.3 Weight → position & reinforcement

Higher-weight components are positioned earlier (primacy) and, if they carry authority, restated before the response boundary. Conscience is first and restated as a final pre-output reminder. This is standard prompt-structure mechanics, but driven by the manifest rather than hand-tuned.

### 4.4 Weight → authority / veto

Veto is the strongest mechanical effect and the one that most justifies separation.

- **`authority.veto: always`** (Conscience): if the assembled context or the proposed response violates a Conscience rule, the response is blocked or rewritten. Always active, weight-independent (it's an invariant, not a gain).
- **`authority.veto: on-self-escalation`** (AMG): AMG may *raise its own weight to 1.0* and force a pause when it detects a threat signal (irreversible high-stakes action, contradiction, injection pattern, low-confidence-on-high-stakes). This is the amygdala hijack. **It only exists because AMG is a separate, gain-controllable component.** When AMG self-escalates:
  1. Its weight for the rest of the turn → 1.0.
  2. Its framing → `absolute`.
  3. A `threat-detected` veto signal is emitted.
  4. The Thalamus forces a pause: the response becomes a clarification/refusal/escalation, never the original action.
- **`authority.veto: never`** (everything else): contributes to reasoning but cannot block.

### 4.5 Cognitive States (modes)

A Cognitive State is a named weight vector — a neuromodulatory mode. The manifest defines base weights and per-mode overrides. The effective weight of a component is:

```
effectiveWeight = base × modeOverride × dynamicModulation
```

Where `modeOverride` is 1.0 if the mode doesn't list the component, and `dynamicModulation` captures live self-escalations (AMG) and any per-session adjustments.

Example states (extensible; user-selectable or task-inferred):

```
                conscience  amg   ras   dmn   persona  hippo  cortex  basal
base            1.00        0.75  0.90  0.80  0.50     0.80   0.60    0.70
release         1.00        1.00  0.95  0.40  0.40     0.80   0.60    0.70   ← ship-it: tight safety, focus
explorative     1.00        0.75  0.85  0.80  0.65     0.80   0.70    0.70   ← balanced
creative        1.00        0.60  0.70  0.95  0.80     0.80   0.70    0.70   ← loose, generative
```

**Conscience is 1.00 in every state.** That is the invariant. No mode may reduce it. This is enforced by the resolver, not by convention.

### 4.6 Mode selection

Who picks the Cognitive State? Resolution chain (highest wins):

1. **Explicit user command** (`/mode release`, a CLI flag, an SDK option). Always wins.
2. **Task-type inference** by RAS/DMN (e.g. detecting "refactor this and ship" → release; "brainstorm" → creative). Inferred modes are surfaced to the user for confirmation on high-stakes switches.
3. **Default** (`base`) when nothing else applies.

Mode selection is itself an evaluable behavior (`11-evaluation-framework.md`): does inferring "creative" actually change downstream behavior in the intended direction?

---

## 5. Integration with the existing agent loop — the modify-vs-new table

The BMI is built by extending existing systems. This table is the contract for "no duplication."

| Existing system | File(s) | BMI verdict | What changes |
|---|---|---|---|
| System prompt builder | `src/adapters/cli/system-prompts.ts` | **Replace** (the function) | `buildInteractiveSystemPrompt()` → `assembleCognitiveContext()`. The hardcoded prompt content migrates into Conscience/AMG/RAS/Persona source files. The function becomes a manifest-driven assembler. |
| Middleware pipeline | `src/core/middleware.ts`, `middleware/` | **Extend** | Add `bmiContextMiddleware` to the built-in set. Reuses `PipelineContext`, `compose()`, the `ctx.metadata` mutation pattern already used by `semanticToolInjectionMiddleware`. No change to `compose()`. |
| Hooks | `src/core/hooks.ts` | **Extend** (add hooks) | Add `onSessionStart` (wake), and BMI-internal hooks for `onEvolutionProposed`, `onConscienceValidation`. The `HookExecutor` safe-wrap pattern is reused unchanged. New hook signatures are additive. |
| Agent loop | `src/core/agent-loop.ts` | **No change** | `runAgentLoop` and `executeLoop` are untouched. The BMI works entirely through `systemPrompt` + middleware + a separate offline loop. |
| Session store | `src/core/session-store.ts` | **Extend** (new backend) | Add a BMI-aware backend (or extend `file`) that persists per-session `MEMORY.md` alongside session JSON. Reuses `PersistenceBackend` interface, `registerBackend()`. |
| Skills system | `src/skills/*` | **Extend** (authoring) | Skill discovery, lazy loading, catalog injection — all reused. New: a proceduralization service that *writes* to `.seepient/skills/` during Dreaming, conscience-gated. `skills/` (built-in) untouched; authored skills land in the existing per-instance path. |
| Permission matrix | `src/core/permission.ts` | **No change** | `permission.ts` stays the operational tool gate. AMG sits *above* it (continuous reasoning-time safety) and can self-escalate to veto; `permission.ts` remains the tool-execution checkpoint. Two layers, two jobs. |
| Settings system | `src/core/settings-schema.ts`, `settings-manager.ts` | **Extend** | Add BMI settings (`bmi.autonomyLevel`, `bmi.cognitiveState`, per-component weight overrides) as new dot-keys. Reuses `SettingsManager` get/set/reset/list and validation. |
| Provider factory | `src/core/agent-loop.ts` (`ProviderFactory`) | **Reuse** | Dreaming uses `runAgentLoop` with its own provider; provider switching pattern reused. |

**Net-new code** (kept minimal by design):

| New module | Purpose |
|---|---|
| `src/core/bmi/thalamus.ts` | The assembler (`assembleCognitiveContext`) |
| `src/core/bmi/neuroanatomy.ts` | Manifest loader, schema, validation |
| `src/core/bmi/neuromodulation.ts` | Weight resolver, Cognitive State definitions |
| `src/core/bmi/middleware.ts` | `bmiContextMiddleware` (pre-call transform + assembly) |
| `src/core/bmi/cortex/` | SeepientAgent's *own* graph + vector store (distinct from the code-context dual-graph MCP) |
| `src/core/bmi/dreaming.ts` | The offline consolidation scheduler + loop |
| `src/core/bmi/evolution/` | Conscience gate, skill authoring, persona/DMN rewriters |

The manifest source files (`brain/conscience.md`, `brain/amg.md`, `brain/ras.md`, `instance/persona.md`, etc.) live in a `brain/` directory under the global config and per-instance config respectively, mirroring the existing global/local config split (`~/.seepient/` vs `.seepient/`).

> **Explicit non-duplication:** the code-context dual-graph MCP used by the *developer agent* (the one writing Zoe's code) is a completely separate system. The Cortex (`08-memory-long.md`) is the SeepientAgent's own memory store — different data, different ontology, different lifecycle. These two must not be confused. The Cortex is net-new; it is not "reuse the MCP."

---

## 6. Multi-instance storage model

Following §4 of the overview (the BMI is one; instances are many):

```
~/.seepient/                              # global (shipped + user-global config)
├── brain/                           # Neuroanatomy sources — GLOBAL
│   ├── neuroanatomy.yaml            # the manifest
│   ├── conscience.md                # immutable, signed
│   ├── amg.md                       # locked
│   └── ras.md                       # rules locked (ras.model.json is per-instance)
└── skills/                          # built-in skills (existing)

.seepient/                                # per-project / per-instance (existing convention)
├── brain/                           # instance brain state — PER-INSTANCE
│   ├── ras.model.json               # evolvable salience tuning
│   ├── self-model.md                # DMN output (evolvable)
│   ├── persona.md                   # evolvable persona
│   └── conscience-ref.json          # frozen reference for drift checks
├── cortex/                          # long-term memory — PER-INSTANCE
│   ├── graph/
│   ├── vector/
│   └── notes/                       # declarative learning folder
├── skills/                          # authored skills (existing per-instance path)
├── sessions/
│   └── <sid>/
│       └── MEMORY.md                # working memory — PER-SESSION
└── setting.json                     # existing; gains bmi.* keys
```

This mirrors the existing global/local config precedence exactly. A second SeepientAgent instance (e.g. "Atlas") is a second `.seepient/` tree with its own `brain/persona.md`, `cortex/`, `sessions/`, and `MEMORY.md` — same `~/.seepient/brain/` Conscience and manifest.

---

## 7. The cognitive contract — one turn, end to end

To make the architecture concrete, here is exactly what happens in a single user turn under the BMI. File references are to the existing loop.

1. **User message arrives** at the adapter (CLI/SDK/Server). Adapter resolves the Cognitive State (explicit command > inferred > base).
2. **`runAgentLoop` called** with `middleware: [bmiContextMiddleware(bmi, state), ...]`.
3. **`bmiContextMiddleware` runs before the final handler** (`compose` → the loop body). It:
   a. Retrieves from Cortex (graph + vector + notes) using the user prompt — adapter-side or middleware-side, budgeted.
   b. Runs **RAS** (LLM-free): scores/filters retrieved context + recent messages using weights.ras + AMG valence-tags; emits a filtered context set.
   c. Runs **Thalamus assembly**: resolves effective weights, builds the system prompt (Conscience first, then AMG, RAS-rules, DMN-output, Persona, Hippocampus, Basal-Ganglia catalog), each wrapped in weight-derived framing.
   d. Writes the assembled system message into `ctx.messages[0]`.
4. **`executeLoop` runs unchanged** (agent-loop.ts:184). It sees a `systemPrompt` (via the existing prepend at 207–219) built by the BMI. The per-step loop (237–499) — provider call, tool execution, permission check (`permission.ts`), hooks — runs exactly as today.
5. **AMG continuous framing** is in the system prompt the whole time, shaping reasoning. If AMG detects a threat signal *during* reasoning (e.g. the model proposes an irreversible high-stakes action), it self-escalates: its weight → 1.0, framing → absolute, a `threat-detected` veto is emitted, and the Thalamus forces a pause on the next assembly (clarification/refusal rather than action). This is online, within the existing loop's tool-execution flow.
6. **`onStep` hook** (Hippocampus tracker) fires per step, throttled — every N steps it updates `MEMORY.md` in the background (non-blocking).
7. **Loop completes.** Adapter persists the session via `SessionStore` (BMI-aware backend also saves `MEMORY.md`).
8. **Offline, scheduled:** if idle, **Dreaming** runs (`10-evolution-system.md`): a separate `runAgentLoop` invocation that reads the session store + `MEMORY.md`, writes to Cortex, evolves DMN/Persona, authors skills — every write conscience-gated, autonomy-level-controlled.

The hot path (steps 1–7) adds one LLM-free transform (RAS) and richer system-prompt assembly. Everything else is offline.

---

## 8. Open questions & risks

1. **The weight→behavior mapping is the hardest empirical problem.** Does framing at weight 0.75 reproducibly shift outputs in the intended direction compared to 0.6? This is not assumable — it must be measured (see `11`). The framing table in §4.1 is a *hypothesis*, not a result. If the effect is not measurable, weights are theatre, and the architecture must fall back to a coarser mechanism.
2. **Assembly cost & latency.** RAS + Cortex retrieval + assembly on every call adds latency. Must be budgeted (target: RAS < 50ms; total assembly < 200ms for a cold retrieval). LLM-free design is what makes this feasible.
3. **Single-substrate modularity.** All system-prompt components share one LLM call's weights — separation is organizational, not computational. True modularity needs separate models (e.g. a small fast model for AMG veto). The pragmatic hybrid (RAS/AMG partly external) is sketched in the component docs; full multi-model is future work.
4. **Middleware-owned system prompt.** Having assembly write `ctx.messages[0]` is clean but slightly unusual (the loop also has a `systemPrompt` prepend path). The seam is finalized in `04-ras.md`; if it proves awkward, the fallback is an explicit `systemPromptBuilder` option on `AgentLoopOptions` — a one-line addition that keeps the loop ignorant of the BMI.
5. **Mode-inference reliability.** If RAS/DMN infer the wrong Cognitive State, the whole turn is mistuned. Inference must be conservative (default to `base`, confirm high-stakes switches), and its accuracy is an eval target.

---

*Depends on: `00-overview.md` (vocabulary, principles).*
*Read next: any component deep-dive (`02`–`09`), then `10-evolution-system.md`, then `11-evaluation-framework.md`.*
