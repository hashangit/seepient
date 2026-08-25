## [0.5.0] - 2026-08-25

**Seepient v0.5.0** is a major product and architectural release introducing the **Provider Management TUI & In-App Lifecycle Experience (Spec 013)**, bringing together the modern runtime foundation from Spec 010 into a cohesive, interactive terminal experience.

This milestone introduces the **shared ModelPicker** with search-as-you-type and reachability gating, the **rebuilt ModelManager dock (`/models`)** with an interactive Purpose × Tier jobs board and full in-app account management, an **interactive Setup Wizard (`seepient setup`)** drawing live from the community catalog with zero settings data-loss, **native OAuth provider sign-in** for subscription accounts (Claude Pro/Max, OpenAI Codex, GitHub Copilot, OpenRouter, Kimi, xAI), and complete **cross-surface parity** across the CLI, HTTP server, WebSocket, and SDK.

---

### 🔧 What's New

#### 1. Shared ModelPicker & Searchable Model Browser (Spec 013 M2)
* **Search-as-you-Type**: Fast, synchronous filtering over ~1,267 models from the live community catalog by provider, model name, or connected account.
* **Provider-Grouped Windowed Rendering**: Clean, low-flicker list display designed for responsive keyboard navigation.
* **Reachability Gating**: Models from unconnected providers are visually dimmed with a direct `[1] Connect provider` action; toggle reachable-only models with `[3] Reachable only`.
* **Reasoning / Thinking Effort Sub-Mode**: Select model-supported thinking effort levels (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) without manual configuration.
* **Session-Only Model Switching**: Quickly try a model for the current conversation with `[2] Try for this session` without modifying saved job assignments.
* **Live Pricing & Context Badges**: Per-row input/output pricing per million tokens and context window size.

#### 2. Rebuilt ModelManager Dock (`/models`) (Spec 013 M2/M4)
* **Purpose × Tier Jobs Board**: Visual staffing board covering language purposes (`text`, `plan`, `coding`, `vision`, `commit`) across `standard`, `complex`, and `efficient` tiers, plus single-slot media purposes (`media.image`, `media.speech`, `media.transcription`, `media.video`).
* **Transparent Fallback Chains**: Unconfigured slots display their active fallback path (`standard` → `efficient` → `complex` → unconfigured).
* **Capability Mismatch Detection**: Flags mismatched assignments (e.g. assigning a text-only model to a vision job) with immediate actionable alerts.
* **In-App Provider Account Lifecycle**: Add accounts (paste key, env var reference, keyless endpoint, or OAuth sign-in), delete accounts with slot-impact warnings, test connectivity with live probes, and refresh custom endpoint models directly within the TUI.
* **Live Turn Status**: Dedicated status tab showing active model, thinking level, session switch state, and token cost breakdown.

#### 3. Modernized First-Run Setup Wizard (`seepient setup`) (Spec 013 M3)
* **Catalog-Native Onboarding**: Direct access to dozens of upstream providers from the community catalog (OpenAI, Anthropic, Google Gemini, xAI, OpenRouter, Mistral, DeepSeek, Ollama, etc.) with zero hardcoded provider menus.
* **Multi-Mode Credential Configuration**: Setup accounts via pasted API keys, environment variable references, keyless local endpoints, or official provider OAuth sign-in.
* **Real Main Model Assignment**: Search and assign the default main model (`text.standard`) with real pricing and context metrics—no discarded inputs.
* **Safe Settings Persistence**: Rebuilt "Extras" step (SMTP email, Tavily search, notification webhooks) powered by `SettingsManager.set()`, completely eliminating settings clobber bugs.
* **Smart Re-run Logic**: Automatically skips satisfied steps when re-running setup.

