# Architecture Setup Assessment: Seepient

## 1. How the project maps to the six-layer model

The architecture-setup skill prescribes six responsibilities. Here's how Seepient's `src/` maps:

| Canonical Layer | Seepient Equivalent | Resides In | Fit |
|---|---|---|---|
| **UI** | CLI TUI + REPL, SDK public API surface, Server HTTP/WS | `src/adapters/{cli,sdk,server}/` | Merged with Transport |
| **Transport** | Commander.js args, HTTP routes, WS upgrades, auth, dotenv | Same adapters | Merged with UI |
| **Domain** | agent-loop, tool-executor, provider-resolver, hooks, middleware | `src/core/` | ✅ Clean separation |
| **Capabilities** | Tools, Skills, Gateway (MCP targets, tool proxy) | `src/tools/`, `src/skills/`, `src/gateway/` | Mixed: tools → skills dependency exists |
| **Vendors** | OpenAI SDK, Anthropic SDK | `src/providers/` | Not quarantined — providers are "infrastructure" alongside tools |
| **Foundations** | types.ts, errors.ts, settings, session-store, hashline | `src/core/` (mixed with Domain) | No dedicated layer |

**Key observation:** Seepient runs on a 3-tier model (Adapters → Core → Infrastructure) rather than six layers. This is a deliberate simplification — the project has ~15k lines, not 100k. The architecture-setup skill explicitly says to right-size. Three tiers is defensible.

## 2. Dependency flow analysis

### Clean flows (verified by import analysis)
- **Adapters → Core** — all three import from `../../core/` ✅
- **Adapters → Providers** — LLMProvider type only ✅
- **Core → Providers** — correct downward dependency ✅
- **Core → Tools** — correct ✅
- **Gateway → Core** — gateway depends on core (correct direction) ✅
- **Providers → Tools** — ToolDefinition type imports only ✅

### Layer violations found

| Severity | File | Violation |
|---|---|---|
| 🔴 CRITICAL | `src/core/middleware/semantic-tools.ts` | Core imports directly from Gateway (`../../gateway/gateway.js`, `../../gateway/semantic-scorer.js`). This is a wrong-direction dependency — Gateway is a capability that should be wired *through* core by an adapter, not pulled *into* core's middleware. |
| 🟡 MODERATE | `src/tools/index.ts` | The `use_skill` tool imports from `../skills/` (registry, types). Tools and Skills should be siblings or tools→core only. |
| 🟡 MODERATE | `src/core/skill-invoker.ts` | Core module imports from `../skills/` (args, types, resolver). Invocation orchestration shouldn't live in core — it's adapter-level coordination. |
| 🟢 MINOR | `src/providers/types.ts` → `src/core/types.ts` | Circular type re-export: core defines `ProviderType`, providers re-exports it, core sometimes imports from providers. Type-only, no runtime risk. |

### The semantic-tools middleware is the real problem

```ts
// src/core/middleware/semantic-tools.ts — WRONG DIRECTION
import type { MCPGateway } from '../../gateway/gateway.js';
import { scoreRelevance } from '../../gateway/semantic-scorer.js';
```

Core should not know about gateways. The fix: move this middleware to the adapters layer (each adapter wires it into the pipeline), or invert control so gateway registers a middleware factory that core calls generically.

### No `utils/` catch-alls

Zero `utils` directories exist in the project. Good.

## 3. Enforcement tooling assessment

The architecture-setup skill is unambiguous: "Architecture without enforcement is a suggestion."

