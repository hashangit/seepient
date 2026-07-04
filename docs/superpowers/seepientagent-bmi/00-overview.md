# SeepientAgent BMI — Overview

> **The Brain-Mind-Interface for a SeepientAgent.**
> A brain-mind architecture for self-improving AI agents, modelled on human neuroanatomy and cognition.

---

## 1. What this is

**SeepientAgent** is a species of self-improving AI agent. **SeepientAgent BMI** (Brain-Mind-Interface) is the brain-mind system that any SeepientAgent instance runs — its cognition, memory, identity, and self-improvement machinery. **Zoe** is one named instance of a SeepientAgent (the reference instance for this codebase). Someone else building their own SeepientAgent may give theirs any name; the BMI is the same.

This document set specifies the BMI: what it is, why it is structured the way it is, how each component works, how it integrates with the existing agent loop, and how every claim about it is verifiable rather than decorative.

These specs graduate and supersede three earlier drafts (`docs/todo/zMind/*`), which are removed in favor of this single source of truth.

---

## 2. The thesis

Most agent architectures treat the LLM as a **stateless executor**: receive input → think → act → return. They bolt memory, safety, and persona onto the outside as prompt fragments or tool calls, all running on one timeline, at one level, with one weight.

The human brain does not work this way, and neither should an agent that aspires to genuine, bounded self-improvement. The brain is a **collection of functionally distinct systems** that:

- operate at **different time-scales** (continuous, per-task, offline);
- sit at **different abstraction levels** (pre-conscious gating vs. deliberative reasoning);
- are independently **gain-controllable** (neuromodulators amplify some, suppress others);
- include an **immutable moral floor** that governs how the rest may evolve;
- **consolidate and self-edit offline** (sleep, dreaming, proceduralization).

SeepientAgent BMI models this directly. It is not "prompt engineering with neuroscience vocabulary." It is a set of separately-built, separately-tunable, separately-evolvable components, wired onto an existing agent loop, whose combined effect — and whose individual effects — are **measurable**.

The core claims of this architecture, each defended in the docs that follow:

1. **Separation is load-bearing.** Components are distinct files and systems because you cannot let an agent rewrite its personality if its personality is welded to its conscience. Separation is what makes selective evolvability, state-of-mind remixing, and independent verification possible.
2. **Time-scales matter.** RAS and AMG are continuous modulatory transforms, not reasoning steps. DMN is an offline self-reflection system. Memory consolidation and skill authoring happen offline. The per-query pipeline is thinner than prior designs assumed.
3. **Weights are mechanisms, not vibes.** A "weight" on a component must map to a concrete mechanical effect (framing language, token budget, position, veto authority, dynamic self-escalation). A weight that changes no observable output is cut from the design.
4. **Self-improvement is a control system with the conscience as controller.** Every self-modification — to persona, to skills, to the self-model — passes through a core-values gate. Evolution is real but bounded.
5. **Nothing here is theatre.** Every component and every weight has an observable success criterion and an evaluation method (see `11-evaluation-framework.md`). Writing the doc is not shipping the feature.

---

## 3. The brain-mind analogy — fully, not decoratively

The architecture borrows from neuroscience **structurally** (which systems exist) and **functionally** (what each does and when). The mapping is defended component-by-component in the deep-dives. This section is the overview.

### 3.1 The components and their neural basis

| BMI component | Neural / mind basis | Time-scale | Role in the BMI |
|---|---|---|---|
| **Conscience** | Prefrontal cortex (executive moral function, the superego) | Continuous, immutable | The moral floor. Veto power over everything including user requests. The fitness function for all evolution. |
| **Amygdala (AMG)** | Amygdala | Continuous, pre-conscious | Safety-valence tagging. Frames *how* the agent reasons. Self-escalates to veto on threat detection. |
| **Reticular Activating System (RAS)** | RAS | Continuous, pre-conscious | Attention / salience filter. Gain control over what reaches reasoning. LLM-free. Owns the wake-idle cycle. |
| **Default Mode Network (DMN)** | DMN | Offline (anti-correlated with focus) | Self-model and theory-of-mind. Runs during Dreaming. Its *output* (the self-model) is injected online at a weight that drops under focus and rises under reflection. |
| **Persona** | The developing self / ego | Online (output) / Offline (evolution) | The evolvable voice, style, preferences. Rewritten during Dreaming, conscience-gated. |
| **Hippocampus** (working memory) | Hippocampus (short-term buffer) | Per-session | `MEMORY.md`-style scratchpad, high weight, updated live via `onStep`, wiped after Dreaming. |
| **Cortex** (long-term memory) | Neocortex + hippocampal consolidation | Offline-populated, online-retrieved | Episodic + semantic + relational memory on the SeepientAgent's *own* graph + vector + notes substrate. |
| **Basal Ganglia** (procedural / skills) | Basal ganglia (habit, procedure) | Offline-populated, online-retrieved | Skill library + the proceduralization loop (self-authoring of skills). |

### 3.2 The mechanisms and their neural basis

