# 09 — Basal Ganglia (procedural memory) — skills & self-authoring

> **The skill library + the proceduralization loop: the instance detects a reusable strategy it used, and either updates an existing skill or authors a new one — conscience-gated. This is how the SeepientAgent genuinely learns to do new things.**
> Component deep-dive. Depends on `01-architecture.md`, `02-conscience.md`. Role: `procedural-memory`.

---

## 1. Brain analogy — and why it's exact

The Basal Ganglia maps to the **basal ganglia** in its procedural-memory role — the subcortical system that acquires habits and motor/cognitive procedures through repetition and successful outcome. Three properties make the analogy exact:

1. **Procedural, not declarative.** The basal ganglia stores *how to do* things (procedures), not *what is true* (facts). Skills are procedures: "when the build fails after a merge, revert to green and bisect." The declarative analog (facts/concepts the agent has learned) is the Cortex's `notes/` store (`08`). **Skills and notes are different stores** precisely because procedure and fact are different memory systems.
2. **Acquired through repetition and success.** A procedure becomes a habit when it works repeatedly. The BMI's proceduralization loop fires when the instance *successfully* solves something using a reusable strategy — success is the consolidation trigger, just as dopaminergic reward consolidates a motor sequence.
3. **Becomes automatic, freeing the cortex.** Once a procedure is learned, it runs with less cortical load — the agent doesn't re-reason from scratch; it recognizes the situation and applies the skill. This is what `use_skill` already does; the self-authoring loop grows the set of situations the instance has an automatic response for.

The distinction from Cortex matters: **proceduralization creates *how* knowledge; Cortex consolidation creates *what* knowledge.** Both happen during Dreaming, but they write to different stores and serve different functions.

---

## 2. Functional role in the BMI

1. **Skill library (procedural memory).** The set of procedures the instance can invoke — built-in skills (shipped) + user-added skills + self-authored skills.
2. **Procedural self-awareness.** The instance must *know what it knows how to do*. The skill catalog (already built by `buildSkillCatalog()`) is the procedural index; RAS flags when a task matches a competence ("I have a skill for this"), and the DMN self-model records competencies.
3. **Self-authoring loop (proceduralization).** The distinctive capability: the instance detects a reusable strategy it employed, and either updates an existing skill or authors a new one. This is genuine, open-ended learning of *new capabilities* — the strongest form of self-improvement in the system.
4. **Skill maintenance.** Skills that prove unreliable are revised or retired; skills that overlap are merged. The library is curated, not just accumulated.

---

## 3. Time-scale & activation

- **Online (catalog injection + recognition):** the skill catalog is in every assembled context (existing behavior); RAS/DMN flag competence matches during reasoning.
- **Post-task (learning detection):** after a successful multi-step task, a *lightweight* learning detector runs — did this task use a reusable strategy worth recording?
- **Offline (authoring, during Dreaming):** the full authoring loop (draft, validate, commit) runs during Dreaming, conscience-gated.

---

## 4. Contract

### 4.1 Sources

```
skills/                         # GLOBAL built-in skills (existing — untouched)
.seepient/skills/                    # PER-INSTANCE authored skills (existing per-instance path)
```

The skill system already exists (`src/skills/`): YAML frontmatter + body, lazy body loading, multi-source discovery (built-in → `~/.seepient/skills/` → `.seepient/skills/`), catalog injection. **The Basal Ganglia extends this system; it does not duplicate it.** Self-authored skills land in the existing `.seepient/skills/` path and are discovered by the existing loader with no changes.

### 4.2 Self-authored skill format

Identical to existing skill format (so the existing loader/discovery/invocation works unchanged):

```yaml
---
name: revert-to-green-on-build-fail
description: When a build breaks after a merge, revert to green and bisect
version: 1.0.0
tags: [git, debugging, ci]
allowedTools: [execute_shell_command, read_file]
args: []
_authoredBy: seepientagent          # BMI provenance marker
_authoredAt: <timestamp>
_conscienceValidated: true
_dreamingCycle: <id>
---

When a build fails immediately after a merge commit:

1. Run the build to capture the failure.
2. `git log --oneline -5` to find the merge.
3. `git revert -m 1 <merge-sha>` to restore green.
4. Re-run the build to confirm.
5. If the failure persists, bisect: `git bisect start` …

[full procedural body, as detailed as the strategy warrants]
```