| What the skill requires | What Seepient has |
|---|---|
| Boundary lint rules (ESLint `no-restricted-imports`) | ❌ None |
| Vendor SDK quarantine rule | ❌ None |
| File-naming convention enforcement | ❌ None |
| Supply-chain guard `minimumReleaseAge` | ❌ None |
| Supply-chain guard `onlyBuiltDependencies` (root) | ❌ None (docs sub-package has it but root doesn't) |
| Boundary violation test script | ❌ None |
| CI JSX leakage guard | ✅ One grep-based check — React/JSX must stay out of headless build outputs |

**Summary:** One manual grep assertion in CI is the only boundary enforcement. The architecture is purely convention-based — agents and humans can freely import across any boundary without tooling catching it.

## 4. AGENTS.md assessment: does it give correct instructions?

### What AGENTS.md does well

1. **Clear 3-tier model** — Adapters → Core → Infrastructure. Well-documented with a key files table.
2. **Single implementation centerpiece** — `runAgentLoop` as the one execution engine. Excellent architectural discipline.
3. **Known Gaps section** — 12 items, all marked FIXED. Shows healthy refactoring discipline.
4. **Convention documentation** — TypeScript, testing, error patterns, dynamic imports all documented.
5. **The dual-graph context policy** — ensures agents explore files systematically.

### What AGENTS.md is missing (per architecture-setup skill)

| Missing | Why it matters |
|---|---|
| **No "where does new code go?" guide** | The architecture-setup template includes a decision table. AGENTS.md has a key files table but no rule: "if you're adding a new tool, put it in X; if you're adding a new check, put it in Y." Agents guess. |
| **No explicit import rules for agents** | AGENTS.md says adapters delegate to core, but doesn't say "do not import gateway from core" or "do not import vendor SDKs outside providers." The semantic-tools violation exists because no rule prevented it. |
| **No vendor quarantine instruction** | Providers use OpenAI/Anthropic SDKs but nothing tells agents "never import `openai` or `@anthropic-ai/sdk` outside `src/providers/`." |
| **No mention of enforcement tooling** | AGENTS.md describes what the architecture *should be*, not what agents must verify. The architecture-setup skill says "make violations impossible, not discouraged." |
| **No worked request flow** | The template includes a walkthrough of one request through all layers. AGENTS.md jumps straight to the key files table. |
| **Skills/tools relationship unclear** | The `use_skill` tool creates a tools→skills import. AGENTS.md lists both under "Infrastructure" but doesn't clarify the dependency relationship — so agents don't know where the boundary is. |
| **No `ARCHITECTURE.md` exists** | The skill requires root-level `ARCHITECTURE.md`. It's absent — architecture documentation lives only in AGENTS.md (which is agent instructions, not architecture docs). |

### Specific AGENTS.md instructions that contradict the skill

| AGENTS.md says | Skill says | Issue |
|---|---|---|
| "Adapters (CLI, SDK, Server) → Core → Infrastructure" | Six layers: UI → Transport → Domain → Capabilities → Vendors | Adapters merge UI+Transport. Providers (vendors) are lumped with tools/skills (capabilities). Not wrong at this scale, but the skill would split these. |
| Tools, Skills, Providers are all "Infrastructure" | Vendors must be quarantined, separate from Capabilities | Providers (vendor SDKs) live alongside tools (capabilities) — no quarantine. |
| Gateway is listed in key files but not in the layer diagram | Gateway should be a Capability, not something core imports | The layer diagram omits gateway entirely, yet core imports it. |

## 5. Verdict

**Architecture quality:** The *design* is sound — a clean 3-tier model with a single agent loop, proper adapter separation, and no utils/ grab-bags. The semantic-tools gateway import is the one real violation.

**Architecture safety:** Weak. Zero automated enforcement means the architecture is aspirational. Any agent or engineer can add a cross-layer import without failing any check. The only guardrail (JSX in headless) catches one specific pattern.

**AGENTS.md quality:** Good as a reference document, weak as an agent guardrail. It describes the architecture but doesn't encode the rules agents need to follow. It omits: import boundary rules, vendor quarantine, "where new code goes," and enforcement expectations.

## 6. Recommended actions (if you want to fix gaps)

### Quick wins (under an hour)

1. **Add `ARCHITECTURE.md`** at the project root from the `templates/ARCHITECTURE.md` baseline. Fill in Seepient's 3-tier model (right-sized from six), the dependency rules, and the "where new code goes" table.

2. **Fix the semantic-tools middleware** — move `semantic-tools.ts` from `src/core/middleware/` to `src/adapters/` (e.g., a shared `src/adapters/middleware/` directory that each adapter opts into). Core should expose a generic `injectTools` hook that the adapter middleware calls, not import gateway directly.

3. **Add import rules to AGENTS.md** — a small section: "When writing new code: never import from gateway/ into core/, never import vendor SDKs outside providers/, never import adapters/ upward."

### Full enforcement (the complete architecture-setup workflow)

4. **Add ESLint flat config** with `no-restricted-imports` rules adapted from `references/enforcement-configs.md` — layer boundaries for the 3-tier model, vendor SDK quarantine on providers SDKs.

5. **Add pnpm supply-chain guards** — `minimumReleaseAge: 10080` and `onlyBuiltDependencies` in root `pnpm-workspace.yaml`.

6. **Add file-naming enforcement** — kebab-case for all `src/` files.

7. **Add boundary verification script** from `scripts/verify-boundaries.sh`.

8. **Update AGENTS.md** to reference `ARCHITECTURE.md` as the source of truth, and add an enforcement section telling agents: "these rules are automated, not aspirational — violations fail CI."