| BMI mechanism | Neural / mind basis | Role |
|---|---|---|
| **Neuroanatomy** (the component manifest) | The brain's structural map | A declarative manifest: each component's source, weight profile, evolvability flag, role, injection mechanism. The single source of truth for "what the brain is." |
| **Thalamus** (the context assembler) | Thalamus — the relay/gate that routes signals to the cortex | Reads Neuroanatomy + current Cognitive State + dynamic modulations, and assembles the cognitive context (system prompt + pre-call transforms) for each LLM call. |
| **Neuromodulation** (the weight system) | Dopamine, serotonin, norepinephrine, acetylcholine | Weights don't carry information — they change operating mode: what's amplified, suppressed, and how plastic the system is. |
| **Cognitive State** (a state of mind) | A neuromodulatory state | A resolved weight vector over all components. Switching modes = changing the vector. |
| **Dreaming** | Sleep-dependent memory consolidation + replay | The offline loop: consolidates memory, evolves persona/DMN, authors skills, all conscience-gated. |
| **Wake Cycle** | The sleep-wake cycle, governed by RAS | Session start = "waking" (assemble active context, task mode). Idle = hand control to DMN/Dreaming. |
| **Proceduralization** | Long-term potentiation, motor-sequence learning | The skill self-authoring loop: detect reusable strategy → search library → draft/update skill → validate → commit. |
| **Autonomy Level** | — | The user-controlled dial: **semi-autonomous** (evolution surfaced for human review) vs **true-autonomous** (evolution within the conscience envelope, outliers flagged). |

### 3.3 Why each part of the analogy earns its keep

- **Conscience / superego:** there must be an invariant that the evolving self cannot rewrite. Without it, self-improvement is unbounded drift. The prefrontal-cortex analogy is exact: top-level governance that arbitrates the rest.
- **AMG as continuous, not checkpoint:** the amygdala does not wait for a tool call. It tags valence continuously and can hijack attention faster than the cortex deliberates. Modeling it as a per-query gate (as an earlier draft did) loses the entire capability. Its most powerful behavior — **dynamic self-escalation** on threat detection — only exists because it is a separate, gain-controllable component.
- **RAS as gain control, not reasoning:** RAS does not "reason about relevance." It gates arousal and filters what reaches awareness (the cocktail-party effect, habituation). In code it is a pre-attentive, largely LLM-free salience scorer — cheap, parallel, deterministic.
- **DMN anti-correlated with focus:** the DMN is suppressed during focused external tasks and active during rest, self-reference, theory of mind, and moral reasoning. Making it a per-query node is neurologically backwards. Its *process* runs offline; its *output* is available online at a weight that encodes the anti-correlation.
- **Hippocampus vs Cortex, short vs long:** the hippocampus is a fast, small, volatile buffer; the cortex is slow, vast, consolidated. Modeling them as one "memory" collapses the most important distinction (volatile foreground vs stable background) and breaks the weight system (they must have independent gains).
- **Basal ganglia / proceduralization:** skills are not facts you retrieve; they are procedures you acquire through repetition and success. The self-authoring loop is the computational analog of turning a solved strategy into an automatic habit.
- **Neuromodulation as the weight system:** this is the deepest justification for your weighting idea. Neuromodulators don't carry content — they reconfigure networks into different operating modes. A Cognitive State is the same: a weight vector that puts the brain into a mode. This is why AMG can self-escalate (it raises its own gain) and why DMN can be crushed during a release (its gain drops).

---

## 4. Two instance models, and the one chosen

### 4.1 SeepientAgent instances vs the BMI

The BMI is shared infrastructure. A **SeepientAgent instance** is one running brain-mind: a named agent (Zoe, Atlas, …) with its own memories, persona, user relationship, and skill library, but the same Neuroanatomy and Conscience.

### 4.2 Storage scope (spec-global vs per-instance)

| Data | Scope | Reason |
|---|---|---|
| Neuroanatomy manifest (structure) | **Global** (shipped with the package) | Every SeepientAgent has the same brain structure. |
| Conscience (core values) | **Global** (shipped, immutable) | The moral floor is species-level, not personal. |
| AMG / RAS rules (operational safety/attention) | **Global** (shipped) | Safety and attention are species-level. Their *tuning* (e.g. RAS salience model) is per-instance. |
| DMN self-model | **Per-instance** | "Who I am" is the instance's own. |
| Persona | **Per-instance** | The developing self belongs to the instance. |
| Hippocampus (working memory) | **Per-session** | Scratchpad, wiped after Dreaming. |
| Cortex (long-term memory) | **Per-instance** | Autobiography is the instance's own. |
| Basal Ganglia (skills) | **Per-instance** (authored) + **Global** (built-in) | Built-in skills ship with the package; authored skills accumulate per-instance. |
| Autonomy Level | **Per-instance** | The user's dial. |

This resolves the "one Zoe or many" question cleanly: **the BMI is one; instances are many.** Core values and brain structure are *hers* at the species level; memory, persona, and the user relationship are *hers* at the instance level.