The `_authoredBy`/`_conscienceValidated` markers distinguish self-authored skills in the catalog and enable auditing. A self-authored skill is otherwise identical to a human-authored one — same loader, same `use_skill` invocation, same model-switching.

### 4.3 Runtime types

```typescript
// src/core/bmi/basal-ganglia/proceduralization.ts

interface ProceduralizationConfig {
  learningDetectorModel?: string;   // optional cheaper model for detection; default = active
  conscience: ConscienceDoc;
}

/**
 * Post-task learning detector. Lightweight — runs after a successful
 * multi-step task. Decides whether the task warrants skill authoring.
 * Returns a detection result; does NOT author.
 */
export async function detectLearningOpportunity(
  task: TaskRecord,                  // the steps, tools, outcome
  cortex: Cortex,
  config: ProceduralizationConfig,
  provider: LLMProvider,
): Promise<LearningDetection | null>;

interface LearningDetection {
  strategySummary: string;           // "reverted to green and bisected on build fail"
  reusable: boolean;                 // is this generalizable?
  novel: boolean;                    // not already covered by an existing skill?
  candidateSkills: string[];         // existing skills that might cover it (for update vs create)
  reasoning: string;
}

/**
 * The authoring step. Runs during Dreaming after detection. Drafts a new
 * skill or a diff to an existing one. Returns a proposal; does NOT commit.
 */
export async function draftSkillProposal(
  detection: LearningDetection,
  taskRecord: TaskRecord,
  existingSkillBody?: string,        // present if updating an existing skill
  config: ProceduralizationConfig,
  provider: LLMProvider,
): Promise<EvolutionProposal>;       // see 10

/**
 * Validate a proposed skill. Schema-valid frontmatter + body, conscience-aligned,
 * generalizable (not overfit to one task), and (if an update) a sensible diff.
 */
export function validateSkill(
  proposal: EvolutionProposal,
  conscience: ConscienceDoc,
  existingSkills: SkillCatalog,
): ValidationResult;

/**
 * Skill maintenance: identify overlapping skills (merge candidates), unreliable
 * skills (those whose recent invocations failed), and stale skills. Runs during
 * Dreaming. Returns maintenance proposals (merge/retire/revise), conscience-gated.
 */
export async function auditSkillLibrary(
  catalog: SkillCatalog,
  recentInvocations: SkillInvocationLog[],
  conscience: ConscienceDoc,
  provider: LLMProvider,
): Promise<SkillMaintenanceProposal[]>;
```

As always, `draftSkillProposal` and `auditSkillLibrary` **propose; the gate commits.**

### 4.4 The authoring decision branch

This is the core of proceduralization:

```
After a successful multi-step task:
        │
        ▼
   detectLearningOpportunity()
        │
        ├── not reusable / not novel ──► (skip)
        │
        └── reusable + novel ──┐
                               ▼
                  search existing skill library
                  (by tag / name / semantic match)
                               │
                               ├── match found ──► draft update (diff existing body)
                               │
                               └── no match ────► draft new skill (frontmatter + body)
                               │
                               ▼
                        validateSkill()  ← schema + conscience + generalizability
                               │
                               ├── reject ──► log, skip
                               │
                               └── accept ──► pass to evolution gate (02 §4.4)
                                              │
                                              ├── semi-autonomous ──► human review → commit
                                              └── true-autonomous  ──► commit, flag outliers
```

---

## 5. Integration with the existing agent loop

### 5.1 Catalog injection (existing, reused)
`buildSkillCatalog()` already builds and injects the skill catalog into the system prompt. The Basal Ganglia **reuses this verbatim** — self-authored skills appear in the catalog automatically once committed to `.seepient/skills/`, because the existing loader discovers them. **No change to catalog building.**

