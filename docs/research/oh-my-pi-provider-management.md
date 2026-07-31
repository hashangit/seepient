# Oh-My-Pi (omp) — Provider Management & TUI: Deep Analysis Report

## Executive Summary

Oh-my-pi implements a **role-based multi-provider architecture** with 40+ provider backends, hundreds of model entries, and a custom-built Rust-native TUI that does NOT use React/Ink. Its provider management is spread across three packages — `@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-ai`, and `@oh-my-pi/pi-coding-agent` — and its TUI is a hand-rolled differential renderer in `@oh-my-pi/pi-tui` written in ~8,000 lines of pure TypeScript.

---

## 1. Package Architecture

### 1.1 `@oh-my-pi/pi-catalog` — The Provider & Model Database

The catalog package is the single source of truth for every model's identity, capabilities, pricing, and API compat. Key modules:

| Module | Purpose |
|--------|---------|
| `types.ts` | Core `Model`/`ModelSpec`/`Api`/`Provider` types, `ThinkingConfig`, compat enums for every API dialect |
| `models.ts` + `models.json` | 12,000+ bundled model entries keyed by provider, lazy-loaded via `buildModel()` |
| `model-manager.ts` | Resolution pipeline: static → models.dev → cache → dynamic, with fingerprint-based cold-start fast path |
| `provider-models/descriptors.ts` | `CATALOG_PROVIDERS` — 50+ entries mapping provider ID → default model, env vars, model manager options, OAuth support |
| `provider-models/openai-compat.ts` | Per-provider OpenAI-compatible configs for 30+ openai-completions-based providers |
| `provider-models/google.ts`, `ollama.ts`, `special.ts` | Non-OpenAI provider descriptors (Google, Ollama, Cursor, Devin, GitLab, Z.AI) |
| `discovery/` | Runtime model discovery — dynamically fetches live model lists from provider endpoints (Cursor, Codex, Gemini, Devin, GitLab Duo, Antigravity, openai-compatible) |
| `effort.ts` | 5-tier thinking effort enum: `minimal` / `low` / `medium` / `high` / `xhigh` |
| `identity/` | Model family classifiers — detects whether a model ID belongs to Claude, GPT, Gemini, Kimi, DeepSeek families |
| `build.ts` | `buildModel()` — materializes a `ModelSpec` (sparse compat) into a fully resolved `Model` with `compat` record |
| `variant-collapse.ts` | Collapses thinking-effort variants (e.g., one upstream model → several catalog entries with different thinking configs) |
| `model-cache.ts` | SQLite-backed model cache with fingerprint invalidation |

**Key types:**

```typescript
type KnownProvider = "openai" | "anthropic" | "google" | "xai" | "groq" | /* ... 47 more ... */;

type KnownApi = "openai-completions" | "openai-responses" | "anthropic-messages" 
  | "google-generative-ai" | "bedrock-converse-stream" | "cursor-agent" | /* ... */;

interface Model<TApi extends Api> {
  id: string;                    // Local model ID
  requestModelId?: string;      // What to send on the wire
  name: string;                  // Display name
  api: TApi;                    // Protocol: openai-completions, anthropic-messages, etc.
  provider: Provider;           // Provider slug
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input, output, cacheRead, cacheWrite };  // $/million tokens
  contextWindow: number | null;
  maxTokens: number | null;
  thinking?: ThinkingConfig;    // Per-model thinking capability metadata
  compat: CompatOf<TApi>;       // Fully-resolved compatibility record
  // ... dozens more fields for routing, compaction, streaming, etc.
}
```

### 1.2 `@oh-my-pi/pi-ai` — The LLM Client

Handles auth (API keys + OAuth), streaming dispatch, and the per-provider request builders. Re-imports `KnownProvider` from `pi-catalog` to type-check its auth registry.

### 1.3 `@oh-my-pi/pi-agent-core` — Agent Runtime

The state machine that manages sessions, tool calling, compaction, and the turn loop.

### 1.4 `@oh-my-pi/pi-coding-agent` — CLI & SDK

The user-facing entry points. Houses slash commands, the model selector, provider setup, settings, the config system, and the full TUI application.

### 1.5 `@oh-my-pi/pi-tui` — The Terminal UI Engine

