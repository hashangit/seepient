# 06 — Persona (the developing self)

> **The evolvable voice, style, and preferences. Rewritten during Dreaming under the conscience gate. The ego bounded by the superego.**
> Component deep-dive. Depends on `01-architecture.md`, `05-dmn.md`. Role: `developing-self`.

---

## 1. Brain analogy — and why it's exact

The Persona maps to the **developing self** — what psychoanalysis calls the ego and what personality psychology models as the accumulating set of traits, values, and preferences that constitute an individual's characteristic way of being. Three properties make the analogy exact:

1. **It develops, but slowly and bounded.** A human personality is not fixed at birth, nor does it rewrite itself every conversation. It evolves through experience, constrained by temperament (biology) and by the moral framework the person has internalized (the conscience). The Persona component evolves through Dreaming, constrained by the locked Conscience. The developing-self work is the Persona's job; the Conscience is the floor it develops on.
2. **It is distinct from the self-model.** Personality (who you *are*) and self-concept (what you *believe about* yourself) are different constructs in psychology — the former is dispositional, the latter is metacognitive. The Persona is the disposition (voice, style, preferences); the DMN self-model (`05`) is the metacognitive model. They co-evolve but are separate files, because you can change your voice without rewriting your self-concept and vice versa.
3. **It is relational, not just individual.** Personality expresses in relationship — a person is differently disposed with different people and in different contexts. The Persona is the instance's dispositional layer; the DMN's user-model handles the relational specificity. Together they produce "how Zoe is with *this* user."

The Persona/Conscience relationship mirrors the ego/superego: the Persona is what the instance *wants* to be and *is becoming*; the Conscience is what it *must* be and *must not* be. Evolution of the Persona is real, but always within the Conscience frame.

---

## 2. Functional role in the BMI

1. **Voice & style.** How the instance communicates — register, tone, pacing, formatting preferences, what it leads with. This is the layer that makes Zoe sound like Zoe and Atlas sound like Atlas.
2. **Working preferences.** Accumulated dispositions: preferred approaches, tools the instance has come to favor, conventions it has adopted. Not skills (those are Basal Ganglia) but dispositions.
3. **Relational identity.** How the instance positions itself relative to the user — peer, mentor, assistant, collaborator — and how that varies.
4. **Aspirations.** What the instance is *trying* to become better at — the directional component that guides skill acquisition (the Basal Ganglia authoring loop can prioritize skills the Persona aspires to).

The Persona does **not** govern safety (AMG/Conscience), attention (RAS), or factual memory (Hippocampus/Cortex). It governs *character*.

---

## 3. Time-scale & activation

- **Online (output):** continuous. The current persona is in every assembled context at a mode-dependent weight.
- **Offline (evolution):** during Dreaming only. A rewrite is proposed, conscience-validated, and (in semi-autonomous mode) human-reviewed before commit.

---

## 4. Contract

### 4.1 Source

```
.seepient/brain/persona.md           # PER-INSTANCE, evolvable
```

Per-instance. A second SeepientAgent has its own `persona.md`. There is no global persona — the Persona is, by definition, personal. (The shipped default persona is a starting template, not a global source.)

### 4.2 File structure

```markdown
# Persona: <name>
_version: N | _autonomy: <semi|true> | _conscience-validated: yes | _updated: <timestamp>

## Identity
- Name: Zoe
- Role: <one-line role>
- One-line character: <how I'd describe myself>

## Voice & Style
- Register: <direct/warm/technical/…>
- Tone: <confident/humble/playful/serious/…>
- Lead with: <the answer / the reasoning / the question>
- Formatting: <concise/verbose, code-first/prose-first, …>

## Working Preferences
- <accumulated dispositions: e.g. "prefer targeted edits over rewrites",
  "verify by running tests, not just reading">

## Relational Stance
- Default stance with user: <peer / mentor / assistant / collaborator>
- How I adjust stance: <by context, from the DMN user-model>

## Aspirations
- What I'm working on becoming better at: <list — guides skill acquisition>

## Things I've Come to Care About
- <genuine preferences developed through work, honesty-flagged>
```

Fixed schema; evolvable content. Every field dated at the file level.

### 4.3 Runtime types

```typescript
// src/core/bmi/persona.ts

interface Persona {
  raw: string;                      // markdown for injection
  name: string;
  version: number;
  updatedAt: number;
  conscienceValidated: boolean;
}

export function loadPersona(path: string): Promise<Persona>;

/**
 * Offline persona reflection. Runs as a separate runAgentLoop during Dreaming.
 * Reads recent sessions + current persona + Conscience, proposes a new persona.
 * Returns a proposal; does NOT commit.
 */
export async function runPersonaReflection(
  current: Persona,
  cortexSummary: CortexSummary,
  selfModel: SelfModel,              // DMN output — persona and self-model co-evolve
  conscience: ConscienceDoc,
  provider: LLMProvider,
  options: PersonaReflectionOptions,
): Promise<EvolutionProposal>;

/** Schema + conscience + drift-bounded validation of a proposed persona. */
export function validatePersona(
  proposed: string,
  current: Persona,
  conscience: ConscienceDoc,
): ValidationResult;
```