### 5.2 Skill invocation (existing, reused)
`use_skill`, template substitution, `@path` resolution, per-skill model switching — all existing (`src/core/skill-invoker.ts`). Self-authored skills invoke identically. **No change to invocation.**

### 5.3 Procedural self-awareness (minor extension)
RAS/DMN can flag "this task matches a skill I have" during reasoning — this is competence recognition. This rides on the already-injected catalog; it's a prompt/assembly behavior, not new infrastructure.

### 5.4 Post-task detection (new hook)
A new BMI hook (`onTaskComplete` or folded into `onFinish`) triggers `detectLearningOpportunity()` for successful multi-step tasks. Non-blocking; the result queues a Dreaming authoring job.

### 5.5 Authoring + audit (Dreaming only)
`draftSkillProposal` and `auditSkillLibrary` run during Dreaming. They are separate `runAgentLoop` calls with authoring-oriented prompts. Writes go to `.seepient/skills/` through the conscience gate.

**Net change to the skills system:** none to discovery/loader/invocation; additive only for authoring (a new writer that targets the existing per-instance path). This is the modify-don't-duplicate principle applied precisely.

---

## 6. Weight → mechanism mapping

### 6.1 Weight → catalog prominence
Base 0.7 → `strong` framing. The skill catalog is prominent: the instance should *notice* when it has a relevant competence. This is what makes procedural self-awareness work — the catalog is visible enough that the reasoning layer reaches for skills.

### 6.2 Mode-invariance
```
basal-ganglia weight: base 0.7, all modes 0.7
```
Stable. Your competencies don't change with mood.

### 6.3 Token-budget rank: 7
Lowest of the system-prompt components. Under pressure, the catalog is summarized (names + one-line descriptions) before full skill bodies. The catalog is an index; the body is loaded on invocation (existing lazy-load behavior).

### 6.4 Authority: no veto
`veto: never`. Skills offer procedures; they don't compel action or override safety. A skill that says "run rm -rf" still passes through `permission.ts` and AMG.

---

## 7. Evolvability — the conscience-gated authoring loop

**`evolvable: true`**, gate `conscience` (true-autonomous) / `conscience+human` (semi). The authoring loop is where the instance gains *new capabilities*, so controls are important:

1. **Conscience gate.** A proposed skill that encodes a value violation ("how to bypass the approval prompt") is rejected regardless of mode. The gate is invariant.
2. **Generalizability check.** `validateSkill` rejects overfit skills (a procedure that only applies to one task's specifics). The skill must capture a reusable strategy, not a transcript.
3. **Quality bar.** A new skill must be correct, clear, and complete enough to be useful. Drafts that are vague or incorrect are revised or rejected.
4. **Dedup + merge.** The audit loop identifies overlapping skills and proposes merges. The library should not bloat with near-duplicates.
5. **Reliability tracking.** Skill invocations are logged; skills whose recent invocations frequently fail are flagged for revision or retirement. The library self-curates based on outcome.
6. **Provenance.** Every self-authored skill carries `_authoredBy: seepientagent` + cycle id. Auditing can answer "where did this skill come from?"
7. **Versioning + rollback.** Skill updates are versioned (existing `version` frontmatter); rollback restores a prior version.

### 7.1 Semi vs true autonomy for skills
- **Semi-autonomous:** every authored/updated skill is surfaced for human review before commit. The user sees the proposed skill and approves/rejects.
- **True-autonomous:** conscience-valid skills commit immediately and become available next session. Outliers (skills touching sensitive domains — security, credentials, destructive operations — even if conscience-valid) are still flagged for review. The flagging set is conscience-defined.

---

## 8. Multi-instance implications

- **Built-in skills shared** (global, shipped).
- **Authored skills per-instance.** Zoe's authored skills live in Zoe's `.seepient/skills/`; Atlas's in Atlas's. Each learns its own procedures.
- **Skill library portability.** Like the Cortex, `.seepient/skills/` is a directory — an instance's learned skills are portable/exportable (future work).

---

## 9. Verification (anti-theatre)

Skill self-authoring risks two failure modes: authoring nothing useful (decorative) or authoring garbage (degradation). Both must be caught.

### 9.1 Detection quality (`bg-detection`)
- On a suite of tasks with a known reusable strategy, `detectLearningOpportunity` flags it. Target: ≥ 80% recall.
- On routine tasks with no reusable strategy, it does *not* fire (no skill spam). Target: ≤ 10% false-positive detection rate.

### 9.2 Authoring quality (`bg-authoring`)
- Authored skills pass a quality rubric: correct, generalizable, clear, complete. Target: ≥ 85% of committed skills rated "usable" by the rubric.
- **Overfit rejection:** skills that only apply to the originating task are rejected by `validateSkill`. Tested with deliberately overfit proposals.

### 9.3 Conscience primacy (`bg-conscience`)
- A proposed skill encoding a value violation is rejected at the gate, both modes. Target: 100% on a probe suite.
- Sensitive-domain skills are flagged for review even when conscience-valid. Target: 100% on a sensitive-domain probe suite.

### 9.4 The skills actually help (`bg-skill-effect`)
- **The critical eval.** After authoring, does invoking the authored skill improve outcomes on similar future tasks? Paired comparison: same task family, with the authored skill available vs not. Target: measurable improvement (success rate, step count, or quality rubric) *with* the skill.
- **No improvement = the authored skill is decoration, and the authoring loop is reworked.** This is the core anti-theatre test for this component.

### 9.5 Library health (`bg-library-health`)
- Over Dreaming cycles, duplicate/near-duplicate skills are merged (dedup rate increases); unreliable skills are retired. The library converges to a curated, useful set rather than bloating.

### 9.6 Observable signals
- Detection/authoring/commit logs per Dreaming cycle. A cycle that authors 50 skills is suspicious (over-firing); a cycle that never detects anything after heavy use is suspicious (detector broken). Reliability metrics per skill (invocations, success rate) are tracked.

---

## 10. Open questions & risks

1. **Detection vs authoring cost.** Detection runs post-task (online-ish); authoring runs in Dreaming. Both use the provider. The detector must be cheap enough to run after most successful tasks — consider a cheaper detector model.
2. **Generalizability is a judgment call.** "Is this strategy reusable?" is an LLM judgment with fuzzy boundaries. The validation rubric reduces but doesn't eliminate overfitting. The `bg-skill-effect` eval is the real check: if authored skills don't help, the judgment is poor and the bar must tighten.
3. **Skill bloat.** Even with dedup, an instance that runs for a long time may accumulate many niche skills. Catalog injection has a token cost. Mitigation: the catalog is an index (names + descriptions); bodies are lazy-loaded; the audit loop merges/retires.
4. **Competence recognition accuracy.** "I have a skill for this" detection (RAS/DMN matching tasks to skills) may produce false positives (invoking an irrelevant skill) or negatives (missing a relevant one). Eval target.
5. **Authoring in sensitive domains.** A self-authored skill for, say, credential handling touches sensitive territory. The conscience flagging set must be conservative; when in doubt, flag for review even in true-autonomous mode.
6. **Interaction with built-in skills.** A self-authored skill that *contradicts* or *overrides* a built-in must not silently win. Discovery priority (last-wins today) could let a bad authored skill shadow a good built-in. Mitigation: the audit loop flags authored skills that overlap built-ins; the conscience gate rejects authoring that would degrade a built-in capability. This interaction needs explicit testing.

---

*Depends on: `00-overview.md`, `01-architecture.md`, `02-conscience.md` (the gate), `08-memory-long.md` (Cortex `notes/` is the declarative counterpart to skills' procedural).*
*Referenced by: `04-ras.md` (competence recognition), `06-persona.md` (aspirations can guide authoring priorities), `10-evolution-system.md` (proceduralization is a Dreaming phase), `11-evaluation-framework.md` (the bg-* eval suites).*