A purpose-built differential rendering engine — NOT React/Ink. Key facts:
- ~8,000 lines of pure TypeScript in `tui.ts`
- Append-only render contract: rows committed to native scrollback are immutable
- Component interface with `render(width)`, `handleInput(data)`, `invalidate()`
- Built-in components: `ScrollView`, `SelectList`, `Editor`, `Markdown`, `Image`, `Loader`, etc.
- Native scrollback live region seam: components report which rows are "final" vs "streaming"
- Hardware cursor management for IME support
- Overlay system with 11 anchor positions, percentage/absolute sizing
- Fullscreen overlays that borrow the terminal's alternate screen buffer
- Kitty/Sixel image protocol support with budget-based image demotion
- DEC 2026 synchronized output for flicker-free paints
- ConPTY truncation for massive transcripts on Windows
- Component-scoped render optimization: spinner/blink rates don't re-compose the full transcript

---

## 2. Provider & Model Selection TUI

### 2.1 Entry Points

Three ways to reach model selection:

| Path | UI |
|------|-----|
| `/model` or `/models` slash command | Opens the model selector overlay |
| `/switch` slash command | Opens the model selector in "temporary only" mode |
| `Ctrl+P` → type "model" → Enter | Command palette fuzzy-filters to "model" and opens the same overlay |
| `/setup` or `/setup providers` | Opens the provider setup overlay (different from model selector) |

### 2.2 Model Selector

The model selector is a `SelectList` overlay rendered by `runtime.ctx.showModelSelector()`. It:

1. **Groups models by provider** — displays a provider header (e.g., "anthropic") the first time
2. **Shows ✓ for the currently active model**
3. **Uses ▶ blue highlight for the selected row**
4. **Windowed to visible items with a scrollbar**
5. **Fuzzy-filters** when the list is larger than the visible window
6. **↑/↓ navigates, Enter confirms, Esc cancels**

The underlying `SelectList` component from `pi-tui` supports:
- `SelectItem` objects with `value`, `label`, `description`, `hint`
- Theme customization (selected prefix, selected text, description color, scrollbar)
- Description wrapping onto continuation rows
- Primary column width constraints (min/max)
- Custom truncation via `truncatePrimary()` callback
- Mouse routing via SGR extended mouse events
- Keyboard: up/down/pageUp/pageDown/cancel/confirm/search
- `onSelect` and `onSelectionChange` callbacks

### 2.3 Provider Setup

The `/setup providers` slash command opens a provider setup overlay that:
- Lists all configured providers
- Shows authentication status (API key set, OAuth logged in, not configured)
- Offers "Sign in" buttons for OAuth providers
- Links to the settings overlay for API key configuration

### 2.4 Settings Editor

The settings editor (`/settings`) exposes all provider configuration:
- **Providers & Models** category with: API keys (masked secrets), model selection, base URLs for openai-compatible, provider type selector
- Three editing modes: browse (list), select (boolean/enum with ←/→ cycling), input (string/number/secret)
- Restart indicators: model changes = instant; API key/provider changes = requires restart

---

## 3. Role-Based Model Routing (Capability-Based)

This is the **most distinctive feature** of oh-my-pi's provider system. Unlike Seepient's single-model-per-session approach, omp uses **role-based routing**:

### 3.1 Role Slots

Five named roles, each with its own model assignment:

| Role | Purpose | CLI Flag |
|------|---------|----------|
| `default` | Normal conversation turns | (default) |
| `smol` | Cheap subagent fan-out | `--smol` |
| `slow` | Deep reasoning tasks | `--slow` |
| `plan` | Plan mode | `--plan` |
| `commit` | Commit message generation | `--commit` |

Each role is its own column in the configuration — you assign a different model (and provider) to each role.

### 3.2 How It Works

From the README: *"Roles route work by intent. `default` for normal turns. `smol` for cheap subagent fan-out. `slow` for deep reasoning. `plan` for plan mode. `commit` for changelogs. Override at launch with `--smol`, `--slow`, or `--plan`; cycle through the configured models for the active role with `Ctrl+P`."*

The TUI model selector is **role-aware** — when you open it, it shows the models available for the currently active role (Default, Smol, Slow, Plan, or Commit). The selector title reflects the role you're editing.