#### 4. Provider Sign-in via OAuth Subsystem (Spec 013 M5)
* **Subscription Login without API Keys**: Official provider sign-in for Anthropic Claude Pro/Max, OpenAI Codex, GitHub Copilot, OpenRouter, Kimi, xAI, and Radius.
* **Dual Flow Support**: Automatic browser authorization with local callback server or in-terminal device code flow with manual URL fallback.
* **Seamless Token Rotation**: Background token refresh managed through the serialized credential store without user intervention.
* **Strict Security & Redaction**: OAuth tokens are stored strictly as `oauth` records in the system keychain/credential store; zero token material is ever written to configuration files, UI state, logs, or error traces.
* **Composer Commands**: Quick sign-in and sign-out directly from chat via `/login [provider]` and `/logout [account]`.

#### 5. ProviderManagerApi Controller & Cross-Surface Parity (Spec 013 M6)
* **Single Semantic Core**: `ProviderManagerApi` controller powers TUI, CLI, Server, WebSocket, and SDK with uniform validation, OCC revision guards, SSRF protection, and error mapping.
* **CLI Power**: New and modernized CLI commands:
  - `seepient models browse [query] [--json] [--reachable-only]`
  - `seepient models resolve <purpose.tier> [--json]`
  - `seepient models set`, `fallback`, `status`, `probe`, `discover`
  - `seepient providers add/edit/remove/list`
  - `seepient auth login/logout/issue-token`
* **REST & WebSocket Parity**: Scoped endpoints for reachability-aware catalog listings (`GET /v1/models/catalog`) and server-side OAuth sign-in relay (`POST /v1/providers/{id}/oauth/start|complete`).
* **SDK v2 Instance Methods**: Full programmatic provider management on `Seepient` instances (`addProvider`, `removeProvider`, `setAssignment`, `clearAssignment`, `resolve`, `getCatalog`).
* **Golden Parity Testing**: 100% test-backed semantic equivalence across all four interfaces.

#### 6. New Bundled Agent Skills
* **`how`**: Step-by-step system operation and process exploration skill with critic, explainer, and explorer prompts.
* **`why`**: Deep root-cause investigation skill backed by formal epistemics and multi-source playbooks for Datadog, Sentry, Linear, Notion, Databricks, Slack, and Code Archaeology.
* **`repo-review-ultra-deep` & `repo-review-ultra-deep-lite`**: Evidence-backed repository and PR architecture and security audits.
* **`unslop`**: Writing optimization skill to cut AI tells and improve readability.

#### 7. Greenfield Demolition & Zero Legacy Baggage
* Demolished dead `model-selector.tsx`, legacy `handleModelsCommand`, `defaultModelMap`, and stale purpose literals.
* Extended `no-legacy-imports` regression test suite to strictly prohibit legacy provider structures or deprecated model identifiers in `src/`.

---

### 🚀 How This Improves Your Experience

| Area | Before (v0.4.4) | Now (v0.5.0) | Why It Matters |
| :--- | :--- | :--- | :--- |
| **Setup Wizard** | Hardcoded 4-provider checkbox; wiped settings on exit | Live searchable catalog, multi-credential entry, zero data-loss | Connect any provider in under 60 seconds with 100% config safety |
| **Model Selection** | Blind cycling list with no search or pricing | Search-as-you-type ModelPicker with prices, context, & reasoning levels | Find and assign the exact model you need in seconds |
| **Provider Accounts** | Read-only TUI tab pointing to terminal commands | Full in-app account management (Add, Delete, Probe, Refresh) | Manage all API keys and local endpoints without leaving the app |
| **Subscription Login** | Manual API key creation & paste only | "Sign in with provider" (OAuth device code & browser auth) | Use Claude Pro/Max or Copilot subscriptions without generating API keys |
| **Surface Parity** | Disparate commands and behaviors across CLI/Server/SDK | Single `ProviderManagerApi` semantic core across all 4 surfaces | Same vocabulary, same reachability, and same outcomes everywhere |
| **Temporary Testing** | Overwrote saved assignments to test a model | "Try for this session" temporary switch | Explore models freely without losing your tuned job assignments |

---

### 🚀 Upgrade

| How you installed | Action |
| :--- | :--- |
| npm | `npm install -g seepient@latest` |
| Homebrew | `brew upgrade seepient` |
| pnpm | `pnpm add -g seepient` |