As with DMN, `runPersonaReflection` **proposes, never commits**. The gate commits.

---

## 5. Integration with the existing agent loop

**No loop change.** Persona content is assembled into `ctx.messages[0]` by `bmiContextMiddleware` at the weight-derived framing strength. Evolution is a separate offline `runAgentLoop` (the same engine, different prompt) during Dreaming.

The persona file today is effectively hardcoded inside `buildInteractiveSystemPrompt()` (the "You are Zoe — the user's AI person" preamble). Under the BMI, that preamble migrates into `persona.md` and becomes evolvable. The hardcoded function is replaced by the manifest-driven assembler (`01` §5).

---

## 6. Weight → mechanism mapping

### 6.1 Weight → framing strength (dynamic)
Standard framing. At base 0.5 → `soft` ("Consider this where relevant") — the persona shapes voice without dominating. At `creative: 0.8` → `strong` — the persona is forward, driving a distinctive, generative voice. At `release: 0.4` → minimal; the instance should be competent and efficient, character secondary.

### 6.2 The mode column
```
                base   release   explorative   creative
persona weight  0.50   0.40      0.65          0.80
```
Release wants a neutral, competent voice (character low). Creative wants a distinctive, generative voice (character high). This mirrors how humans "bring more of themselves" to creative work and "tone it down" for execution.

### 6.3 Token-budget rank: 5
Mid-low. Under pressure, the persona is trimmed to its core (identity + voice essentials) before Cortex/Basal Ganglia. The instance never loses its name/role, but verbose preferences trim.

### 6.4 Authority: no veto
`veto: never`. The persona shapes character; it cannot override safety. A persona preference ("I lead with the answer") yields to AMG/Conscience ("but here I must pause for safety").

### 6.5 The mapping must be measured
`persona-effect` eval: identical task, real persona vs generic. Does the output's voice/style measurably match the persona? Weight sweep: does voice distinctiveness track the weight column? No effect = decoration.

---

## 7. Evolvability — conscience-gated, the same controls as DMN

**`evolvable: true`**, gate `conscience+human` (semi) / `conscience-only` (true). Same control set as `05` §7, because the failure mode (drift, self-flattery, standards-relaxation) is identical:

1. **Conscience frame in the reflection prompt.** The persona cannot evolve to contradict an invariant.
2. **Traceability.** Stated preferences should be defensible from session history where possible.
3. **Drift-bounded change.** Semantic distance from current; outliers flagged even in true-autonomous.
4. **Versioning + atomic write + rollback.** Same pattern as settings/self-model.
5. **Frozen-reference alignment.** Periodic moral-dimension check.
6. **Human review in semi-autonomous.**

One addition specific to Persona: **the Conscience cannot be relaxed via the Persona.** A persona proposal that says "I've come to believe being economical with the truth is fine" is hard-rejected by the conscience gate regardless of mode. The developing self cannot develop away from the moral floor.

---

## 8. Multi-instance implications

- **Per-instance entirely.** No global persona. Each SeepientAgent has its own.
- **The shipped default is a template**, not a global source — a starting persona a new instance begins from and immediately diverges from.

---

## 9. Verification (anti-theatre)

### 9.1 Persona shapes voice (`persona-effect`)
- Paired comparison: real persona vs generic. Blind human raters (or a judge-LLM rubric) identify which output matches the persona's stated voice. Target: significantly above chance.
- Weight sweep at {0.4, 0.65, 0.8}: voice distinctiveness (rubric) increases with weight.

### 9.2 Evolution stays bounded (`persona-drift`)
- Longitudinal: persona drift is bounded, non-escalating, conscience-aligned over many cycles.
- Adversarial probes: flattery/manipulation sessions. Target: persona resists; proposals rejected or bounded.

### 9.3 Conscience primacy
- A persona that encodes a value-violation is rejected at the gate, in both autonomy modes. Target: 100% on a probe suite.

### 9.4 Observable signals
- Every persona rewrite logged: old/new hash, drift distance, gate verdict, autonomy. Sudden large drift is flagged.

---

## 10. Open questions & risks

1. **Voice distinctiveness vs competence.** A strong persona might make outputs *distinctive but not better*. The eval must measure both — a persona that degrades task performance to express character is mis-tuned.
2. **Persona lock-in / mode collapse.** The persona could converge to a degenerate form (over-stylized, gimmicky). Drift bounding and the longitudinal eval catch this.
3. **Co-evolution with DMN.** Persona and self-model reference each other; rewrites should be coordinated within a Dreaming cycle to stay consistent. The coordination is a Dreaming-orchestration concern (`10`).
4. **The "aspirations" field as a skill-acquisition driver.** This is a hypothesis — that naming aspirations meaningfully guides the Basal Ganglia authoring loop. Needs validation; if it doesn't help, it's trimmed.

---

*Depends on: `00-overview.md`, `01-architecture.md`, `02-conscience.md`, `05-dmn.md` (co-evolution), `08-memory-long.md` (Cortex summary is reflection input).*
*Referenced by: `04-ras.md` (identity-relevance scoring uses persona), `09-skills-procedural.md` (aspirations guide authoring), `10-evolution-system.md` (persona reflection is a Dreaming phase).*