### 3.3 Fallback Chains

Per-role chains under `retry.fallbackChains` in the config. When the primary provider throws a 429 or hits a quota wall, the next entry takes the rest of the turn — the primary is restored once its cooldown expires.

### 3.4 Path-Scoped Models

`enabledModels` and `disabledProviders` can be scoped to a `path:` prefix, pinning different model sets on one repository without touching the global config. Example:

```yaml
enabledModels:
  - path: "~/work/big-monorepo"
    models: ["claude-opus-4-8", "claude-sonnet-4-6"]
  - path: "~/work/small-scripts"
    models: ["gpt-5.5-mini", "claude-haiku-4-5"]
```

---

## 4. The Model Resolution Pipeline

### 4.1 Source Precedence

```
Static (models.json) → models.dev (community catalog) → Cache (SQLite) → Dynamic (provider API)
```

Later sources override earlier ones by model ID. Cache is fingerprinted against the static catalog slice so model list changes invalidate stale cache.

### 4.2 Cold-Start Fast Path

When the cache is fresh, authoritative, AND the static catalog fingerprint matches, the cache row IS the definitive merge result — skipping the 800ms rebuild completely. This is a critical performance optimization.

### 4.3 Dynamic Discovery

Each provider can supply a `fetchDynamicModels()` function that queries the provider's API endpoint for the live model list. Providers that support this: Anthropic, OpenAI, Google, xAI, Cursor, Devin, GitLab Duo, Ollama, vLLM, LM Studio, and several more. Providers with `dynamicModelsAuthoritative: true` prune static-only entries when the dynamic fetch succeeds.

### 4.4 OAuth Integration

Providers can declare `oauthProvider` in their catalog entry. The `/login` slash command handles the OAuth flow (browser redirect or manual paste). OAuth-token-bearing providers are flagged in the model selector UI.

---

## 5. The Advisor — A Second Model, Watching Every Turn

This deserves special mention because it directly addresses **capability-based model selection**:

- The **advisor** is a second model that reviews every turn the main agent takes
- It runs on its OWN context and OWN model (configured separately)
- It injects notes inline: concerns, suggestions, or hard blockers
- `/advisor configure` opens an interactive editor for configuring the advisor's model and behavior
- The advisor's transcript is persisted like a subagent for usage attribution

This is a **pair programming** pattern: you use an expensive model for the doer and a different model for the reviewer.

---

## 6. Key Configuration Knobs

### 6.1 `~/.omp/agent/models.yml`

The central configuration file. Supports:
- Custom provider declarations (any API that speaks one of the 14 supported protocols)
- Per-role model assignments
- Fallback chains with cooldown restoration
- Path-scoped model sets
- Round-robin credential stacks with per-credential backoff

### 6.2 Round-Robin Credentials

Stack API keys per provider; the runtime rotates with session affinity and per-credential backoff. Useful when one key would burn its quota by lunch.

### 6.3 Custom Providers

Declare any OpenAI-compatible, Anthropic-compatible, Google, or Bedrock endpoint in the YAML config. No code changes needed.

---

## 7. TUI Architecture (Deep Dive)

### 7.1 Render Engine

The `TUI` class in `pi-tui` is a custom differential renderer:

- **Append-only contract**: rows committed to native scrollback are immutable by contract
- **Component interface**: `render(width) → readonly string[]`, `handleInput(data)`, `invalidate()`
- **Container**: composes children, memoizes on reference equality
- **Overlays**: render on top of base content with anchor/percentage/margin positioning
- **Fullscreen overlays**: borrow the terminal's alternate screen buffer (vim/less style)
- **Hardware cursor**: tracked for IME candidate window positioning
- **Image budget**: caps live inline images, demotes old ones to text
- **Kitty/Sixel**: supports both image protocols with autodetection

### 7.2 Frame Pipeline

1. **Compose**: walk the component tree, collecting rows and seam reports
2. **Audit**: check committed prefix hasn't been re-laid out (detect mutations)
3. **Classify**: full paint (gesture/resize/replace) vs update (diff)
4. **Prepare**: normalize rows, fit to width, cache prepared lines
5. **Emit**: scroll-append, in-window diff, or seam rewrite

### 7.3 Component-Scoped Rendering