---

## 5. The Autonomy Level

Two modes, user-toggled, governing how the instance evolves itself:

- **Semi-autonomous (default):** every evolution — a Persona rewrite, a DMN self-model update, a self-authored skill — is drafted during Dreaming, validated by the Conscience, and **surfaced for human review** before commit. Diffs are atomic and rollbackable.
- **True-autonomous:** evolution proceeds within the Conscience envelope and commits automatically. Outliers (conscience-adjacent judgments, large rewrites, skills touching sensitive domains) are still flagged for review. Rollback is always available.

The Conscience gate is invariant across both modes — autonomy controls *commit gating*, not *moral gating*. See `10-evolution-system.md`.

---

## 6. Guiding principles

These are referenced throughout the set. Violations are reasons to reject a design, not preferences.

1. **Separation is structural, not cosmetic.** Each component is its own file and system. Merging components for convenience defeats selective evolvability, state-of-mind remixing, and independent verification.
2. **Modify, don't duplicate.** We extend the existing agent loop, middleware, hooks, session store, and skills system. We do not build parallel versions. Every existing system gets a verdict (extend / no-change / net-new) in the architecture doc.
3. **Measurement-first.** No weight, mechanism, or component ships without an observable success criterion and an evaluation method. Architecture without measurement is theatre.
4. **The conscience is the controller.** All evolution is conscience-gated. This is the invariant that keeps self-improvement bounded.
5. **Time-scales are respected.** A component runs at its correct level (continuous / pre-call / post-call / offline). We do not turn a continuous modulatory system into a per-query pipeline node.
6. **Honest about research risk.** Open questions and failure modes are documented per component (`§Open questions & risks`), not hidden. Several mechanisms (identity self-rewrite stability, the weight→behavior mapping) are empirically open problems with proposed controls, not solved.

---

## 7. Document map

| Doc | Tier | Purpose |
|---|---|---|
| `00-overview.md` | Conceptual | **This document.** Vision, analogy, vocabulary, principles. |
| `01-architecture.md` | System | The Neuroanatomy manifest schema, the Thalamus assembler, the Neuromodulation weight→mechanism mapping, the three time-scales, integration vs the existing agent loop, multi-instance storage model. |
| `02-conscience.md` | Component | The immutable moral floor. |
| `03-amg.md` | Component | Continuous safety-valence, self-escalation. |
| `04-ras.md` | Component | Pre-attentive gain control / salience filter (LLM-free). |
| `05-dmn.md` | Component | Offline self-model, online theory-of-mind. |
| `06-persona.md` | Component | Evolvable persona (Dreaming, conscience-gated). |
| `07-memory-short.md` | Component | Hippocampus — working memory. |
| `08-memory-long.md` | Component | Cortex — episodic/semantic/relational memory store. |
| `09-skills-procedural.md` | Component | Basal Ganglia — procedural memory + self-authoring loop. |
| `10-evolution-system.md` | Cross-cutting | Dreaming, proceduralization, persona/DMN evolution, the conscience gate, the Autonomy Level toggle, drift controls. |
| `11-evaluation-framework.md` | Cross-cutting | The measurement harness — how we prove weights change behavior, evolution stays bounded, safety holds. The anti-theatre methodology + eval suites. |
| `12-token-economy.md` | Cross-cutting | Context-window budgeting — how eight components plus retrieved context plus growing history fit a finite window without silently truncating safety. The scarcity that makes the weights cost something. |
| `13-cognitive-state-and-hooks.md` | Cross-cutting | The BMI's two integration mechanisms: `CognitiveTurnState` (shared per-turn state for components that must influence each other — AMG escalation) and the passive hook layer (RAS logging, Hippocampus, learning detection). The load-bearing seam with the agent loop. |

**Read order for a newcomer:** 00 → 01 → any component (each is self-contained given 01) → 13 → 12 → 10 → 11.

**Read order for a builder:** 01 → 13 (the seam everything hangs on) → 12 (budget constraints shape every component) → the component you're building → 11 (to know how it will be verified) → 10 (to know how it evolves).

---

## 8. What this is not

- **Not a claim of consciousness.** "Self-model," "persona," "dreaming," and "conscience" are engineering names for control structures, not assertions of sentience. The reflection loop that rewrites the persona is a feedback control system, not a mind. The grand framing is kept out of the docs deliberately — it overpromises, invites drift, and makes safety harder to reason about.
- **Not a replacement for the agent loop.** `runAgentLoop` stays the single execution engine. The BMI assembles the cognitive context (system prompt + pre-call transforms) and runs offline loops (Dreaming); it does not introduce a parallel execution path.
- **Not standalone.** The BMI is built by extending existing systems, not by duplicating them.
- **Not finished.** Several mechanisms are open research questions with proposed controls, not proven solutions. The docs say so.

---

*Architecture version: 2.0 — supersedes the `docs/todo/zMind/` drafts.*
*Last updated: 2026-06-25*