The `requestComponentRender(component)` API lets components (spinners, blink cursors) schedule cheap re-renders that only re-compose the affected root subtrees. The full transcript tree is NOT walked for animation-rate updates.

### 7.4 SelectList Component

The `SelectList` is the core selection component used for model picking, command palette, session selector, and more. Features:
- Fuzzy filtering with per-item search text (label + value + description + hint)
- Windowed rendering with scrollbar
- Description wrapping onto continuation rows
- Primary column auto-sizing with min/max constraints
- Custom truncation callbacks
- Mouse support (hover highlighting, click-to-select, scroll wheel)
- Keyboard navigation with wrap-around

---

## 8. Comparison with Seepient

| Feature | Seepient | Oh-My-Pi |
|---------|----------|----------|
| TUI framework | React/Ink | Custom differential renderer (~8K LOC) |
| Provider count | 4 (openai, anthropic, glm, openai-compat) | 47+ |
| Model selection | Single global model per session | Role-based: 5 roles, each with distinct model |
| Model catalog | Hand-written enum in `models-catalog.ts` | 12,000+ entries in `models.json` + dynamic discovery |
| API compat layer | Basic provider-specific classes | 14 API dialects, per-model compat resolution |
| Thinking config | Not surfaced to users | 5 effort tiers, per-model transport mapping |
| Fallback chains | None | Per-role chains with cooldown restoration |
| Path-scoped config | None | `path:` prefix pins models per repository |
| Round-robin keys | None | Session-affinity rotation with per-key backoff |
| Advisor/second model | None | Separate model reviews every turn |
| Model selector UX | Overlay with provider groups, ↑/↓/Enter | Same pattern, plus role-awareness and fuzzy search |
| Settings UI | Type-aware editor (browse/select/input) | YAML-based config + slash commands |
| Cold-start perf | N/A | Fingerprint-based cache fast path |

---

## 9. Files Worth Studying

If implementing a provider management system, these are the key files to review:

| File | What it does |
|------|--------------|
| `packages/catalog/src/types.ts` | The `Model` type and all compat/thinking types |
| `packages/catalog/src/models.ts` | Lazy-loaded model registry, cost calculation |
| `packages/catalog/src/model-manager.ts` | Resolution pipeline with cache fingerprinting |
| `packages/catalog/src/provider-models/descriptors.ts` | The master provider catalog table (50+ entries) |
| `packages/catalog/src/build.ts` | `buildModel()` — resolves sparse compat → full model |
| `packages/catalog/src/effort.ts` | Thinking effort enum |
| `packages/catalog/src/discovery/` | Dynamic model discovery per provider |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | `/model`, `/setup`, `/fast`, `/advisor` commands |
| `packages/tui/src/tui.ts` | The full TUI render engine |
| `packages/tui/src/components/select-list.ts` | The selection component |
| `packages/coding-agent/src/config.ts` | Multi-directory config discovery (.omp, .claude, .codex, .gemini) |

---

## 10. Key Design Decisions (Takeaways)

1. **Role-based routing is the primary mechanism for capability-specific model assignment.** Rather than asking "which model for coding vs chat," they ask "which model for default vs cheap subagent vs deep reasoning vs planning vs commits."

2. **The catalog is split into a static JSON bundle + dynamic discovery** — the bundle provides instant startup, discovery fills gaps.

3. **Compat is a first-class type**, not ad-hoc flags. Every model carries a fully-resolved compat record materialized once by `buildModel()`, so request handlers never detect or resolve at runtime.

4. **The TUI is hand-rolled for performance** — no React reconciliation cost, native scrollback integration, component-scoped partial re-renders.

5. **The advisor is the closest thing to "capability-based model selection"** — it's a second model running on a separate context, reviewing the main agent's output. This is a pair-programming pattern that could be extended to specialized models for specific capabilities.

6. **Configuration is YAML-based, not a database** — `models.yml` is human-editable and can express custom providers, fallback chains, and path-scoped rules.

7. **The model selector is role-aware** — it changes its context based on which role slot you're editing, but the interaction pattern (list with ↑/↓/Enter in an overlay) remains consistent.

---

## Source

Repository: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)  
Analysis date: 2026-07-04  
Version: v16.3.5
