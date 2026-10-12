# Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. In-Place Upgrades & No Legacy Baggage

**Upgrade directly. Do not preserve obsolete paths.**

- When modifying or iterating on a feature, rewrite and replace existing functions, components, and contracts directly in place rather than appending alternate implementations, `V2` suffixes, parallel helpers, or wrapper shims.
- Do not keep backward compatibility shims, fallback branches, or deprecated functions unless explicitly instructed.
- When an updated approach replaces an older mechanism, delete the legacy code paths, obsolete flags, and unused options immediately in the same change.

## 6. Zero Tolerance for Dead Code & Bloat

**Leave no orphans or obsolete baggage.**

- Always remove unused imports, dead variables, obsolete handlers, orphaned types, and unreachable conditionals before completing an edit.
- Clean up tests, fixtures, or mock data that tested obsolete code paths.
- Apply dead-code detection discipline (e.g. `knip`, `ts-prune`) to ensure no unused exports, orphan files, or dangling dependencies remain.

## 7. The Greenfield Rewrite Pattern

**Prefer complete, clean replacement over additive patchworks.**

- When significantly updating or refactoring a feature, avoid stacking incremental condition checks, flags, or wrapper shims on top of legacy code (which creates brittle, additive patchworks).
- Treat significant iterations as a clean-slate replacement of the component/module: write the new streamlined implementation, replace the old code in place, and wire the callers directly.

## 8. Pre-1.0 / Beta Lifecycle & Breaking Changes

**Rapid improvement phase — no legacy shims before v1.0.0.**

- **Pre-1.0 (Beta state)**: Seepient currently has no production consumers requiring backward compatibility guarantees. Do not add compatibility shims, fallback adapters, or deprecation wrappers during the pre-1.0 phase. Upgrade callers and consumers immediately to the new pattern.
- **Documenting Breaking Changes**: When introducing breaking changes that require consumers of Seepient to update their code or configuration, document the changes with explicit transition/migration instructions. Consumers should always adapt to the new version rather than relying on legacy fallbacks.
- **Post-1.0 Stability**: Once Seepient reaches its first stable release (`v1.0.0+`), transition to a standard deprecation policy (e.g. deprecation warning with backward compatibility retained for one minor version release before removal). Until then, bias entirely toward clean, unburdened, in-place upgrades.

## 9. Multi-Tenant Safety & The Dual Operational Profile

**Isolation is guaranteed by construction, ambient leakage is structurally impossible, and quality gates actively test like an attacker.**

### 9.1 The Dual Operational Profile
Seepient operates under two distinct profiles selected at surface composition roots:
- **Profile A: Local Operator (Single-User)**: Designed for local CLI, TUI, and quick developer automation scripts. Ambient configuration (`~/.seepient/setting.json`), local `.agents/skills`, host `process.env`, and disk-backed ledgers are permitted convenience features. Identity defaults to implicit sentinels (`cli-user`, `default`).
- **Profile B: Isolated Runner (Multi-Tenant & Hosted)**: Mandatory for REST/WS servers, multi-tenant SDK instances, and serverless / container workers. All ambient host dotfiles and `process.env` lookups are physically decoupled. State, credentials, and runtime must be explicitly injected.

### 9.2 Zero Ambient Fallback in Hosted Runtimes
Never write fallback logic that queries `process.env` or `~/.seepient` when an injected parameter or secret is omitted in multi-tenant mode:
- If a tenant tool requires a secret and the tenant did not supply it, fail closed with `CREDENTIAL_REQUIRED` or `TENANCY_AMBIENT_IO`.
- Never resolve host operator API keys (e.g. `TAVILY_API_KEY`, `SMTP_PASS`) for a tenant execution turn.
- Default to in-memory replay ledgers (`InMemoryReplayLedger`) in Profile B to prevent host disk writes and lock contention.

### 9.3 Parse at Ingestion, Don't Validate at Storage
Never pass unvalidated strings for tenant identities or session identifiers across boundaries:
- Ingestion parsers at the SDK, HTTP, and WebSocket edges must parse inputs into branded, slug-validated types: `TenantPrincipalId` matching `/^[a-zA-Z0-9_-]{1,128}$/` and `SessionId` matching `/^[a-zA-Z0-9_:-]{1,256}$/`.
- Sentinels (`default`, `anonymous`, `sdk-user`) must be rejected case-insensitively in multi-tenant mode.
- Deep storage layers (`LocalAuditStore`, `PersistedCapabilityLedger`) must accept only pre-validated types to ensure path traversal (`../../`) is structurally impossible.

### 9.4 No Flat Maps on Shared Surfaces
Server surfaces hosting concurrent callers must never maintain un-namespaced global state tables:
- Index in-memory and persistent collections by composite keys `(tenantScope, resourceId)`.
- In session managers, the lookup key is structurally `apiKeyHash:sessionId`.
- Foreign key probes must return standard 404 responses rather than leaking resource existence via 409 conflict errors.

### 9.5 Red-Team Test Discipline
Every multi-tenant boundary feature must be accompanied by an automated adversarial regression test in CI:
- Test secret exfiltration: verify that host `process.env` secrets are never forwarded in tenant outbound calls.
- Test sandbox escape: verify that directory traversal payloads in identity parameters are rejected at the edge.
- Test noisy neighbors: verify that concurrent tenants generate zero writes under `$HOME/.seepient` and zero file-lock contention.
- Test session isolation: verify that session IDs cannot be squatted or probed across distinct API keys.

## 10. Talk to Me Like a Human & Use Unslop Always

**Speak like a person, not a language model. Explain things the way you would to a human engineer.**

- **You are talking to a human, not an AI.** The user is a person, not a language model. Never explain things as if prompting, instructing, or briefing another model.
- **Plain, direct explanations.** Explain concepts, technical tradeoffs, and status the way one engineer explains them to another in the room. Ground explanations in concrete facts and code reality.Also include the product perspective.
- **Use the `unslop` skill always.** Apply `unslop` across every conversational response, technical explanation, commit message, pull request description, and release note without exception.
- **Honest voice and readable rhythm.** Have a point of view, keep sentences readable, and say what happened or what needs doing without corporate or assistant theater. Do not write unnecessarily long text. Only as needed to clearly explain your point and the background of it so the human can understand what you are trying to say.

## 11. Release Gate — Nobody Grades Their Own Exam

No work order ships on its own say-so. Between "all tasks ticked" and push/release, the `/release-gate` skill (`.agents/skills/release-gate/SKILL.md`) must run and produce a PASS receipt in `Reviews/` before the release commit lands. Binding rules:

- **The implementer agent never runs the gate on its own work**, and every reviewer runs in a fresh session that has not seen the implementer's reasoning. Every claim is graded against the committed HEAD (`git show`), never the working tree — uncommitted fixes do not exist.
- **Task truth is checked, not trusted**: every `[x]` in the shipping work order is graded TRUE/PARTIAL/FALSE against the seal. Any FALSE row blocks the release — the release may not claim what is not true. This rule exists because fifteen consecutive review passes (see `Reviews/2026-09-12` through `2026-10-01`) found false checkboxes in every work order, always clustered in the claims/pins tasks nobody re-verified before push.
- The reviewer fleet (Red Team with demonstrations-not-worries, Code Reviewer reading code not summaries, Scrutinizer walking the product as a user, Repo Auditor reading across, Architect attacking the premise) and the deterministic verdict rules (confirmed P0/P1 → FAIL; unresolvable conflict → BLOCKED, yellow stops the line; max two repair attempts then the owner) are defined in the skill's mandate cards.
- Deterministic gates (suite, probes, examples, build, CI) always run first and are recorded by the gate, never self-reported by the implementer.

# Documentation Storage

Documentation is split between the **Obsidian vault** (internal) and the **project repo** (consumer-facing). When unsure where a document belongs, default to the vault.

## Obsidian vault — internal documentation

All internal engineering and management documentation lives in the Obsidian vault under `Seepient/` (`~/Documents/Obsidian/Seepient/`), **not** in the project repo. This includes:

- Planning & architecture (e.g. `Architecture/`)
- Implementation specs & feature specs (e.g. `Implementation-Specs/007-tui-parity-upgrade/`)
- Research, data models, API/contract definitions
- Management documents (roadmaps, strategy, decisions, lessons learned)

**Access:** Read and write vault files directly via their filesystem paths (e.g. `Read` / `Write` / `Edit` on `~/Documents/Obsidian/Seepient/...`). The `obsidian` CLI only launches the GUI app and is not scriptable from agents — use direct filesystem access for all vault work.

## Vault structure

Current layout of the Obsidian vault (annotated):

```
~/Documents/Obsidian/Seepient/
├── README.md                         # Vault overview / index
├── Architecture/                     # Cross-cutting architectural references
│   └── security-posture.md           # AUTHORITATIVE security charter (owner-adopted 2026-09-24; v1.1 product re-alignment): §0 product ground (autonomous multi-purpose agent, outcome statements, autonomy ladder — consent is the bridge, the ceiling is the law), burden rules R1–R5, parties table, profiles + architecture stance, threat actors, boundary inventory + extension trust model (MCP/tools/skills first-class), non-goals + actuation stance, availability stance, severity rubric, guard-surface integrity principle, industry mapping, open decisions OD-1..6, pass-10 ownership ledger — every security disposition is graded against this document
├── Reviews/                          # Product review reports
│   ├── 2026-09-06-product-review-017-to-021-4.md # 360° review of 017→021-4 (v0.5.3–v0.7.1): 7 P1s, no P0
│   ├── 2026-09-07-022-reaudit.md     # Spec 022 pre-implementation boundary re-audit evidence
│   ├── 2026-09-07-product-readiness-review-021-to-022.md # Readiness review of 021→022 (v0.8.0 staged @ 5f64583): 🔴 not ready; 21 P1s (docs truth rot, first-hour defaults, sdk-user collapse, WS crash); 4 root causes + pre-v0.8.0 fix list
│   ├── 2026-09-09-product-readiness-review-post-022-1.md # Post-022-1 verification (uncommitted tree @ 5f64583+): 🟡 ready with conditions; 7/11 original P1s closed, tenancy/crash/parity real; 5 remaining P1s (CI gate mispath, config.json myth, session-dir lie, fictional subcommands, consent table cell) + P2 security residuals (pre-017 reconciliation raw-read, covers() suppression)
│   ├── 2026-09-11-post-remediation-verification.md # Post-remediation spot verification (small follow-up to the 09-11 cut review)
│   ├── 2026-09-11-product-readiness-review-v0.8.0-cut.md # v0.8.0 cut assessment (4 deep dives + live CI/build/boot evidence): 🔴 not ready to cut; prior 5 P1s all closed but deeper pass found multi-tenant server composing ambient operator skills/stores (guards live in SDK wrappers, not Domain constructors), doc lie families alive on unscanned pages (sessions-and-state.md fiction, providers-add flags, *_MODEL envs, types.md defaults), first-hour dead ends (README WS .text/.delta, Docker invocations, persist resume, consentMode-less flagship examples), and release-train blockers (127 files uncommitted/unpushed, pnpm 12-vs-11 pin conflict breaks CI on commit, pnpm audit red on main, 6 CHANGELOG gaps); ~3-4 day path to green
│   ├── 2026-09-12-adversarial-multi-tenant-sdk-review.md # Adversarial multi-tenant SDK review, FIVE merged layers @ 0b7fe4e: 🔴 REJECT for multi-tenant hosting; 5 P0-class (VULN-1 ambient host-secret use/exhaustion via execution brokers — exfil needs custom/connector tools; SDK-only, server effect-free; VULN-2 principalId path traversal via injected local stores; VULN-9 default server boot on operator ambient runtime in hardcoded "multi"; VULN-10 presence-vs-composition validation — new ProviderRuntime() trap; VULN-16 pass-4: pi-ai ambient auth fallback on the INFERENCE path — kind:"none"/missing secret → apiKey undefined → vendored library resolves host process.env keys, tenant-set baseUrl converts to Bearer-key exfiltration, defeats even clean injected runtimes) + P1s (composite credential read-through, cwd read-root + shared server policy file, sentinel check wrapper-only, gateway audit/usage cross-principal at agent:read, multi-tenant.md contradictions, session squatting DoS, VULN-17 pass-4: operator gateway tool defs default-on in every tenant's model context on the server, VULN-18 gateway stdio spawn w/ full host process.env + model-callable gateway_register_target arbitrary command — also single-user sandbox escape, VULN-19 reference worker control plane unauthenticated + tenant-unscoped — example contradicts its own README isolation claim) + P2s (policy/ledger stale-lock crash wedges w/ fix pattern already in-repo, per-request buildActionLifecycle global audit scan O(all tenants), tenant tools-object injection unvalidated at both chat edges, MCP SSE + refreshModels SSRF bypasses, floating approval-store promises crash embedder process, server skill sources process-wide shared) + ~30 P2/P3 total; diagnosis converged across all five passes: Domain tenancy is real, everything below/beside it composes ambient operator state — pass 4 shows it reaching INSIDE the vendored inference library; pass 5 (2026-09-13, §11) is a blind independent re-derivation that converged on the full corrected P0 set + P2 register (record stable) and added: Dim 8 zero-write test is VACUOUS for VULN-5 (runs askSeepient("Hello") with no tools — EffectBroker.execute() never fires; fix must extend the gate w/ a brokered tool call), InMemoryReplayLedger does NOT exist in the tree (fix must create it; effect-broker.ts:146 comment falsely claims in-memory fallback), remediation shapes (isIsolated stamp + createIsolatedProviderRuntime factory, explicit operator-runtime opt-in flag, TENANCY_WORKSPACE_REQUIRED); §8.4a + §10.8 list 12 unowned work items (execution-boundary tenancy, replay-ledger injection, principalId charset, session namespacing, isolated-runtime stamp, workspace contract, inference ambient auth, gateway multi-mode composition, worker control-plane auth, stale-lock recovery + unhandledRejection guard, reconciliation off hot path, tools edge validation) — fold into 024/024-2 or 022-2 before cutting v0.8.0; permission plane, prompt/context plane (pass 4), concurrency guards, and input-validation plane strong and test-pinned; ~4-5 days to conditional-ready
│   └── 2026-09-13-multi-tenant-remediation-plan.md # Adjudicated remediation plan for the 09-12 review (OpenFusion 4-candidate panel + judge over the verified register, cross-checked in-session; product-review framing): D1 fix shape = INVERT construction defaults (no-arg ProviderRuntime/stores isolated in-memory by default; ambient only via createAmbientProviderRuntime() at Profile A roots; stamp kept as backstop; VULN-16 additionally needs wrapper CREDENTIAL_REQUIRED + baseUrl egress capability + image-path credential store — never patch node_modules); D2 RC0 = tenancy as readonly constructor-stamped property, Domain refuses CONSTRUCTION not operation, two typed context constructors make wrong composition unrepresentable (module-level context rejected); D3 release = HOLD v0.8.0 until P0 closure (~5 days, parallel w/ 09-11 train fixes) w/ day-6 fallback = cut single-tenant-labeled + multi flagged experimental; never ship P0s w/ multi claims (label doesn't remove VULN-9/16 on the server binary or VULN-1 on SDK embedders); D4 vehicle = one focused spec 022-2 owning unowned items 1-7+12 (phases 0-4, ~5 days elapsed), item 8 gateway rides 024 amendment, item 9 worker same-branch, items 10-11 to existing owners w/ 2-hour pull-forward contingency; D5 blind spots = type-level tenancy constructors, physical ambient/isolated export split + CredentialResolver vendor-trust boundary + import lint, server effect-free boundary as CI-tested invariant; D6 = 11 red-first adversarial journeys + anti-vacuum discipline (journey-completeness rule, zero-hit security tests fail CI, no-red-no-merge); §3 lists 5 panel corrections (VULN-1 server reachability overstated, V14/V15 phase mis-assignment, V9 boot semantics fixed to isolated-empty-runtime + boot notice + typed per-request failure, dtruss→fs instrumentation, call-site count unverified); OQ-1..4 owner questions (release authority, standalone server operator channel, export-split timing, green-light 022-2 creation)
│   ├── 2026-09-13-post-022-2-adversarial-verification.md # Post-022-2 three-lens adversarial verification (uncommitted tree @ 0b7fe4e+), WITH same-day one-by-one verification pass over every finding: 🔴 NOT ready for multi claims, ~1 day to close; P0-1 = VULN-16 fix implemented but never armed (tenancyMode never threaded into inference opts — agent-loop.ts:590/media.ts:118 — host-env Bearer exfil via tenant baseUrl still exploitable through runAgentLoop on all surfaces; wrapper-level tests prove the branch works when armed, not that it is) — CONFIRMED verbatim; P0-2 = worker stub-app.ts:115 auto-adopts any Bearer token as principal, AMPLIFIED: POST /api/sessions :253, /api/audit :118, /api/policy :176 also take principalId from the REQUEST BODY (token re-binding — unguessable tokens alone won't fix; derive principal exclusively from the token); P1s (all confirmed) = server root never validates injected runtime stamp nor defaults in-memory stores (ambient LocalAuditStore cwd + LocalPolicyStore ~/.seepient while hardcoding multi), SEEPIENT_UNCONTAINED ungated in multi, gateway opt-in channel unguarded in multi (VULN-17/18 re-exposure), tenant secretResolver unimplemented (fail-closed dead end; buildLocalBoundary has no secretResolver option while EffectBroker accepts one), anti-vacuity harness self-fulfilling in 8/10 guard-using journeys (recordHit never in production seams), J1/J7 layer-skip composition seam, stale docs (getDefaultProviderRuntime still documented as default; multi-tenant.md table mismaps); corrections from the verification pass = auth.baseUrl egress bypass RESCOPED P1→P2-12 (vendor credential shapes carry no baseUrl field; derivation only via provider toAuth/resolve, blocked in armed multi), P2-10 TENANCY_AMBIENT_IO-unpinned sub-claim REFUTED (pinned by two suites), egress port-check wording fixed (scheme-default bypass), LocalAuditStore file ref corrected (audit-recorder.ts), seeded network-destination wildcard noted as satisfying the egress assert for any https baseUrl once P0-1 armed; VULN-1/2/9/10 closures + sessions/tools-edge/CI gates verified solid by attack; no cross-lens duplicate findings (lenses partitioned by layer)
│   ├── 2026-09-13-post-022-3-adversarial-review.md # Pass-6 review of the implemented 022-3 tree (five lenses + lead re-verification + live worker probe; suite 2054 green): 🔴 NOT ready for multi claims — overturns the 022-3 closure appendix's self-graded 🟢; P0-1 arming GENUINELY CLOSED (verified end-to-end on every multi surface incl. WS/SSE, media/optimize, all four vendor wrappers, public-entry journey with zero-outbound-fetch assert); P0-W1 = worker stub-app.ts:92-99 mints issued-token-<principalId> for ANY principal unauthenticated + deterministic (probe-confirmed full cross-tenant R/W/D — P0-2 closure voided; forged-token journey never mints first); P1-A = SDK action-lifecycle.ts:478/:534 policy re-read drops tenancy opts → one honest "always allow" launders workspace-global caps (write-root *) into the tenant envelope permanently (stub GET :140 serves principal snapshots unfiltered); P1-B = stamp regime hole one layer down — tenancy-mode.ts:186-187 sub-stores still === false while permission stores got !== true, and exported unstamped MemoryCredentialStore resolves env refs from live process.env into api_key secrets that ALSO pass the armed VULN-16 wrapper (two lenses converged independently); P1-C = closure-evidence overclaims (anti-vacuity 6/8 not 8/8 — isolated-defaults + gateway-default-off still self-record; mutation-probe matrix has no artifact; SC-003 has no brokered tool call; tenant-secret guard never asserted); P1-D/E/F/G = worker authority class (policy CAS open KV self-authorize, tenancyMode from query string, ScopedSessionMap suffix poisoning of victim model context, skills cross-tenant R/W); P1-H = gateway VULN-17/18 residues live (storage-only guard, tool defs default-on in tenant context, stdio spawn full host env — owned 024); 13-entry P2 register (composite stamp constructible lie, CREDENTIAL_REQUIRED missing on SMTP/webhook, unbounded in-memory stores OOM, DurableApprovalStore ambient ~/.seepient boot mkdir, shared provider plane pooling OQ, SSE/refreshModels SSRF, 017 approvable-wildcard ceiling × armed egress assert, KNOWN_TOKENS CHANGELOG fiction) + P3s; ~2 days to 🟡; OQ-A..D (worker issuance design, server provider-plane model, ceiling narrowing, worker ships-as-is?)
│   └── 2026-09-13-post-pass-6-remediation-adversarial-review.md # Pass-7 review of the post-pass-6 remediation round (29 files touched ~2h after pass-6; 3 surviving lens agents + lead first-hand verification; suite 2061 green, test:probes 8/8): 🟡 SDK core conditionally sound / 🔴 "fully multi-tenant" label still not earned — for the FIRST time in seven passes the engine held under attack (every pass-6 SDK-side P0/P1 genuinely closed: P0-W1 minting admin-gated+UUID, P1-A readOpts threaded, P1-B sub-store !==true + MemoryCredentialStore env fail-closed, P1-D/E/F/G worker authority, P2-1/2/4 fixed, journeys conditionally-recorded, mutation-probe artifact exists); blockers now at the edges: NEW-1 P1 multi server serves host operator's ambient ~/.seepient settings to agent:read tenant keys incl. env-var origin inventory (http/index.ts:386-396 + settings-handlers.ts:104); NEW-2 P1(example) pre-auth JSON.parse crash = unauthenticated 1-packet control-plane kill (stub-app.ts:93); NEW-3 P2(P1 shared-store) the P1-A fix itself introduced CAS erasure — principal-filtered re-read feeds full-replace compareAndSet so a persistent approval silently erases other principals' grants in the same snapshot (action-lifecycle.ts:549/:570; reachable via single-mode global workspace CLI vs SDK; factory reconciliation :290-311 has the correct raw-read merge pattern); NEW-4 P1(example) /api/caps cross-principal global read+revoke (probe: B killed A's run; guessable sessionIds); NEW-5 P1(example) minting fix bypassed twice — KNOWN_TOKENS ships 5 committed always-valid tokens + adminSecret falls back to hardcoded "dev-admin-secret" that README itself prints; NEW-6 P2(example) global audit idempotency dedupe silently drops cross-tenant events; NEW-7 P2 default-on 15 built-in tool defs in tenant model context when tools omitted (VULN-17 class for built-ins; execution still denied); NEW-8 P2 MemoryPersistenceBackend suffix-match fallback (P1-F's twin) alive in SDK core session-store.ts:196-204; NEW-9 P2 credentials/providers injection doesn't signal multi (tenants ride ambient single pipeline); NEW-10 P2 unbounded per-session message accumulation; P3 register (settings scope gaps, ?token= query auth, WS no revocation disconnect, cli-user vs sdk-user grant fragmentation, server-root guard weaker than domain validator, keychain null-as-any residual, SC-003 still no brokered call); ~1.5-2 days to defensible label (worker authority round + settings plane + CAS merge-back + tools/credentials defaults); owner items stay disclosed: gateway 024, provider plane OQ-B, ceiling OQ-C, unbounded stores 023/025; OQ-A' demo-vs-reference for the worker, OQ-E settings surface existence; SAME-NIGHT ADDENDUM (completeness sweep, 3 further lenses: execution internals, policy-engine/recovery/single-mode, exports/logging/docs-outside-gate): adds P1 CHANGELOG security fictions (LocalAuditStore/PolicyStore/PersistedCapabilityLedger no-arg are ambient isIsolated:false + SEEPIENT_SECURITY_DIR lookup, not "isolated in-memory"; TENANCY_EDGE_VALIDATION_FAILED nonexistent; CredentialRequiredError/seepient-types export fictions), P1 root README flagship multi-tenant example cannot construct (PrincipalRequiredError-first; README outside docs/ gate), P1 single-mode principal fragmentation regression (CLI cli-user stamps + SDK sdk-user reads → filtered-empty version>0 snapshot treated as stored policy → bare askSeepient loses fresh-install read-root/model-egress → deterministic approval-unavailable in CLI-touched workspaces; factory:261-265/:428-435, transport-unpinned), P2 generate_image image_path sensitivity hardcoded "normal" (in-workspace .env uploads under normal data class; analyzers.ts:905-911), P2 ledger revocation unreachable in production, P2 engine stamps decorative (intersect drops principalId), P2 multi-tenant.md trustedHostTool example doesn't compile + migration.md missing 3 breaking changes + README WS text_delta silent no-op, P3s (read/process executors skip envelope, unwarned ambient exports settings/registerBackend/initializeSkillRegistry, dist/ fully shipped, log vectors); execution plane structure VERIFIED SOLID (per-agent boundary construction, mandatory sandbox in multi w/ env allowlist + home hard-denies, SSRF pin chain, artifact/replay scoping), logging/audit discipline solid, recovery honors 021 contract; RECONCILED with concurrent pass-8: accepted its WS-auth apiKeysFile split as P0-class (websocket.ts:105 + ws-handlers.ts:54 bare authMiddleware vs REST ctx.apiKeysFile → ambient ~/.seepient/server-keys.json on the WS plane), corrected own P1-D grade (worker CAS network-wildcard check is dead code — tests destination/domain fields that don't exist on {scheme,host,port}), accepted mutation-probe script as weaker than graded (npm script, not in CI); OQ-F unify cli-user/sdk-user?, OQ-G revocation surface or delete
│   ├── 2026-09-13-multi-tenant-adversarial-review-pass-8.md # Pass-8 review of the SAME tree as pass-7 (six independent lenses + lead re-verification, ran concurrently with pass-7; suite 2061 green): 🔴 NOT ready for multi claims — converges with pass-7 on the core register (worker crash/CAS erasure/caps/minting bypass/audit dedupe/default-on tool defs) and ADDS: P0-1 = WS auth plane ignores injected apiKeysFile — websocket.ts:105 + ws-handlers.ts:54 call authMiddleware(req) bare while REST passes ctx.apiKeysFile (rest.ts:275); getKeyPath(undefined) → ambient ~/.seepient/server-keys.json (auth.ts:38); live-probed both directions (ambient key → 101 full access incl. admin update_settings; injected key → 401) — the ambient-operator-state-composes-hosted-surface class surviving on the AUTH plane (standalone CLI covered by env, SDK embedders using the documented option exposed); P1-1 = persistent approval CAS writes back from the FILTERED one-principal view (action-lifecycle.ts:549 nextCapabilities from principal-filtered retried; both stores take next verbatim) → one honest "always allow" durably wipes every other principal's grants incl. the shared GLOBAL store (live multi probe; factory reconciliation :288-311 has the correct raw-read merge shape); P1-5 = worker CAS wildcard ceiling is dead code (checks destination/domain fields that don't exist on {scheme,host}; external-recipient/process/model-egress unchecked; root:"/" bypass) and self-CASed wildcards sit within the default deployment ceiling → effective without approval (probe: covers process /bin/rm -rf); P1-7 claims-truth family (zero-cwd-writes false — one curl with sessionId writes cwd/.seepient/sessions, index.ts:371; "tools string-only" false at SDK edge + TENANCY_EDGE_VALIDATION_FAILED exists nowhere; CredentialRequiredError NOT exported + seepient/types subpath doesn't exist in package.json; README flagship worker example throws PRINCIPAL_REQUIRED verbatim; migration.md teaches fictional createIsolatedProviderRuntime({credentials}) — TS2353); P1-8 = scripts/verify-mutation-probes.ts is vacuous theater (never mutates/runs its PROBE_TARGETS, tests that a counter counts; not in CI) + SC-003 still sends no tools/sessionId so both writers stay cold; P2 register: SMTP broker egress completely unvalidated (nodemailer to resolver-supplied host, probe ECONNREFUSED 127.0.0.1:1 — internal port-scan oracle, one-branch fix via validateEndpointUrl), inference egress shares the tool network-destination namespace, unbounded in-memory stores, DurableApprovalStore class default still disk + void-persist floats + tenantId-ignoring casSync/get, session-store.ts:196-204 suffix fallback (pass-7 NEW-8, verified), settings map at agent:read (pass-7 NEW-1, verified), signal set misses provider-routing options (pass-7 NEW-9 verified as class), skills @path whitelists all of ~/.seepient; corrections to pass-7: CAS erasure is P1 not P2 (multi-mode GLOBAL-store probe), worker CAS "closed" is partial (ceiling dead code), mutation-probe "artifact exists" is vacuous; verified solid: VULN-16 arming re-attacked (12 producers, 34-case egress URL battery all fail-closed), P1-A laundering direction, P1-B stamps, P2-1 composite lie, worker P1-E/F/G, CREDENTIAL_REQUIRED on all four connector kinds, secret hygiene, session partition, journey de-vacuuming genuine; ~2-2.5 days to 🟡; OQ-E (gate global/project lifetimes in multi?), OQ-F (fix session-cwd default or fix the zero-write claim); FOLLOW-UP SWEEP (§Follow-up, blind-spot POVs): F-S1 P1 media-input final-symlink exfil (analyzers.ts:101-111 keeps symlink path, sensitivity hardcoded "normal" :905-911, media.ts:107 raw readFileSync → /etc/passwd bytes base64'd to vendor, probe-confirmed multi+balanced; write side fenced, input side open), F-S2 P1 same laundering on read_file (classifier inspects link name analyzers.ts:141-159, executor follows link executors.ts:232 → ~/.ssh/id_rsa into model context, probe-confirmed), F-S3 P1 createSeepient({credentials,providers}) rides SINGLE mode (seepient.ts:191-212 builds runtime internally so runtimeInjected stays false; providers/credentials/overlayFile/adapter/modelAssignments are not signals at :152-156 → sdk-user sentinel + ambient broker-secret resolution + 017 grants firing) and provider-management.md:155 teaches it under "strict multi-tenant isolation" (VULN-1-class re-exposure via documented pattern), F-S4 P0-1 re-probed independently + amplification (WS update_settings needs only admin scope settings-handlers.ts:294, persists to cwd/.seepient/setting.json or ~/.seepient/setting.json settings-manager.ts:199 → ambient key persists operator-config mutations; CHANGELOG P2-3 bullet advertises exactly the broken apiKeysFile decoupling), F-S5 P2 session files 0755/0644 plaintext shared dir (audit/policy correctly 0700/0600 — session store is the outlier), F-S6 P2 media relative-path authorized-vs-executed divergence (workspace root vs process.cwd()), F-S7 P3 PATCH /v1/settings malformed JSON → 500 + latent rest-gateway.ts:68 ambient-auth copy; SUPPLY CHAIN: pi-ai 0.84.4→0.85.1 SAFE (full dist diff from pnpm store — auth/egress/compat seams byte-identical; lockfile fully accounted; pnpm audit clean) but positive-path VULN-16 mechanism trusted-not-pinned (add real-vendored wire-header journey before v0.8.0); clean: no SSE endpoint, artifacts store content-addressed in-memory, REST/WS JSON robustness passes, marketing pages claim nothing, Profile A gated by profile-a-smoke, TenancyStoreIncompleteError + runtime factories really exported; PASS-7 ADDENDUM CROSS-CHECK: CHANGELOG no-arg inversion bullet fiction for 3-of-4 named classes (LocalAuditStore/LocalPolicyStore/PersistedCapabilityLedger no-arg isIsolated=Boolean(opts?.root)=false + ambient ~/.seepient/security dirs; only InMemory* stamped true — verified directly, 6th item of P1-7 family; runtime-plane inversion verdict stands), single-mode principal fragmentation P1 verified by code read (factory:262-266 version>0 filtered snapshot skips baselines; CLI cli-user agent.ts:309 vs SDK sdk-user seepient.ts:216 → deterministic denials in CLI-touched workspaces); report at Reviews/2026-09-13-multi-tenant-adversarial-review-pass-8.md
│   ├── 2026-09-13-post-pass-8-verification.md # Post-pass 8 adversarial verification & closure: 🟢 READY; all P0-1/F-S4 (WS injected apiKeysFile), P1-1/P1-2 (approval CAS unfiltered merge + global lifetime gate), P1-3..P1-6 (worker authority & scoping batch), F-S1/S2/S6 (symlink exfiltration on read/media), F-S5 (session file permissions 0700/0600), P1-7 (claims truth & exports), P2-1 (SMTP SSRF check), NEW-8/P2-12 (session exact match), and P1-8/SC-003 (anti-vacuity mutation probes & zero-write server) closed and verified by automated tests; suite 286 files / 2073 tests green, worker 20/20 green, probes 8/8 verified, pack verified 683 files. (Pass-9 note: its §9 P1-8 claim is overclaimed — the probe script still never mutates a guard.)
│   ├── 2026-09-20-post-022-3-round2-adversarial-review.md # Pass-9 review of the committed tree @ 2f005f9 (022-2 + 022-3 R1+R2 + pass-8 remediation; 5 lenses + lead first-hand verification; suite 291 files / 2088 tests green, probes 8/8, worker 20/20): 🟡 NOT 🟢 — the multi-tenant ENGINE held under the heaviest attack yet (five passes converged: WS/REST key-file threading, CAS merge-back, global gate, worker authority live-probe battery, settings allowlist, tools default-off incl. group expansion, session exact-match + 0700/0600, revocation scoping, static symlink class, supply chain all verified solid); blockers: P1-1 read-side TOCTOU (executors.ts:226-272 lstat → await-import yield → default-flags readFile, no O_NOFOLLOW/fd-pin/expected-enforcement; media.ts same; amplifed by VACUOUS output classifier agent-loop.ts:147-151 that never reads `output` — substring-checks args.path; exploitable via background alternation racer from an approved shell loop; Profile A most exposed), P1-2 hardlink exfiltration undetected (no st_nlink check; static, race-free), P1-3 first-hour doc dead ends (migration.md teaches nonexistent MemoryCredentialStore ctor ×3 sites + env `variable` field + cli-user sentinel fiction; session-persistence.md EVERY example throws PRINCIPAL_REQUIRED via persist-signal upgrade; provider-management.md example same trap; ask-seepient.md multi example missing cwd → TENANCY_WORKSPACE_REQUIRED; deployment.md teaches env keys for a providerless-by-default standalone binary — no operator flag exists), P1-4 mutation-probe CI step still toothless (greps + guard self-test, never mutates/runs; two lenses converged; the 🟢 verification §9 overclaimed it), P1-5 zero end-to-end single-user coverage (roundtrip test is domain-seam with same principal both instances; profile-a-smoke is construction-shape only); P2 register: CAS merge DUPLICATES unstamped caps in single mode (both buckets; 2^k growth → digest/parse fail = permanent policy deny on pre-022 workspaces), multi erases unstamped silently + comment lies ("preserve unstamped"), stub CAS fail-open default (unknown kinds + activate-change-class passes), cli-user/sdk-user fragmentation persists (probed), symlink refusal no allowlist/docs/resolved-path-in-remediation, global lifetime OFFERED in multi then denied with misleading invalid-approval-response, seepient/types export-vs-docs-ban contradiction, SMTP rebinding window + webhook error echo oracle, credentials-signal Object.keys fragility (#private-field stores undetected); P3 register + OQ-I (standalone server provider channel), OQ-F carried, OQ-H (seepient/types); ~1 day to defensible 🟢 (read-plane fd-pinning + honest classifier, docs batch w/ docs-examples extension to the five pages, one-bucket unstamped fix, probe-claim descope, one true surface journey)
│   ├── 2026-09-24-post-022-4-adversarial-review.md # Pass-10 review of the post-022-4 tree @ 2820f12 (R3 remediation LANDED same day — see 022-4 tasks.md Phase 14; identity pin closes P1-1, probes now mutate production seams, provider channel built) (5 lenses + lead first-hand verification incl. empirical PoC; origin CI all four jobs green at HEAD): 🟡 engine sound, read-plane closure HALF-delivered — P1-1 parent-directory symlink swap between analysis-time realpath authorization and execute-time open-by-path defeats the whole authorize-what-you-open plane (O_NOFOLLOW is final-component-only; PoC-confirmed host-bytes exfil through the exact executor logic on read_file + media inputs; no parent-swap test exists; swap-racer journey is sequential final-component-only); P1-2 the advertised fstat dev+ino verification DOES NOT EXIST anywhere on the read plane (commit message + T031 [x] over-claim; only the Rust WRITE helper does dev+ino); P1-3 mutation probes round 3: executable + CI-wired but neutralize only the journey's own hit-counter (guard.ts recordHit; zero NEUTRALIZE seams in production) + any non-zero exit incl. spawn-ENOENT counts as verified-red + no green baseline + no timeout + the entire R2 register (symlink/hardlink/lifetimes/CAS journeys) sits outside the matrix; SC-003 denial assertion is [502,500,400]+never-failing toBeDefined and the stale LocalPolicyStore comment T018 claimed deleted survives; P1-4 docs traps survive where gates don't scan: README:361 + create-seepient.md ×5 bare-persist examples throw PRINCIPAL_REQUIRED (loadBearingPages page import-checked only), deployment.md:194 swapped env-keys fiction for a NEW .seepient/setting.json fiction (isolated runtime never reads it; provider API restart-ephemeral; no operator flag — OQ-I papered over); P1-5 #private-field CredentialStore defeats the Object.keys multi-upgrade signal (silent single mode → ambient skills/secrets/audit/policy; pin test passes by TS-private accident); P2 register (WS zero egress backpressure, worker plain-Error 409 kills CAS retry, win32 O_NOFOLLOW silently dropped, unpinned oldContent read, CHANGELOG buildNeedsApproval fiction, LLM_PROVIDER regex blind spot, semantic-tools re-adds gateway defs after tools gate [024-owned, verified live], ambient server-keys.json default, @path ~/.seepient startsWith whitelist, GlobalLifetimeForbiddenError skips terminal audit, migration.md missing R2 sections, error classes unexported, PATH_ESCAPES oracle, hardlink text lie) + P3s; confirmed solid: final-component race + hardlink gate + ceiling mechanics + write plane + one-bucket CAS + lifetime choke point + sentinel + worker authority + exports + no prototype pollution/traversal/hijack; ~1–1.5 days to 🟢 (dirfd-walk or auth-time dev+ino pin, production-seam probe contract, docs batch, instance-probe signal)
│   ├── 2026-09-28-022-5-pre-implementation-red-team.md # Pre-implementation red team of the GREEN-LIT 022-5 artifacts vs actual tree @ eca55dd (4 lens agents + lead first-hand verification of every load-bearing claim incl. vendored pi-ai dist; no repo files modified): 🟡 NOT ready for /speckit-tasks as written — RE-BASELINE FIRST (~0.5d artifact work, impl drops to ~1–1.5d). Core event: 022-5 green-lit ~11:10 against 2820f12, then 533440c (022-4 R3, 17:39 same day) landed ~40% of its register under different names; artifacts never re-baselined. Overlap: FR-001/FR-002 closed by R3 (PATH_IDENTITY_MISMATCH shipped+exported vs spec's READ_IDENTITY_MISMATCH; carrier is operation.expected/imageIdentity vs spec's PreparedAction.readIdentity), FR-003 half-open (pinned read landed, ceiling re-auth missing), FR-008 half-landed (production seams + CI real; ZERO_HITS confound means 8/11 targets cannot detect an orphaned seam — guard.ts:16-19 reads the same env ungated), US2+US4 evidence verified accurate at HEAD. P1 register: stale branch-cut @ 2820f12 would miss R3 and re-open the closed P0; spec-as-written renames shipped public API; demolition misses the vendored pi-ai env fallback (compat.js:142-146 withEnvApiKey, 37 env names incl. GEMINI/ZAI/DEEPSEEK/etc., single-mode undefined pass-through at pi-language-raw.ts:119-123 — FR-007 not pinned tenancy-invariant, SC-002 unachievable as worded); kind:"none" makes FR-007 unsatisfiable (needs sentinel row); env credential is a LIVE product mode (CLI --credential env:, TUI add-account:271, REST accounts.ts:82, auth-cli --env-var) — FR-005 file list misses all of it → dead-end accounts; probe seam design conflict unadjudicated (green-lit D4 rejects env branches; R3 shipped NODE_ENV-gated test-seams.ts; worker stub-app.ts:213 forged-principal under NODE_ENV=test+var); FR-004 understates media openSync event-loop freeze (media.ts:127,:164); NEW live regression: CLI image variation/edit broken at HEAD (models-cli.ts:526 no identity → media.ts:137 unconditional throw). P2s: 3-vs-5 env names (OPENAI_COMPAT_* unlisted, range :480-517), migration surface under-scoped (AGENTS.md:534, bootstrap.ts:112 strings, 16 docs files, vocabulary gate lacks API-key bans, environment-policy.ts strip list must survive), authorize-time realpath→lstat micro-race + vacuous classifier as missing compensating control, trusted-host auto-allowlist footgun (agent-loop.ts:511-521), media denial laundering to MEDIA_GENERATION_FAILED, 8 orphan FRs w/o SCs, ~12-files estimate vs ~30 real. NOBODY items: ambient server-keys default, PATH_ESCAPES dangling-vs-existing remainder, pi-ai wire pin (tasks.md assigns to 022-5, no FR names it). OQ-1..6 (seam adopt-vs-convert, error-code vocab, single-mode demolition extent, env-mode removal, nobody-items, CLI hotfix vs fold-in); re-scope recipe in §5
│   ├── 2026-09-29-post-022-5-adversarial-review.md # Pass-11 review of the IMPLEMENTED 022-5 tree @ dd4a171 (5 lenses + CodeRabbit over the full diff + lead first-hand verification incl. runtime repro of both headline P1s and a base-worktree run dating the suite regression; probes 11/11 + worker 20/20 + tsc×2 verified green): 🟡 engine core conditionally sound / 🔴 multi-tenant label not earned; NO P0 — for the first time BOTH spec-bet planes held under attack (read-plane identity binding end-to-end on read_file+media incl. real parent-swap/racer/FIFO/hardlink probes; env-key demolition total — lens B live-proved the vendored stream() env fallback fires on undefined apiKey and every producer now sits on the sentinel/typed-throw side, single mode included). P1 register: P1-1 FR-013 regression kills the WS consent plane in multi — chat.ts:329 stamps records with principalId apiKeyHash while approvals.ts:187/:195 hardcode actorId "ws-user", the new casSync guard rejects every legitimate approval as "stale" and approvals.ts:163 resolves approve→false (lead runtime-proven with production shapes; tests blind because unauthenticated contexts default both sides to ws-user — no test joins authenticated principal + decision); P1-2 FR-016's own named threat survives — htmlToText tag-strip regex /<[^>]+>/g is quadratic on the capped input (measured 4×/doubling, 256KiB=24.9s, 1MiB≈400s event-loop freeze; read_website content is attacker-controlled → repeatable noisy-neighbor DoS on all co-tenant requests); P1-3 FIFO wedge class survives on the two surfaces FR-004 didn't name — commit-files old-content open (executors.ts:104 no O_NONBLOCK/isFile, executor _opts:69 discards abort) and edit_file section read (analyzers.ts:398, wedge at ANALYSIS time pre-approval; both probe-confirmed wedged); P1-4 FR-008d/e fiction — registration lints exist only in the script docblock + tasks.md + CHANGELOG:15 (COUNTER_ONLY_JOURNEYS is dead data; a bidirectional lint couldn't even pass — VULN-1-BROKER has no production seam), committed dogfood scenario absent, T004's pass10-red gate file NEVER EXISTED in git; P1-5 pin-scope overclaims — refreshModels has no tenancy threading/egress assert/recording despite T014 [x] (validateEndpointUrl only, console.error), FR-007 enumeration is a fixed 6-file comment-grep that cannot see a new unarmed producer, real-wire pin is sentinel-only/single-mode (resolved-key journey mocked, multi absent); P1-6 first-hour truth — ui/cli/index.ts:67 + setup.ts:36-38 still print the four demolished env names to headless first-run users (T017 1-of-3 true), multi-tenant.md:255 "single mode reads these variables directly" false, providers.md auto-detection heading, reference.md:80 teaches --credential env: (now exits 1), local-llm.md --base-url+missing --upstream dead command, provider-management.md isolated example throws CREDENTIAL_REQUIRED (F-S3 class reborn), providers-cli.ts:130 help advertises env:VAR_NAME, profile-a fixture absent; P1-7 release-gate truth — pnpm test RED at HEAD (4 unhandled DurableApprovalStore rejections from the new FR-013 test tripping pre-existing void persist()/resolveRequest() floats; absent at eca55dd per worktree run; SC-014 false), branch never pushed AND ci.yml:3-7 triggers exclude it (T030/T032 could not have run as checked), FR-009 corrects 4-of-6 claims while adding a fresh false one (the lints) + empty Security (022-5) section (US4 undocumented). P2 register: symlink-mediated dangling-vs-existing oracle falsifies SC-002's letter (analyzers.ts:37-41 fallback untouched — existing target → PATH_ESCAPES at analysis vs dangling → authorized-then-ELOOP downstream, 1-bit existence oracle incl. edit sections + generate_image), edit-section read has NO dev/ino pin (micro-race feeds host bytes into section.current → committed in-workspace content), casSync binding opt-in both sides (old records principalId-less; untyped actorId passes), media denials launder to MEDIA_GENERATION_FAILED (open outside try — ELOOP conversion dead code), FR-014 overreach kills Profile A uncontained backgrounded children (undocumented), stub accepts /data/../etc via unnormalized startsWith (inert downstream), SC-008/011/012 + FR-006/FR-007 pins entirely absent contradicting deviation #1, message pins match test NAMES not assertions (+ VULN-16 literal "A|B" marker matches only the title), warnIfTestEnvAtHostedBoot missing on runSeepientServer, vocabulary gate holes (.env.example invisible, case-sensitive, AGENTS.md unguarded), floating store promises crash-adjacent, commit-files old-content no identity pin vs commit.expected (metadata-only, wire verified clean), entity fromCodePoint RangeError blanks pages, stale fail-closed test titles. P3s incl. dead duplicate PendingApprovalStore (server-policy.ts:106-174, no principal binding — trap). tasks.md false [x]: T004/T014/T017(1-of-3)/T021/T028/T030/T032. Verified-solid: FR-010 key cache genuinely closed (cross-process real), FR-011 coverage layer probed 12 root shapes, probes' red mechanisms live-real, two-factor seam tenant-unreachable, VULN-16 arming intact. Refuted: CR's ask-seepient flag (page already corrected), lens worker-count drift (20/20 true), lens E's FR-003 "implemented" grade (falsified by symlink probe). ~1–1.5 days to label (WS actorId fix + joined test, anchored tag regex + wall-clock pin, O_NONBLOCK/isFile/signal on both remaining opens, real lints or honest descope + dogfood fixture + phantom-gate fix + floating-promise catch + push + CI triggers, refreshModels parity + source-scan enumeration + resolved-key wire single+multi, docs batch). OQ-1 actorId semantics (role labels vs principals — third fragmentation), OQ-2 uncontained kill intended?, OQ-3 lints implement-or-descope, OQ-4 CI branch triggers
│   ├── 2026-09-29-post-022-5-WO1-adversarial-review.md # Pass-12 review of the IMPLEMENTED 022-5-WO1 tree @ 721925b (4 lenses incl. fresh-eyes re-attack + supply-chain dist-diff + lead verification — re-ran both pass-11 P1 runtime repros and reproduced the new buffering P1 first-hand; gates exit 0 across the board, CI green on the branch): 🟡 engine held, pass-11 P1 register GENUINELY closed — WS approval repro now resolves true, htmlToText adversarial shapes ≤2ms at 1MiB, FIFO wedges closed, lints real and self-catching, pi-ai 0.87.1 auth seams byte-identical — but the label is still not earned on two NEW edge P1s: P1-1 unbounded response buffering BEFORE the size cap on the brokered network path (NodeNetworkAdapter.fetch passes no maxResponseBytes to pinnedFetch whose streaming abort is unarmed; 10MiB broker cap fires only after full buffering; lead-probe: 300MiB in 237ms, RSS 35→975MB, no rejection → tenant-approved read_website OOMs the shared process; the broker's own webhook path threads the cap — the adapter is the odd one out; fix one line); P1-2 refreshModels multi egress assert armed by NO production composition root (factories construct single-mode runtimes; tests hand-thread multi; chain: provider:admin key (grantable scope) PUTs attacker baseUrl w/ credential preserve onto the operator's providers-file account then refresh → operator's real Bearer key to attacker host, no EGRESS_REQUIRED; CHANGELOG claims the protection). P2 register: edit_file commits feed the new old-content identity pin nothing (expected={exists,size,sha256} only — pin requires device/inode; probe-proven raced bytes into oldContent, metadata-only blast), both new identity pins (commit old-content + edit-section) have ZERO tests, producer source-scan works but never asserted-empty (new unarmed producer ships undetected — the exact pass-11 P1-5b case), T020 dogfood is pure-function pins not a spawned matrix, AGENTS.md vocabulary guard vacuous (blanket continue skips every check while the docblock claims otherwise), SC-012 zero-of-four worker pins + unhandledRejection→500 unimplemented (carried from 022-5 T028), T036 verify describes a nonexistent test (fix itself live-proven correct across 8 payloads), media FIFO/symlink refusal codes still launder to MEDIA_GENERATION_FAILED (typed classes survive; plain-Error refusals don't). P3 register incl. duplicate tool_approval_response resolve-once race, overbroad _guard/probe-matrix lint exclusions, VULN-1-BROKER shared-condition, no google wire pin post-genai-major, CHANGELOG heading-dup artifact + env-note still nested, stray undici file, dead ci trigger branch. WO1 task-truth: 30 TRUE / 9 partial-false (T014 edit_file expected, T016 codes half, T020, T022/T023 arming, T024 scan gate, T030, T032 4/5, T036, T037) — no phantoms, every partial has real work behind it. ~0.5–1 day WO2 (buffering one-liner + OOM pin, factory arming + boot pin, edit_file snapshotPath + swap test, the missing pins, claims batch). OQ-1 arming style (factory vs per-request), OQ-2 is provider:admin tenant-grantable by intent?, OQ-3 vocabulary gate vs vault-map self-exemption
│   ├── 2026-09-29-post-022-5-WO2-adversarial-review.md # Pass-13 FINAL review of the WO2 tree @ 2c6faaa (3 lenses + lead verification — gates exit 0 first-hand [suite 2189/319, probes 11/11 w/ lints, worker 25/25, CI green], both pass-12 P1 repros re-run, every new claim double-verified): 🔴 label not yet — ONE composition line short; P1-1 buffering CLOSED (lead: 300MiB rejects in 11ms/RSS+21MB, under-cap 4MiB succeeds; framing-agnostic, all call sites capped) and the engine's twelve-pass register HELD under the final whole-tree sweep (read plane, credential demolition, consent plane, availability, probe self-enforcement re-attacked; accepted-risk list confirmed unchanged); BUT P1-1 the injected-runtime composition root skips the arming — runSeepientServer({runtime}) validates only isIsolated, never tenancyMode, createSeepient's own multi branch builds exactly the single-stamped shape, and lens-3 live-probed the full pass-12 exfil chain on the documented embed path (deployment.md:216): provider:admin → PUT attacker baseUrl+preserve → 200 → refresh → Bearer sk-operator-real to the attacker sink, no EGRESS_REQUIRED — third composition-root iteration of the same class, falsifies WO2 D2's "cannot plant at all"; P1-2 the arming broke the standalone operator channel — no operatorBaseline CLI/env/file channel exists, so every baseUrl-bearing account on --providers-file denies refresh/mutations with EGRESS_REQUIRED (two-lens live-probed; fail-closed; deployment.md teaches the flag and never mentions the baseline; no WO2 CHANGELOG section at all); P2s: WS set_provider plants ungranted baseUrl (REST-only write-assert; downstream catches it on ARMED boots only — fully open under P1-1), claims cluster in T017/T018 (env-key note NOT moved — diff is a blank line; dead CI trigger NOT dropped; sc-pins header NOT fixed; 13th consecutive pass with false [x] in the claims-truth work order), webhook denial echoes operator credential-bearing URLs into tenant-visible output; P3s incl. edit-section deletion pin vacuous (in-place write, same inode), google decoy spy makes a real outbound request every run, pi-canonical-converter exemption dead data. WO2 task-truth: 15 TRUE / 4 PARTIAL / 2 PARTIAL-FALSE / 1 FALSE pin (T011). ~0.5-day WO3 sketch §7 (multi-stamp requirement on injected runtimes + saveAccount-seam write-assert, derive-or-flag operator baseline, claims batch, redact webhook URL); label defensible-with-caveats after it, caveat list §8. OQ-1 derive baseline vs flag, OQ-2 stamp createSeepient's runtime by construction, OQ-3 delete the WS mutation surface instead
│   ├── 2026-10-01-post-022-5-WO3-adversarial-review.md # Pass-14 review of the IMPLEMENTED 022-5-WO3 tree @ 0ccd752 (6 lenses + CodeRabbit over the full WO3 diff + lead first-hand verification incl. runtime repros; gates exit 0 first-hand [suite 2197/322 zero-unhandled, probes 11/11 w/ mutation+markers, worker 25/25, build+tsc clean, CI 8/8 run 36752684367]; two inter-lens contradictions adjudicated by direct read): 🔴 label not yet — but the SHAPE changed: the server plane is genuinely closed (every composition root held under attack; T006 stamp check sound incl. forged-stamp-over-ambient-stores rejected; derive-at-boot covers refresh AND mutations; saveAccount one-seam real across REST+WS+CLI; operator channel works end-to-end) and the 13-pass engine register HELD on the compiled dist (read-plane guards all fire under production-shaped ESM loading incl. darwin case/NFD//dev/fd; credential demolition, consent plane, availability re-attacked); the blockers are 4 P1s, 2 of them WO3's own deliverables: P1-1 T005's section-read identity pin is DEAD IN EVERY SHIPPED RUNTIME — snapshot-store.ts:65 uses bare require('node:fs') in the ESM-only package, the ReferenceError is swallowed by its own catch, identityOf() returns null forever on dist/tsx while the vite-node shim arms it under vitest (5-way confirmed: lead dist probe, lens-B analyzer-level swap RESOLVES on dist vs 4/4 denied under vitest, CodeRabbit critical, lens-E tsx, lens-F dist; policy-engine.ts:55 documents the identical round-10 trap; bounded by the stale-anchor gate for different-content swaps; fix = thread the executor's verified fd identity into record()); P1-2 createSeepient multi SILENTLY ACCEPTS a single-stamped injected runtime and T007's stamp is DEAD CODE (tenancy-mode.ts:187 throws for multi-without-runtime BEFORE the bootstrap, so the stamped branch only runs in single; the multi check never validates tenancyMode) — lens-A live-probed the pass-13 exfil chain on the documented embed shape (multi-tenant.md:48): plant passes (assert no-ops), refresh delivers the stored key, and http/index.ts:265's refusal message + CHANGELOG:20 cite the dead "createSeepient stamps its own builds" mechanism; P1-3 OPENAI_BASE_URL env-DESTINATION exfil — the openai SDK's destructor default (client.js:140) arms on baseURL:undefined, both Seepient sites (openai-discovery-source.ts:29, openai-image-raw.ts:66) pass account.baseUrl verbatim, and the egress assert + SSRF gate only on acc.baseUrl, so a host env var redirects the stored key's traffic with zero checks (live-probed at SDK + source level; single mode not exempt); P1-4(example) worker body cap label-only — stub-app.ts:160 keeps buffering past 1MiB until stream end, pre-auth → unauthenticated OOM. P2 register: SDK multi has NO working arming channel (operatorBaseline threads only into the policy plane, seepient.ts:467; multi-tenant.md:229 added in WO3 teaches the inert grant — live-probed), T010 PARTIAL-FALSE (env-note NOT moved — empty heading artifact at CHANGELOG:39, note still :79; WO2 banner erratum never written; 14th consecutive pass), refreshModels denials echo the full stored baseUrl unredacted (T015's sibling), explicit operatorBaseline REPLACES derived grants (deployment.md's own combined example triggers it; boot notice mislabels), casSync sync-write doesn't survive disk mode (getDecision's load() wipes the decision pre-persist; pin passes by ENOENT accident; getDecision has zero production callers), one un-awaited WS dispatch (ws-handlers.ts:139), commit identity pin only on commits[0] + broker drops dev/ino at the helper boundary, T014 2-of-4 sub-claims false (indent, double EGRESS_REQUIRED). P3s incl. redactWebhookUrl malformed-URL fallback leak, https://*/v1 derives a live host:"*" grant, vocabulary-gate name coverage, T002 gate's absent refresh assertion + call-through spy, T006 plain Error not the typed class. WO3 task-truth: 11 TRUE / 4 PARTIAL (T002,T005,T006,T014) / 1 PARTIAL-FALSE (T010) / T007 true-as-written dead-as-meant; follow-ups 816f96a real-but-test-plane-only + unpinned, 14da0d5 + TUI fixes TRUE nothing weakened. Spec fidelity: FR-001..016 all IMPLEMENTED in substance with 3 gaps (FR-003's pin inert in the binary, Migration placement, D2 executed as dead code); SC-001..014 met; accepted-risk register unchanged. ~1-day WO4 sketch §8 (fd-threading + no-bare-require scan pin, SDK-plane stamp mirror + baseline threading + exfil journey, OPENAI_BASE_URL defaults + decoy pin, worker destroy-on-tooLarge, claims batch, redaction reuse, load() merge, await the dispatch); label defensible-with-caveats after. OQ-1 SDK refuse-vs-stamp, OQ-2 one-operatorBaseline-two-planes vs separate option, OQ-3 disk-mode approval stores fix-now-vs-defer
│   ├── 2026-10-01-post-022-5-WO4-adversarial-review.md # Pass-15 REVIEW-AND-FIX of the IMPLEMENTED 022-5-WO4 tree @ 976bd76 + remediation @ 78c0fb8 (5 lenses + lead verification — one lens rate-limited, its surface covered by the others + lead; both new P1s live-probed; the inverted merge reproduced by two methods pre-fix and pinned post-fix; gates at both SHAs re-run first-hand): WO4's four P1 closures GENUINE (fd-threaded identity fires under tsx OUTSIDE vitest; SDK refusal + baseline threading live-probed end-to-end incl. port-scoped grants; both openai baseURLs explicit; worker accumulation bounded) — but ONE NEW P1 the register missed: google-image-raw passed no httpOptions.baseUrl so @google/genai's getBaseUrl fell back to ambient GOOGLE_GEMINI_BASE_URL/GOOGLE_VERTEX_BASE_URL redirecting the stored key's image traffic (the site's egress assert checked a target.baseUrl the client never received — dead assert; fixed w/ explicit default + decoy gate); T014's merge-preserving load() was INVERTED vs its own comment (disk unconditionally overwrote live — a casSync decision racing its floating persist was wiped by the next getDecision load, 30/30 natural-race repro; stale disk resurrected decided records to pending; T017's deterministic interleave pin that would have caught it was never written — fixed w/ newer-wins merge + 3 pins); T007's correct refusal broke every documented embed example (README worker, migration×2, multi-tenant createTenantAgent + error-remediation snippet + signals table, deployment embed note) and WO4 stamped the TEST fixtures instead of the pages — all pages fixed to teach tenancyMode:'multi'; SDK stamp check was fail-open for signal-less runtimes vs the server's fail-closed (fixed strict); T005's worker gate vacuous (asserted only the 413 the old code produced — replaced w/ a mid-stream held-open gate; destroy-at-cap now real, response flushed before destroy; null-JSON body 400); claims: T017 false 0-of-4 pins (all written), T011's env-note move uncommitted (landed), no WO4 CHANGELOG section despite the breaking SDK refusal (written), .zcodeignore committed, WO2 superseded-pointer, stale tag-mint comments corrected, banner miscount 18-vs-20 (erratum in tasks.md) — 15th consecutive claims-truth pass; P2/P3 fixes: Invalid-baseUrl redaction, redactWebhookUrl userinfo strip, SDK baseline threading unions instead of replacing, typed TenancyRuntimeRequiredError at the http refusal + both messages name the real mechanism, hermetic decoy gates (no real api.openai.com dial), under-cap content assert, refresh-response assertion in the arming gate. Post-fix gates: suite 2206/325 zero-unhandled, probes 11/11, worker 25/25, tsc×2, CI green on the branch. Label: defensible-with-caveats stands, caveat list SHORTER than pass-14's (arming on both planes refuses unstamped; standalone limited to derived hosts; accepted-risk register unchanged); systemic note: the false-[x] cluster lands in claims/pins tasks nobody re-verifies before push — worth its own retro.
│   └── 2026-10-01-v0.8.0-release-gate.md # RELEASE GATE for v0.8.0 (seal b9a9fa3 on release/v0.8.0; VERDICT: PASS): Phase 0 [suite 2206/325 after adjudicating one ssrf-deadline timing flake (two abort sources race; green isolated + full re-run; CI 36842395339 at seal), probes 11/11, examples 25/25, build ✓]; task truth 18 TRUE / 2 PARTIAL / 0 FALSE with every pass-15 remediation claim a–h verified at the seal; four-lens fleet + Architect — Red Team: all four headline closures + 2 novel chains (saveAccount plant seam, live settings-plane/session-scoping) HELD with live demos, probe self-enforcement genuine, zero P0/P1/P2 (P3 notes: embedder triple-stamp forgery = self-sabotage; worker cap counts UTF-16 units); Scrutinizer: first hour clean except P1 migration.md §2 snippet threw PRINCIPAL_REQUIRED as written (reproduced first-hand; fixed w/ tenancy:"single") + P2 deployment.md checklist env-var self-contradiction (fixed); Repo Auditor: CHANGELOG [v0.8.0] claims-truth audit CLEAN (zero false load-bearing claims — first time in the train), release-notes P1 overclaim (no-arg ambient disk stores called isolated) fixed + breaking list completed; Architect: SHIP-WITH-CAVEATS — label honest, docs-fixture class under-controlled (gate executes ~15–18 of 100 fences) → fence-coverage lint registered; docs-only repair round r1 folded into the release commit; product P2 register carried (health version "0.0.0", streaming zero-frames error-parity, README strict-tsc nits)
│   ├── 2026-10-05-v0.8.1-release-gate.md # RELEASE GATE for v0.8.1 (seal 61f078f on release/v0.8.1; VERDICT: PASS): single-bugfix patch — loop errors returned (not thrown) by executeLoop were dropped by the middleware pipeline's result copy, so SDK callers with middleware saw empty success-shaped answers; fix = pass the result through unchanged + PipelineContext.result.error + two pins. Seal lineage e1a8507 (fleet → FAIL: 1 P1 vacuous closure pin — SDK e2e test passed middleware per-call, which chatStream silently ignores, proven by revert experiment — + P2 false wire-claims family: the "REST/WS now carry the real typed loop message" claim was live-probed false, the constant lives only in the dead REST log extraction) → r1 8a11fd9 (re-pin at creation level, red at base re-proven twice; claims corrected; README env-var fiction; types.md result shape) → d917f6f (scoped audit.ignore for GHSA-86w9-cpqp-85rv — node-forge ≤1.4.0 no-fix via sandbox-runtime, disclosed in notes, threshold untouched) → r2 61f078f (precision residuals: REST log clause dropped, WS/SSE→WS, README/setup-wizard credential modes = paste/keyless/OAuth per actual wizard menu, unbuildable provider field dropped from WS example). Red Team live-probed hostile-provider multi-tenant server: exfil HELD (wire stays generic), tampering HELD (process-owner trust level), WS fix confirmed on a real socket (base = ack-then-silence, seal = typed frame); Architect premise PASSES (9 call sites swept, whitelist-copy was one trap not a pattern); two CI timing flakes adjudicated (durable-approval-store merge race, model-manager session-switch). Follow-up register: serverGenerateText rebuild + extractLoopError no-payload coalescing (class-killer), remove chatStream's per-call middleware from the Omit list (typed field nothing reads — manufactured the vacuous pin), FIX_PINS register in verify-mutation-probes (mechanize revert discipline), EMPTY_COMPLETION/AgentLoopError doc tables, identity-return laundering note. Both repair attempts used — next claims defect goes to the owner
│   ├── 2026-10-07-027-pre-implementation-red-team.md # Pre-implementation red team of the 027 artifacts (5 lenses + lead; re-baselined same day): RT-1..RT-18 + ponytail net-cut; five-seam shape ratified
│   └── 2026-10-07-post-027-implementation-review.md # Post-027 implementation review @ e6aa869 (6 lenses + lead): 🔴 not ready — engine split genuinely sound; P0-1 release build entry dies on the script-free core manifest (fixed: build:core entry), P1-1 exact-BPE never arms (fixed: registration arms + memo reset + pins), P1-2 README quickstart cannot construct (fixed: verified shape + gate construction), P1-3 serverless persona writes ambient state on read-only HOME (fixed: in-memory single+stateless defaults + non-fatal provider audit + red gate), P1-4 e2e not in CI (fixed: CI + release.yml); P2/P3 register landed (orphan tracer mode, size story 301/102, T019 self-test, migration.md v0.9.0, lazy image backends); task truth 15 TRUE / 5 PARTIAL / 0 FALSE
├── Implementation-Specs/             # One folder per spec: NNN-kebab-name/
│   ├── 007-tui-parity-upgrade/       # TUI parity & generative widget upgrade
│   │   ├── spec.md                   # Problem statement, requirements, scope
│   │   ├── plan.md                   # Phased implementation plan
│   │   ├── tasks.md                  # Dependency-ordered tasks
│   │   └── ...                       # research.md, contracts/, etc. as needed
│   ├── 008-permission-system-redesign/  # OS sandbox + deny-layer + server policy
│   │   ├── spec.md                      # Bug sweep findings + scope decisions
│   │   ├── plan.md                      # P0-P6 plan (R9.1): policy, local/server enforcement, self-evolution, audit durability
│   │   ├── research.md                  # Cross-tool study + R8 end-to-end architecture review
│   │   ├── research-permissions-ux.md   # Deep-dive: Codex/OMP/Hermes implementation + interactive/non-interactive UX
│   │   ├── data-model.md                # Prepared actions, capabilities, brokers, execution boundaries, tool map, authority rules
│   │   ├── contracts/                   # sandbox-api.md, server-policy.md, tui-escalation.md, execution-brokers.md
│   │   ├── quickstart.md                # Per-phase validation scenarios
│   │   └── tasks.md                     # Dependency-ordered implementation tasks
│   └── 009-agents-md-alignment/      # AGENTS.md loader only (v3 — .agents/skills/ moves to separate spec)
│       ├── spec.md                   # Codex startup discovery, 4-layer trust hierarchy, drop-whole byte budget
│       ├── plan.md                   # P1 (loader+composer+resolver) → P2 (settings) → P3 (5 adapters) → P4 (trust+/context)
│       ├── research.md               # Codex semantics + compatibility matrix + R2 blocker disposition
│       ├── data-model.md             # AgentInstructionFile, FsAdapter, resolveSystemContext, resume re-resolve
│       ├── contracts/                # agents-md-loader.md, domain-composer.md, resolve-system-context.md, system-prompt-composition.md
│       ├── quickstart.md             # ~37 deterministic scenarios (no process.chdir, no chmod, no grep -v)
│       └── tasks.md                  # 40 dependency-ordered tasks, 14 regression gates
│   ├── 011-tui-permission-scope-ux/       # Multi-tab TUI permission scope & duration UX
│   │   ├── spec.md                   # Problem statement, requirements, scope
│   │   ├── plan.md                   # Phased implementation plan
│   │   ├── tasks.md                  # Dependency-ordered implementation tasks
│   │   ├── research.md               # Contract and authority-boundary decisions
│   │   ├── data-model.md             # Request, option, decision, and lifecycle model
│   │   ├── contracts/                # Policy-option and TUI prompt contracts
│   │   ├── quickstart.md             # Automated and manual validation scenarios
│   │   └── checklists/requirements.md # Specification quality checklist
│   └── 012-unified-media-generation-engine/  # Unified media engine: Vercel AI SDK + Fal + local pillars
│       ├── spec.md                   # Four pillars, scope decisions M1–M11, success criteria; standalone-package amendment
│       ├── package-charter.md        # Charter for MIT package `seepient-unified-media-generation-provider` (own repo): API surface, license, Seepient boundary
│       ├── plan.md                   # P0–P7 phased plan (schemas → vendors → runtime → catalog → surfaces → legacy collapse) + package/integration artifact split
│       ├── research.md               # SDK surface research (Vercel AI SDK, fal Platform API v1, LocalAI) + D1–D8
│       ├── data-model.md             # Media schemas, ports, backend registry, capability classifier, dispatch inventory
│       ├── quickstart.md             # Per-phase validation scenarios + production budgets (split package/Seepient)
│       ├── tasks.md                  # T001–T055 dependency-ordered tasks (US1–US6, test-first, two-repo split)
│       └── contracts/                # media-inference, media-schemas, media-catalog, media-surfaces
│   ├── 013-provider-management-tui/  # Shared provider mgmt TUI: dock + wizard + OAuth + CLI/server/SDK parity (013)
│   │   ├── spec.md                   # Product spec: 8 prioritized stories, FR-001–FR-040, success criteria
│   │   ├── plan.md                   # M1–M7 build order; verified current-state + surface audits; rules R1–R15
│   │   ├── tasks.md                  # T001–T064 dependency-ordered work orders (test-first, per-phase gates)
│   │   ├── research.md               # oh-my-pi provider-TUI study (/providers, /model, ModelBrowser) + decision ledger D1–D15
│   │   ├── data-model.md             # Persisted shapes (ProviderEntry, CredentialRef, PurposeModelMap) + UI view models
│   │   ├── quickstart.md             # QS-M1–QS-M5 manual validation scenarios + production budgets
│   │   ├── manual-validation-results.md # Manual scenario results (QS-M1–M5, QS-O, QS-P)
│   │   ├── checklists/requirements.md # Specification quality checklist (validated)
│   │   └── contracts/                # provider-manager-api, model-manager-dock, setup-wizard
│   └── 014-provider-catalog-automation/ # Automated provider catalog freshness & upstream sync (014)
│       ├── spec.md                   # Problem statement, requirements, scope
│       ├── plan.md                   # Phased implementation plan
│       ├── tasks.md                  # Dependency-ordered tasks T001–T011 (test-first, phase gates)
│       ├── research.md               # Upstream sync, tier resolver scoring, zero-day passthrough, D6 auto-publish boundary
│       ├── data-model.md             # UpstreamModel metadata, PersistedDiscoveryRecord (future contract), TierScoringCriteria
│       ├── contracts/                # ci-cd-automation.md, resolver-policy.md, passthrough-and-discovery.md
│       └── quickstart.md             # Automated validation scenarios (QS-P1 to QS-P4)
│   └── 015-god-file-decomposition/   # God-file decomposition (015): evidence-gated splits
│       ├── spec.md                   # FR-001–FR-008, non-goals (leave-alone list), success criteria
│       ├── plan.md                   # P1 post-014 window (ws/http/TUI) + P2 post-008 (lifecycle helpers)
│       ├── tasks.md                  # T001–T025 dependency-ordered, US1–US4 stories, per-story QS gates
│       ├── research.md               # Churn/fan-in measurements + decision ledger D1–D11
│       ├── data-model.md             # Symbol → target relocation maps, module-singleton inventory
│       ├── contracts/                # safety-gates.md (five test gates + module-surface contract)
│       └── quickstart.md             # QS-1–QS-4 + QS-P per-phase validation
│   └── 016-location-model/           # Location model & storage contract (016)
│       ├── spec.md                   # FR-001–FR-014, scope decisions M1–M11, success criteria
│       ├── plan.md                   # P1 foundations → P2 workspace/standalone → P3 sessions → P4 outputs/barrel → P5 skills/docs
│       ├── tasks.md                  # T001–T051, US1–US5 stories, test-first per-story gates
│       ├── research.md               # Evidence sweep (file:line citations) + decision ledger D1–D26
│       ├── data-model.md             # PathModel, WorkspaceContext, OutputTarget, BarrelFile, SessionIndexFile, GeneratedSkillFrontmatter
│       ├── contracts/                # paths-module, atomic-write, output-placement, barrel-index, storage-contract
│       └── quickstart.md             # QS-1–QS-8 validation scenarios + production budgets
│   └── 017-permission-tool-baseline/ # Permission tool baseline & consent modes (017 — SHIPPED in v0.5.6)
│       ├── spec.md                   # Brokered-tool lockout + zero-effect gate bug; FR-001–FR-019; three consent modes
│       ├── plan.md                   # P1 repair (0.5.3) → P2 modes (0.6.0) → P3 surfaces + legacy demolition
│       ├── tasks.md                  # T001–T051 dependency-ordered, US1–US5 story gates, test-first
│       ├── research.md               # Evidence ledger E1–E15 + decision ledger D1–D17 (repro-verified root cause)
│       ├── data-model.md             # ConsentMode, ModeDecisionMatrix, ConfigDerivedGrant, three wildcard capability kinds
│       ├── contracts/                # capability-defaults, consent-modes, deny-messaging
│       └── quickstart.md             # QS-1–QS-9 validation scenarios + production budgets
│   └── 018-skill-injection-visibility/ # Skill injection & visibility (018)
│       ├── spec.md                   # Ephemeral per-run skill injection, mandatory skills, cache-ordered assembly, cross-surface applied-skills attribution; FR-001–FR-019, M1–M12
│       ├── plan.md                   # P0 groundwork → P1 injection engine → P2 mandatory → P3 cache-order → P4 surfaces → P5 SC harness
│       ├── research.md               # E1–E9 codebase evidence + DeepSeek/OpenCode study + decision ledger D1–D12
│       ├── data-model.md             # SkillActivation, InjectionRecord, ActivationState, MandatoryDeclaration, AppliedSkillsView, Usage cache split
│       ├── contracts/                # activation-contract, context-assembly, mandatory-skills, visibility-parity
│       ├── quickstart.md             # QS-1–QS-5 validation scenarios + QS-P production budgets
│       ├── tasks.md                  # T001–T050 dependency-ordered, US1–US5 story phases, test-first gates
│       └── checklists/requirements.md # Specification quality checklist (validated)
│   └── 019-exact-commit-enforcement/ # Exact-commit enforcement & native helper completion (019)
│       ├── spec.md                   # P0 bypass closure + helper build/packaging + collateral remedies; FR-001–FR-015, M1–M12
│       ├── plan.md                   # P0 logic closure (no binary) → P1 Rust helper + packaging → P2 fallback demolition
│       ├── research.md               # Ultra-deep review evidence (HEAD 3827eb3) + decision ledger D1–D15
│       ├── data-model.md             # CommitHelperProbe+digest, manifest.json, jsFsFallbackOptIn, commit-files edit ops, allowlist setting
│       ├── contracts/                # native-helper-protocol, exact-commit-gating, trusted-host-allowlist
│       ├── quickstart.md             # QS-0.1–QS-2.3 validation scenarios + production budgets
│       └── tasks.md                  # T001–T041 dependency-ordered, US1–US7 story phases, test-first gates
│   └── 020-custom-tool-execution-parity/ # Custom-tool execution parity (020 — SHIPPED in v0.6.0)
│       ├── spec.md                   # Make preparedTool/brokerConnector execute; FR-001–FR-009, M1–M14, SC-001–SC-006
│       ├── plan.md                   # P0 draft contract+constructor → P1 preparedTool dispatch (SDK roots + factory seam) → P2 connector registry → P3 export restoration + decision table
│       ├── research.md               # 0.5.7 review evidence E1–E10 + decisions D1–D16 (incl. review amendments F1–F7, R1–R4)
│       ├── data-model.md             # ToolRegistrationMap, PreparedActionDraft + constructor table, connector registry, error codes
│       ├── contracts/                # prepared-tool-execution, broker-connector-registry, trust-model-selection (decision table)
│       ├── quickstart.md             # QS-0.1–QS-3.3 validation scenarios + QS-P production budgets
│       └── tasks.md                  # T001–T023 dependency-ordered, US1–US4 story phases, test-first gates
│   └── 021-stateless-sdk-workers/    # Stateless SDK workers & embedder-owned storage (021 — SHIPPED in v0.6.1)
│       ├── spec.md                   # Multi-tenant state injection; FR-001–FR-012, M1–M8, SC-001–SC-005
│       ├── plan.md                   # P0 injection road → P1 zero-write gate + server parity → P2 reference worker + docs
│       ├── research.md               # Verification evidence E1–E12 + decisions D1–D10 + scrutiny S1–S3 (2026-08-31, HEAD 643e316)
│       ├── data-model.md             # Option model, store contract inventory, state classification table
│       ├── contracts/                # store-contracts, sdk-injection-options, worker-deployment
│       ├── quickstart.md             # QS-0–QS-4 validation scenarios + production budgets
│       ├── tasks.md                  # T001–T018 dependency-ordered, US1–US3 story phases, test-first gates
│       ├── 021-1-skill-sources/      # Sub-spec: injectable skill sources (021-1 — IMPLEMENTED + rounds 1–3 remediation W200–W252 completed)
│           ├── spec.md               # SkillSource/SkillStore + inline tier; FR-001–FR-010, M1–M7, SC-001–SC-007, checks CB-1–CB-8
│           ├── plan.md               # P0 reconcile+gate → P1 FsSkillSources+inline → P2 write path+016/018/024 coordination → P3 example+docs
│           ├── research.md           # 2026-08-31 ledger E1–E6/D1–D7 + 2026-09-07 re-baseline E7–E14/D8–D14 + supersession map
│           ├── data-model.md         # SkillRecord (source? platform-stamped), tenancy-aware composition, last-store save rule
│           ├── contracts/            # skill-source-contract, sdk-skill-options
│           ├── quickstart.md         # QS-S0–QS-S5 validation scenarios + budgets + release discipline
│           ├── tasks.md              # T001–T016, US0 reconcile → US1 composition+inline → US2 write path → US3 example+docs; red-first gates
│           └── remediation/          # Work orders: rounds 2–3 W200–W252 completed (winner-body fix, docs truth, fail-closed server input, multi-tenant closure)
│       ├── 021-2-review-remediation/ # Sub-spec: consolidated review repairs (021-2 — SHIPPED in v0.7.0 via 021-3)
│           ├── spec.md               # Release safety + server sessions + transport hardening + docs truth; FR-001–FR-019, M1–M12, SC-001–SC-010
│           ├── plan.md               # US1 release safety → US2 sessions/WS integrity → US3 type truth ∥ US4 hardening/docs (blast-radius table)
│           ├── research.md           # Four-source consolidation: E1–E24 verified evidence, D1–D15 decisions, S1–S5 scrutiny
│           ├── data-model.md         # Changed shapes: pack gate, REST sessions, WS guard, pinned fetch, limits, logging
│           ├── contracts/            # release-artifact-contract, server-session-surface, transport-hardening, sdk-parity-and-type-truth
│           ├── quickstart.md         # QS-0–QS-7 validation scenarios + QS-P production budgets
│           └── tasks.md              # T001–T027 dependency-ordered, US1–US4 stories, test-first gates
│       ├── 021-3-remediation/        # Work order: 021-2 implementation remediation (021-3 — SHIPPED in v0.7.0)
│       │   └── tasks.md              # W001–W041; owner D1 (sessionless chat = no session) + D2 (fallback: mandatory sessionId)
│       └── 021-4-remediation/        # Work order: rename completion + embedding/security/session repairs (021-4 — SHIPPED in v0.7.0; D1 adopt / D2 fold / D3 send-time normalization)
│           └── tasks.md              # W100–W172; askSeepient/runSeepientServer truth, WS scopes, broker byte-classifier, D3 send-time history normalization
├── 022-multi-tenant-isolation/       # Multi-tenant isolation hardening (022 — implemented on 021-1 branch, shipped in v0.8.0)
│   ├── spec.md                       # FR-001–FR-018, M1–M12, SC-001–SC-005; per-agent registries, tenancy mode, principal-scoped state, regression fence
│   ├── plan.md                       # P0 registry+contracts → P1 tool-path retarget → P2 tenancy+scoped state → P3 skills/invariant/docs → P4 matrix+re-audit+release
│   ├── research.md                   # 2026-09-07 full-boundary audit: E1–E20 evidence (2-class findings), D1–D14 decisions
│   ├── data-model.md                 # ToolRegistry, tenancy decision matrix, stamped Capability, scoped ledger, state classification v2
│   ├── quickstart.md                 # QS-1–QS-8 validation scenarios (isolation matrix, mutation check, re-audit) + QS-P budgets
│   ├── tasks.md                      # T001–T035, US1–US5 story phases, test-first gates, per-task runnable self-checks
│   ├── contracts/                    # tool-registry, tenancy-mode, principal-scoped-state, isolation-harness
│   ├── 022-1-readiness-remediation/  # Sub-spec: v0.8.0 readiness closure (022-1 — IMPLEMENTED, branch 022-1-readiness-remediation)
│       ├── spec.md                   # FR-001–FR-041, M1–M12, SC-001–SC-008; closes all P1s from Reviews/2026-09-07-product-readiness-review-021-to-022.md
│       ├── plan.md                   # P0 red-first gates → P1 front-door truth → P2 first-hour defaults → P3 tenancy closure → P4 server reliability → P5 skills residuals → P6 release gates
│       ├── research.md               # AUTHORITATIVE disposition ledger R1–R63 (FR-001): every review finding → 022-1 FR or existing owner; D1–D14; S1–S5 holds
│       ├── data-model.md             # PrincipalRequiredError/PERSIST_CONFIG_INVALID/SESSION_ID_INVALID, literal tenancy signal, list?() backend, server CLI parser, gate reports
│       ├── quickstart.md             # QS-0–QS-8 automated validation scenarios + production budgets
│       ├── tasks.md                  # T001–T048, US0 gates → US1..US6 stories, red-first gates (CB-1), [MANUAL]=0
│       └── contracts/                # docs-truth-gates, server-entry-and-parity, tenancy-closure
│   ├── 022-2-composition-closure/    # Sub-spec: multi-tenant composition closure (022-2 — plan + tasks complete 2026-09-13; closes the five-pass adversarial review's five P0s)
│       ├── spec.md                   # FR-001–FR-023, M1–M8, SC-001–SC-006; closes VULN-1/2/9/10/16 + release-blocking P1s per Reviews/2026-09-12-adversarial-multi-tenant-sdk-review.md + 2026-09-13-multi-tenant-remediation-plan.md (adjudicated); artifact review 2026-09-13 fixed SDK single-mode ambient wiring (E28)
│       ├── plan.md                   # Invert construction defaults (no-arg = isolated, ambient only via createAmbientProviderRuntime at Profile A roots) + stamp backstop; US0 red gates → US1 inversion → US2 identity/sessions → US3 inference/edges → US4 gateway-boot/worker → US5 release truth; ~5 days two-stream; branch cut from 022-1 @ 0b7fe4e
│       ├── research.md               # Disposition ledger for the twelve unowned items (FR-001, authoritative); DP1–DP12 decisions; E1 = pi-ai override seam verified (explicit options.apiKey defeats stored+ambient — wrapper fix needs no upstream change); E27 = measured migration surface (getDefaultProviderRuntime: 39 refs/16 files — panel estimate 3× low); E28 = single-mode SDK ambient-default hazard + FR-006 wiring; contingencies for items 10/11 (024-2/025, 023)
│       ├── data-model.md             # isIsolated stamp, createAmbientProviderRuntime + createIsolatedProviderRuntime (options-object constructor shape verified), InMemoryReplayLedger (new), PRINCIPAL_ID_RE + InvalidPrincipalIdError/TenancyWorkspaceRequiredError, secret-resolution matrices (broker + inference wrapper), composite session keys, createTenantAgent (createOperatorAgent deferred to the export-split follow-up — single-mode createSeepient IS the operator path), per-principal server workspaceId
│       ├── quickstart.md             # QS-0–QS-5 + QS-P; eleven red-first adversarial journeys incl. de-vacuumed zero-write gate; [MANUAL]=0; release owner-gated (OQ-1)
│       ├── tasks.md                  # T001–T046, US0 red gates → US1 inversion → US2 identity/sessions ∥ US3 inference/edges → US4 gateway/worker → US5 release truth → polish (contingency pull-forward, quickstart run, re-audit); every task carries a runnable self-check; checkpoint tasks flip it.fails journeys green; MVP = T001–T023, release-blocking set through T033; [MANUAL]=0
│       └── contracts/                # isolated-construction, execution-boundary-tenancy, inference-egress, surface-truth
│   ├── 022-3-remediation/            # Work order: post-022-2 remediation (022-3 — Round 1 IMPLEMENTED + verified; Round 2 tasks ready 2026-09-13; rides uncommitted 022-2 tree)
│       ├── spec.md                   # Round 1 FR-001–FR-019 (US1 arming ∥ US2 worker auth → US3 server root → US4 secretResolver → US5 test integrity + docs → US6 P2 batch; SC-001–SC-006) + Round 2 FR-020–FR-041 (US7 WS-auth key-file P0 ∥ US8 worker authority closure → US9 operator surfaces → US10 CAS merge-back + single-mode repair → US11 claims truth beyond docs/ → US12 P2 batch; SC-007–SC-011) sourced from the pass-7 + pass-8 reviews
│       ├── plan.md                   # P0 red gates (4 journeys red on current tree) → P1 P0 fixes ∥ → P2 server root → P3 secretResolver → P4 tests/docs → P5 P2 batch + release truth; ~1–1.5 days
│       ├── tasks.md                  # Round 1 T001–T032 COMPLETE (all [X]); Round 2 T033–T073 READY (generated 2026-09-13 via speckit-tasks from the reconciled pass-7/pass-8 register): R2-2 red gates (WS-AUTH-SPLIT, WORKER-CRASH/CAPS/TOKENS/CAS-DEADCODE, SETTINGS-PLANE, SERVER-TOOLS-DEFAULT, CAS-ERASURE, FRESH-INSTALL-LOSS, CLAIMS-TRUTH, SINGLE-MODE-ROUNDTRIP) land failing → MVP = T033–T048 (WS-auth P0) → US8 ∥ US9 ∥ US11 ∥ US12 disjoint-parallel, US10 after gates → polish + SC-011 review re-run; contingency hooks on OQ-E/F/G
│       ├── research.md               # Evidence E1–E8 (verified review citations) + decisions D1–D9 (arm at producers only; throw-not-warn on ambient runtime; in-memory multi store defaults; fail-closed GATEWAY_ISOLATION_REQUIRED; resolver = sync tenant-store projection; recordHit in mock seams only; code-bearing denials; multi stops seeding 017 wildcards; P2 owner disposition)
│       ├── data-model.md             # InferenceOptions producers, buildLocalBoundary.secretResolver + UNCONTAINED gate, multi server boot default table, denied(code), worker read-only token→principal, validation tightenings
│       └── quickstart.md             # QS-0–QS-6 + QS-P; red-first QS-1/2/4; [MANUAL]=0
│   ├── 022-4-remediation/            # Work order: follow-up-sweep closure (022-4 — Rounds 1+2 LANDED via d27ac91+2f005f9+2820f12; Round 3 LANDED 2026-09-24 closing the pass-10 register: read-plane dev/ino identity binding + PATH_IDENTITY_MISMATCH, production-seam mutation probes (11 targets, green-baseline + evidence-required), SC-003 typed denial, SDK #private-store signal fix, operator provider channel --providers-file/--api-keys-file, WS egress backpressure, worker typed 409, docs truth batch; tasks.md Phase 14 = T047–T053)
│       ├── spec.md                   # Round 1 FR-001–FR-012 (US0 red gates → US1 symlink plane → US2 global-lifetime gate → US3 integrity → US4 auth/perms → US5 pins; amended product rule AUTHORIZE-WHAT-YOU-READ + FR-008 denial-UX/continuity) + Round 2 FR-013–FR-019 (US6 fd-pinning O_NOFOLLOW + st_nlink hardlink gate; US7 offered-lifetimes truth + one-bucket unstamped CAS + sentinel unification; US8 executable mutation-probe contract + first-hour docs truth; US9 external-verification addendum: push+CI-green gate, SDK store exports, env-fiction batch, hygiene pair); SC-001–SC-010
│       ├── plan.md                   # R1 P0 red gates → symlinks → lifetime ∥ auth/perms → integrity + pins → release truth (~1d) + R2 swap-racer/hardlink/offered-then-denied/no-growth/roundtrip red gates → read plane → approval truth ∥ builder trust (~1d); errata recorded (hardlink dismissal wrong, TOCTOU documented-not-closed)
│       ├── research.md               # AUTHORITATIVE disposition ledger pass-8 → owner + evidence E1–E9 (E8 = pass-9 register → R2 FRs) + decisions D1–D13 (D12 export-what-the-CHANGELOG-names; D13 push-first/verify-last; D7 authorize-what-you-read; D8 authorize-what-you-open; D9 hardlink = second name; D10 offered-set truth; D11 one-bucket unstamped) + product-lens owner questions (OQ-G elevated + adopted as FR-017; R2's unlisted 4th breaking change flagged)
│       ├── data-model.md             # Authorize-the-realpath canonicalization (in-workspace links ALLOWED, ceiling escapes denied w/ remediation), fd-pin contract, st_nlink gate, offered-lifetimes shape, one-bucket merge, sentinel unification, probe spawn contract, 9 invariants
│       ├── quickstart.md             # QS-0–QS-5 + QS-P; all 5 red-first journeys named; [MANUAL]=0
│       └── tasks.md                  # T001–T025 (Round 1 — landed via d27ac91+2f005f9, status banner, checkboxes not back-filled) + T026–T046 READY (Round 2 + US9): 5 red gates on the 2f005f9 tree (swap-racer, hardlink, offered-then-denied, no-growth 2^K, CLI→SDK roundtrip) → US6 fd-pinning + hardlink gate → US7 offered-truth ∥ one-bucket ∥ sentinel ∥ US8 executable probes + docs batch [P] → T038–T040 release truth incl. in-workspace-links-now-allowed behavior-change note + pass-10 prep + T041–T046 (US9 addendum: T041 push-first + T046 CI-green gate on all four jobs, SDK in-memory store exports, providers.md/CLI-help env-fiction batch + vocabulary-gate widening + AGENTS.md §9.3 SessionId text, getActiveSessions delete-or-scope, sync-workflow force-with-lease)
│   ├── 022-5-engine-remediation/     # Engine boundary remediation (022-5 — IMPLEMENTED 2026-09-28 on branch 022-5-engine-remediation [3b03160+2271282+0631eff]; re-baselined per Reviews/2026-09-28-022-5-pre-implementation-red-team.md; VERIFIED 2026-09-29 by pass-11 [Reviews/2026-09-29-post-022-5-adversarial-review.md]: 🟡 engine held, NO P0, but 7 P1s — WS multi approvals dead via FR-013 actorId mismatch, htmlToText quadratic DoS, 2 FIFO wedges, FR-008d/e fiction, pin-scope overclaims, first-hour env-string/doc family, red suite + unpushed/no-CI; several [x] false — remediation sketch §9 there; all 32 tasks done; gates: suite 2136 passed/305 files, probes 11/11 with expected-message markers, worker 20/20, tsc×2 clean [US0 red gates → US1 read-plane ∥ US2 credentials → US3 probes/claims → US4 residuals → polish], implementation via /speckit-implement: FR-001/002 now verify+pins on the landed R3 identity binding [PATH_IDENTITY_MISMATCH adopted, RA-2], FR-003 edit_file ceiling + PATH_ESCAPES differential, FR-004 FIFO/abort incl. media openSync→async + CLI image repair; US2 expanded [five env names, env-mode removal per RA-4, tenancy-invariant FR-007 + kind:"none" sentinel per RA-3 killing the vendored pi-ai env fallback, wire pin single+multi]; US3 delta on the adopted R3 seam [RA-1: two-factor activation, ZERO_HITS de-confound fixing 8/11, message pins, dogfood, registration lint] + six-claim CHANGELOG corrections; US4 unchanged; SC-001..014 pin all FRs; branch-cut eca55dd; ~1–1.5 days): read-plane identity binding (dev/ino on the pinned fd — kills the folder-swap P0; media seam + edit_file oracle + FIFO), inference env-key DEMOLITION (credentials only via pi-ai provider management, owner decision), REAL mutation probes + CHANGELOG claims corrections, P2 guard-surface batch (auth key-cache revocation race, root:"/"∥"" strip, GLOBAL typed denial not throw, casSync principal binding, htmlToText input cap, worker crash/413, racer kill-on-settle); pi-sync auto-release = ACCEPTED RISK (owner 2026-09-24)
│   └── 022-5-WO1-remediation/        # Work order: post-022-5 remediation (022-5-WO1 — IMPLEMENTED 2026-09-29; VERIFIED same-day by pass-12 [Reviews/2026-09-29-post-022-5-WO1-adversarial-review.md]: 🟡 pass-11 register genuinely closed + engine held, but 2 new P1s (brokered-fetch unbounded buffering OOM, refreshModels multi assert unarmed in production) + 9-of-41 tasks partial-false — WO2 sketch §7 there on branch 022-5-WO1-remediation [1ab51d6..d3092c7]; all 41 tasks done; gates: suite 2173 passed/313 files with zero unhandled errors, probes 11/11 WITH seam-coverage + registration lints live, worker 20/20, tsc×2 clean; pass-11 P1-1..P1-7 closed — WS consent plane repaired, htmlToText linear, FIFO wedges closed, lints real, credential tripwires complete, first-hour truth; tasks READY 2026-09-29, generated via speckit-tasks from Reviews/2026-09-29-post-022-5-adversarial-review.md; branch cut from dd4a171; [MANUAL]=0; owner-question defaults D1-D4 recorded reversible: D1 actorId = edge-derived authenticated principal (apiKeyHash ?? ws-user), D2 keep no-daemons kill-on-settle everywhere + document, D3 implement both probe registration lints for real + fix VULN-1-BROKER seam naming, D4 add WO1 branch to ci.yml triggers): US0 red gates T002-T009 (WS multi-approval resolve(true), htmlToText 256KiB wall-clock, commit-files + edit-section FIFO wedges via Promise.race, suite-exit-0 subprocess gate, refreshModels egress parity, producer source-scan tripwire w/ unarmed fixture, first-hour stdout/docs-example gates) → US1 consent plane T010-T012 (thread principal into wsApprovalDecision actorId via pendingApprovals entry; casSync owner = principalId ?? request.principalId with assert-not-opt-in; SC-010 continuation pin) ∥ US2 availability T013-T016 (anchored tag regex + entity/surrogate guards; commit-files old-content O_NONBLOCK+isFile+expected-identity pin+signal; edit-section identity pin closing the micro-race exfil chain; media typed codes surviving classifyMediaError + signal into readFile) → US3 test integrity T017-T021 (SEAM COVERAGE + REGISTRATION lints wired for real w/ dead COUNTER_ONLY const made executable; committed dogfood scenario deleting a real seam; confound pin; FAIL-section message matching w/ alternation; artifact/banner erratum) → US4 pins T022-T027 (refreshModels tenancy+egress+recorded surface on 3 surfaces; vendored-import source-scan enumeration + barrel narrowing; resolved-key wire journey single+multi w/ decoys; profile-a provider-management fixture; title truth) → US5 first-hour+claims+release T028-T033 (in-binary strings→auth-login guidance; docs batch incl. executable provider-management isolated example + local-llm command + multi-tenant/providers/reference pages; vocabulary gate widening to .env.example/AGENTS.md/case/env-mode; floating store promises caught → suite exit 0; CHANGELOG truth for Security(022-5) section + remaining 2 FR-009 corrections + lint-claim; push + CI trigger) → US6 P2 closure T034-T037 (symlink dangling-vs-existing oracle byte-identical denials; D2 doc+pin; stub root normalize; SC-008/009/011/012 pins) → polish T038-T041 (full gates, PendingApprovalStore dead-duplicate deletion + tenancyMode param, vault map, release commit+push); MVP = T001-T016, release-blocking through T038; every task carries a runnable → verify; refuted findings and owned-elsewhere items explicitly excluded
│       └── 022-5-WO2-remediation/   # Work order: post-022-5-WO1 remediation (022-5-WO2 — IMPLEMENTED 2026-09-29; VERIFIED same-day by pass-13 [Reviews/2026-09-29-post-022-5-WO2-adversarial-review.md]: 🔴 label one composition line short — buffering CLOSED + engine held, but injected-runtime branch skips the multi arming (pass-12 exfil chain live-probed on the documented embed path) and standalone --providers-file lost operator refresh w/ no baseline channel; 15/21 tasks TRUE, WO3 sketch §7 there on branch 022-5-WO2-remediation; all 21 tasks done; gates: suite 2189 passed/319 files, probes 11/11 with lints, worker 25/25, tsc×2 clean; pass-12 P1-1 closed [NodeNetworkAdapter arms pinnedFetch streaming cap — 1.45GB->76ms bounded rejection], P1-2 closed [server boot roots armed multi + operator-baseline capabilities; D2 write-side assert on the accounts PUT via runtime.assertAccountEgressAllowed]; pi-canonical-converter exemption; AGENTS vocabulary exemption scoped to vault-map fence + speckit block [D3]; generated from Reviews/2026-09-29-post-022-5-WO1-adversarial-review.md §7)
│           └── 022-5-WO3-remediation/ # Work order: post-022-5-WO2 remediation (022-5-WO3 — IMPLEMENTED 2026-09-29 on branch 022-5-WO3-remediation; all 17 tasks done; gates: suite 2197 passed/322 files, probes 11/11 with lints, worker 25/25, tsc×2 clean, CI 8/8 green at bbbfefa [follow-ups: casSync decision written synchronously into the requestId map — T012 pin caught a real getDecision race; README --env-var sweep finished]; pass-13 P1-1 closed [injected runtimes require the multi stamp — TENANCY_RUNTIME_REQUIRED; createSeepient stamps by construction, D2], P1-2 closed [operator baseline DERIVED from providers-file accounts at boot; standalone refresh works; boot notice + deployment.md], P2-1 folded [egress assert in saveAccount — one seam], webhook denial URL redacted, section-read identity pin re-bound to tag-mint identity [real swap gate both directions]; generated from Reviews/2026-09-29-post-022-5-WO2-adversarial-review.md §7; VERIFIED 2026-10-01 by pass-14 [Reviews/2026-10-01-post-022-5-WO3-adversarial-review.md]: 🔴 label not yet — server plane genuinely closed + 13-pass engine register held on dist, but 4 P1s (T005 pin DEAD in production via bare require() in ESM swallowed by its own catch — vitest shim hides it; createSeepient multi accepts single-stamped runtimes w/ T007 stamp unreachable, pass-13 exfil chain live on the SDK plane; OPENAI_BASE_URL env-destination exfil on both openai-SDK sites; worker pre-auth OOM), T010 PARTIAL-FALSE again, SDK baseline channel inert as documented; task-truth 11/4/1; ~1-day WO4 sketch §8 there)
│               └── 022-5-WO4-remediation/ # Work order: post-022-5-WO3 remediation (022-5-WO4 — IMPLEMENTED 2026-10-01 on branch 022-5-WO4-remediation; all 18 tasks done; gates: suite 2202 passed/324 files, probes 11/11 with lints, worker 25/25, tsc×2 clean; pass-14 P1-1 closed [bare require gone; fd-threaded identity in record(); source+behavior pin], P1-2 closed [SDK multi stamp refusal + operatorBaseline threads into runtime capabilities], P1-3 closed [explicit baseURL at both openai-SDK sites + decoy-env pin], P1-4 closed [worker stops appending past cap]; D1 refuse D2 one-option D3 merge-preserving load; generated from Reviews/2026-10-01-post-022-5-WO3-adversarial-review.md §8; VERIFIED+REMEDIATED 2026-10-01 by pass-15 [Reviews/2026-10-01-post-022-5-WO4-adversarial-review.md]: the four P1 closures GENUINE under attack, but the register found ONE NEW P1 (google image site wired no httpOptions.baseUrl — GOOGLE_GEMINI_BASE_URL/GOOGLE_VERTEX_BASE_URL env-destination exfil, live-probed; the egress assert checked a target.baseUrl the client never received), an INVERTED merge inside T014 (disk overwrote live — decision wipe 30/30; T017's missing interleave pin is why it shipped), docs dead-ends (every stamped-example page now threw — README/migration×2/multi-tenant×2 — fixtures were stamped instead of the pages), the SDK stamp check fail-open vs the server's fail-closed, T005's gate vacuous, T017 false 0-of-4, T011's fix left uncommitted, no WO4 CHANGELOG section despite the breaking refusal, banner miscount (18 vs 20) — 15th consecutive claims-truth pass; ALL FIXED at 78c0fb8 with pins (google decoy gate, 3-way merge pins, destroy-at-cap mid-stream gate, hermetic decoys, docs stamped, WO4 CHANGELOG + env-note landed); gates post-fix: suite 2206/325 zero-unhandled, probes 11/11, worker 25/25, CI green; task-truth at reviewed HEAD: 11 TRUE / 6 PARTIAL / 2 FALSE (T005, T017))
│       ├── spec.md                   # US1 read plane ∥ US2 inference credentials ∥ US3 test integrity + claims ∥ US4 residuals; FR-001–FR-016, SC-001–SC-005; five binding owner decisions 2026-09-24 recorded in-header
│       ├── plan.md                   # P0 red gates → P1 read plane ∥ P2 env demolition → P3 probes + claims → P4 residuals → P5 release truth; ~2–3 days; P1∥P2 disjoint-file split
│       ├── research.md               # Evidence E1–E12 (pass-10, lead-verified, probe-confirmed where marked) + owner decisions O1–O5 + technical decisions D1–D9 (dev/ino identity token; injected GuardProbe not env branches; stat-verify-publish cache; universal-root strip class)
│       ├── data-model.md             # ReadIdentity {dev,ino} state machine, credential resolution matrix, GuardProbe contract, KeyCacheEntry shape, strip normalization table, 9 test-pinned invariants
│       ├── contracts/                # read-identity-binding, inference-credential-sources, mutation-probe-contract
│       └── quickstart.md             # QS-0–QS-6 + QS-P budgets; all red-first; [MANUAL]=0
├── 023-seepient-sage/                # Seepient Sage: unified telemetry tracing + full auditing (023 — planned, branch 023-seepient-sage)
│   ├── spec.md                       # US1–US6, FR-001–FR-023, M1–M13, SC-001–SC-007; two-plane (audit+telemetry) system
│   ├── plan.md                       # P0 correlation spine → P1 audit enrichment → P2 telemetry plane → P3 gap closure → P4 surfaces → P5 self-consumption
│   ├── research.md                   # Evidence E1–E19 + decision ledger D1–D13 (architecture options A–D scored/ranked; baselines on 022)
│   ├── data-model.md                 # SageContext, SpanRecord, RunRecord, AuditQuery/SecurityNotice, RedactionFilter, storage layout
│   ├── quickstart.md                 # QS-1–QS-8 validation scenarios + QS-P production budgets
│   ├── tasks.md                      # T001–T049, US1–US6 story phases, test-first gates, per-task self-checks (protocol: grep proofs, micro-probes, UX substring asserts, round-trip probes, byte-fixtures, determinism + negative probes, fail-open/closed drills); five-lens review remediated 2026-09-07 (M13 helper slice, createAgent dropped, filter foundational)
│   └── contracts/                    # sage-correlation, telemetry-plane, audit-enrichment-and-query, sage-surfaces, self-consumption
├── 024-security-remediation/         # Security remediation with product-weighted defaults (024 — planned, branch 024-security-remediation)
│   ├── spec.md                       # US1–US5, FR-001–FR-020, M1–M12 (M4/M6/M8/M9/M12 amended), SC-001–SC-009; re-baselined 2026-09-24 against 2820f12 + Architecture/security-posture.md and product-re-aligned (autonomous multi-purpose agent, extension surfaces first-class) — adds FR-016 output-classifier truth, FR-017 host-persistence deny table (git + shell-init families), FR-018 WS one-shot ticket auth, FR-019 revocation disconnect, FR-020 approval-label scope truth; §Re-baseline records tree drift, charter + product re-grades, external-reviewer adjudication, pass-10 ownership matrix (engine items → 022-5 rec.), gateway amendment elevated to product-critical for the multi-tenant claim; tasks.md regeneration required
│   ├── plan.md                       # P0 integrity → P1 shell tiers + FR-016 output truth → P2 host-config fence (FR-006/017) + label truth (FR-020) → P3 secret minimization → P4 WS origin + ticket auth/revocation (FR-012/018/019) → P5 skills gate + release; re-aligned 2026-09-24 to FR-016..020 + 022-5 strip-layer sequencing rule
│   ├── research.md                   # Evidence E1–E14, audit corrections S1–S5, decisions D1–D14 (product-lens deliberation), owner questions Q1–Q3
│   ├── data-model.md                 # ShellRiskTier/classification, credential filetable, balanced gate matrix, ceiling migration, skill trust record
│   ├── quickstart.md                 # QS-1–QS-8 validation scenarios + production budgets
│   ├── tasks.md                      # T001–T028, US1–US5 story phases, test-first gates, per-task self-checks (protocol: gate-matrix/prompt-count/UX-substring/parity/mode-invariance/migration/negative probes)
│   ├── contracts/                    # shell-risk-classifier, secret-ref-authority, workspace-skill-trust, transport-origin
│   ├── 024-1-native-approval-parity/ # Sub-spec: native approval parity — REPL/headless/SDK/WS off the legacy bridge (024-1 — planned, after 022/023/024)
│   │   ├── spec.md                   # US1–US4, FR-001–FR-015, M1–M8, SC-001–SC-006; readline presenter, headless truth, bridge + legacy-type demolition
│   │   ├── plan.md                   # P0 red gates → P1 readline surface → P2 headless truth + knob demolition → P3 SDK/HTTP/WS retarget + bridge deletion → P4 loop fail-closed + type truth + docs
│   │   ├── research.md               # Evidence E1–E15 (verified v0.7.2 @ 3595047) + cross-spec coordination (022/023/024/025: zero overlap) + decisions D1–D10
│   │   ├── data-model.md             # Deleted-type table, ApprovalSelection, presenter model, interaction-mode matrix, seam/option/settings deltas
│   │   ├── quickstart.md             # QS-1–QS-5 validation scenarios + QS-P production budgets
│   │   ├── tasks.md                  # T001–T046, US1–US4 story phases, test-first gates, per-task runnable self-checks
│   │   └── contracts/                # readline-approval-presenter, approval-injection-surface
│   └── 024-2-product-review-remediation/ # Sub-spec: 2026-09-06 product-review remediation (024-2 — planned, after 022/023/024/024-1)
│       ├── spec.md                   # US1–US6, FR-001–FR-031, M1–M7, SC-001–SC-007; owns the review remainder after predecessor subtraction
│       ├── plan.md                   # P0 re-baseline ledger → P1 write integrity → P2 inference pinning → P3 SDK/docs truth → P4 release gates → P5 store hygiene → P6 transport residuals → P7 review re-run
│       ├── research.md               # Subtraction ledger vs 022/023/024/024-1/025 (finding×spec matrix), E1–E22, D1–D15; owner decisions Q-A–Q-D resolved 2026-09-07
│       ├── data-model.md             # FileSnapshot sha256, gate condition, error-export table, docs-sync v2, docs-sweep annex (page:line), finding→FR matrix
│       ├── quickstart.md             # QS-P0 re-baseline + QS-1–QS-7 validation scenarios
│       └── contracts/                # write-integrity-gating, sdk-surface-and-docs-truth, inference-egress-pinning, release-gates, store-and-transport-hygiene
├── 025-agent-instance-state/         # Agent-instance state & process-global elimination (025 — planned, branch 025-agent-instance-state)
│   ├── spec.md                       # US1–US5, FR-001–FR-011, M1–M8, SC-001–SC-005; shrinks 022's FR-017 accepted list
│   ├── plan.md                       # P0 audit+invariant v3 → P1 SDK surface → P2 cache ownership → P3 server objectification → P4 fence green+docs
│   ├── research.md                   # Evidence E1–E15 (E1–E4/E12 tagged 022-owned to prevent duplication), consequences C1–C3, decisions D1–D9
│   ├── data-model.md                 # Disposition table (022 §6 → 025), AgentSettings, ServerState, invariant classification v3
│   ├── quickstart.md                 # QS-0–QS-7 validation scenarios + QS-P production budgets
│   ├── tasks.md                      # T001–T024, US1–US5 story phases, test-first gates, self-check protocol (GP/TS/MP/XP/TP/CP/DP/PP; [MANUAL]=0)
│   ├── checklists/requirements.md    # Specification quality checklist (validated 2026-09-07; 30/30 post-review)
│   └── contracts/                    # process-state-invariant, sdk-surface-migration, server-state
├── 027-serverless-chat-core/         # Serverless chat core package split (027 — IMPLEMENTED 2026-10-07 on branch 027-serverless-chat-core; repair round for Reviews/2026-10-07-post-027-implementation-review.md LANDED same day; next: /release-gate in a fresh session)
│   ├── spec.md                       # FR-001–FR-012, SC-001–SC-005; five seams; ≤150MB core closure gate; createChat = the one deliberate new API
│   ├── plan.md                       # pnpm workspace root=full + packages/core; tsconfig.core.json single membership source; D1–D21
│   ├── research.md                   # Evidence E1–E13 + red-team re-baseline D13–D21 (five seams incl. execution-pipeline injection)
│   ├── data-model.md                 # Module relocation map, WeightBudget, ChatSession, LockstepRelease
│   ├── quickstart.md                 # QS-0–QS-5 + QS-P (tracer, weight, core-only chat, parity, security, release)
│   ├── tasks.md                      # T001–T021 (18 TRUE / 3 PARTIAL ratified in notes; owner NPM_TOKEN-scope flag open)
│   └── contracts/                    # core-package-surface, package-boundary, release-flow
├── 010-provider-management-redesign/ # Provider mgmt redesign: contracts + runtime + purpose/tier routing
│   ├── spec.md                       # Problem, 5 blockers + 4 gaps, scope decisions, success criteria
│   ├── plan.md                       # P0-P7 phased plan (contracts → Pi adapter → runtime → resolution → surfaces → reliability)
│   ├── tasks.md                      # Dependency-ordered task list per phase
│   ├── research.md                   # Resolves 5 blockers + 4 gaps (D1-D20)
│   ├── data-model.md                 # PurposeModelMap, ResolvedInvocation, dispatch inventory
│   ├── migration.md                  # v1→v2 config migration, lazy sessions, SDK deprecation
│   ├── quickstart.md                 # Per-phase validation scenarios + production budgets
│   ├── remediation-plan.md           # Post-P7 review fix plan: WS0-WS10 (secret-leak blocker, catalog-native redesign, Pi pin bump, OMP enrichment)
│   ├── cleanup-plan.md               # v1 demolition: P0-P9 phased removal of legacy provider path (bridges, dual paths, v1 config)
│   └── contracts/                    # inference-adapter, canonical-messages, provider-config, credential-store, server-management-api, public-sdk
├── Website Planning/                 # Public website strategy and delivery planning
│   ├── implementation_planv0.1.md    # Original kinetic-design exploration
│   ├── implementation_planv0.2.md    # Benchmark and product-strategy iteration
│   ├── implementation_planv0.3.md    # Universal-scenarios iteration
│   └── plan.md                       # Consolidated, evidence-led website master plan
├── Provider-Management/              # LLM provider notes (incl. llm-provider-management-comparison.md — the architectural guideline for 010)
├── System-Prompts/                   # Prompt engineering references
├── Seepientagent-BMI/                # Body-model internal feature work
└── Todo/                             # Internal todos / scratch
    ├── deferred-tui-items.md         # TUI backlog
    └── homebrew-json-gem-fix.md      # Runbook: Homebrew 6.0 + json gem crash fix (arm64)
```

**Conventions:**
- Top level holds cross-cutting references (`Architecture/`, `Provider-Management/`, `System-Prompts/`, etc.); per-feature work lives under `Implementation-Specs/`.
- Each spec gets a numbered folder (`NNN-kebab-name/`) with the standard files above. Not every file is required — create what the spec needs, in this style.
- New top-level areas (e.g. a `Decisions/` or `Roadmaps/` folder) should be added here when first created.

**Maintenance — keep this map in sync.** This tree is the agent's contract for what to expect in the vault. When you add, remove, rename, or restructure vault files/directories, update this tree in the same change. If unsure of the current state, verify with `find ~/Documents/Obsidian/Seepient -type f | sort`.

## Project repo — consumer-facing documentation

Consumer-facing documentation stays in the repo, alongside the code:

- Documentation websites (e.g. a VitePress site)
- User guides, examples, onboarding material
- `README.md`, `CHANGELOG.md`, and operational files

Code and operational files always stay in the repo; only internal/engineering/management prose moves to the vault.

# Architecture

Full architectural reference: `ARCHITECTURE.md` in the project root.

## Layers — six responsibilities, one dependency direction

```
UI → Transport → Domain → Capabilities → Vendors
           ↘________________↗
        Foundations (importable by any layer, imports from no one)
```

| Layer | Path | Job |
|-------|------|-----|
| **UI** | `src/ui/` | What the user sees: TUI, REPL, CLI args |
| **Transport** | `src/transport/` | Validate, auth, config resolution, delegate to Domain. No business logic |
| **Domain** | `src/domain/` | Product decisions: agent loop, permissions, hooks, middleware, streaming, sessions, settings, prompts |
| **Capabilities** | `src/capabilities/` | Stable internal APIs: LLM providers, tools, skills, gateway, tokenizer |
| **Vendors** | `src/vendors/` | Third-party SDK wrappers, quarantined |
| **Foundations** | `src/foundations/` | Shared types, errors, contracts, settings-schema, hashline, persistence |

**Hard rules:** no layer-skipping, no importing upward, no `utils/` grab-bag; no service-SDK import outside `src/vendors/`; sibling capabilities never import each other (shared vocabulary moves to `foundations/contracts/`); kebab-case file/folder names everywhere. UI frameworks (Ink, React, Commander, ws, figlet) are the sanctioned substrate of `ui/`.

**Composition roots** may wire across all layers — for wiring only, no logic. Sanctioned roots: CLI (`src/ui/cli/index.ts`, `src/transport/cli/bootstrap.ts`, `agent.ts`), TUI (`src/ui/tui/index.tsx`, `hooks/use-agent.ts`), REPL (`src/ui/repl/repl.ts`), Server (`src/transport/http/index.ts`, `server-core.ts`, `standalone.ts`), SDK (`src/transport/sdk/index.ts`, `seepient.ts`). Tolerated type-only edges: transport commands importing `SkillRegistry`/`Target` types, `rest-gateway.ts` gateway types.

## Key Files

| Concern | File | Notes |
|---------|------|-------|
| Agent loop | `src/domain/agent-loop.ts` | Single execution engine for all adapters |
| Core types | `src/foundations/types.ts` | Messages, tools, hooks, agents, sessions |
| Error hierarchy | `src/foundations/errors.ts` | `SeepientError` with `code` + `retryable` |
| Contracts | `src/foundations/contracts/` | `ToolModule`, `Middleware`, presentation contracts |
| Settings schema | `src/foundations/settings-schema.ts` | 22 dot-key settings, validation, env vars |
| Config + models | `src/foundations/config.ts` + `models-catalog.ts` | Merge layers + catalog metadata accessors |
| Hashline | `src/foundations/hashline/` | Hash-anchored patch language: grammar, parser, patcher, snapshots |
| Tool executor | `src/domain/tool-executor.ts` | Registry, `tool()` factory, `resolveTools()`, groups |
| Permission system | `src/domain/permissions/` | Single policy engine, action lifecycle, approval broker, consent modes, and audit logging |
| Hooks | `src/domain/hooks.ts` | Safe executor — errors never crash the loop |
| Middleware pipeline | `src/domain/middleware/` | `compose()` chain: logging, rate-limit, auth, semantic-tools |
| Skill orchestration | `src/domain/skills/skill-invoker.ts` + `skill-catalog.ts` | Fill args, build prompt, switch provider |
| Streaming | `src/domain/streaming/` | Shared queue, async iterables, SSE |
| Sessions | `src/domain/sessions/session-store.ts` | `PersistenceBackend` factory + registry |
| Settings manager | `src/domain/settings/settings-manager.ts` | get/set/reset/list, persistence, masking |
| Provider runtime | `src/domain/providers/` | Runtime, config store, credential store, resolver, catalog |
| Provider controller | `src/transport/cli/provider-manager-api.ts` | Single semantic core for provider/account/slot management |
| Model manager dock | `src/ui/tui/overlays/model-manager.tsx` + `model-manager/` | Multi-tab TUI dock: purpose board, accounts, catalog browse, search (state hook, tabs, dialogs) |
| Model picker | `src/ui/tui/components/model-picker.tsx` | Search & filter model selector with reachability & pricing badges |
| Add account flow | `src/ui/tui/components/add-account.tsx` | Multi-credential account configuration (paste, env, none, oauth) |
| Setup wizard | `src/ui/tui/setup-wizard.tsx` | First-run onboarding wizard with preset bundles & slot recommendations |
| OAuth adapter | `src/vendors/pi-ai/pi-auth-adapter.ts` | Pi AI OAuth flow bridge over Seepient CredentialStore |
| Context accounting | `src/domain/context/` | Context-breakdown, message-convert |
| Inference adapters | `src/capabilities/inference/` | `AggregateInferenceAdapter` vendor routing |
| Tools | `src/capabilities/tools/` | 15 built-in tool modules: shell, files, web, email, widgets, todos… |
| Skills storage | `src/capabilities/skills/` | Registry, loader, parser, resolver, args |
| Gateway | `src/capabilities/gateway/` | MCP/OpenAPI client, scorer, tool factory |
| Tokenizer | `src/capabilities/tokenizer/` | `countTokens()` via `gpt-tokenizer` wrapper |
| System prompts | `src/domain/prompts/system-prompts.ts` | Interactive vs non-interactive |
| CLI UI entry | `src/ui/cli/index.ts` | Commander setup; dispatches TUI vs REPL |
| TUI | `src/ui/tui/` | Ink/React: components, widgets, diff, overlays, logo |
| REPL | `src/ui/repl/repl.ts` | Readline fallback, non-interactive / piped |
| CLI transport | `src/transport/cli/` | Bootstrap, setup, agent, config-loader, commands |
| HTTP transport | `src/transport/http/` | REST handlers, `provider-management/` routes (accounts, assignments, oauth, catalog), `runSeepientServer` server core, standalone |
| WebSocket | `src/transport/ws/` | Dispatcher (`ws-handlers.ts`), `connection-registry.ts`, message handlers (`chat`, `approvals`, `provider-mutations`, `session-control`) |
| Auth | `src/transport/auth/` | API keys + scopes |
| SDK transport | `src/transport/sdk/` | `createSeepient`, `askSeepient` (one-shot, streaming via `stream: true`), option resolution |

Unified provider architecture behind `ProviderRuntime` (`src/domain/providers/provider-runtime.ts`) and `AggregateInferenceAdapter` (`src/capabilities/inference/aggregate-adapter.ts`):

- **Inference Adapters**: Composable vendor backends (`PiLanguageRaw`, `PiImageRaw`, `GoogleImageRaw`, `OpenAIImageRaw`, `OmpCatalogSource`) under `src/vendors/`.
- **Purpose × Tier Routing**: Standard, complex, efficient tiers across language, vision, plan, commit, and image purposes.
- **Model Resolution**: Policy-driven selection over the community catalog (`@earendil-works/pi-ai` 0.84.2 + `@oh-my-pi/pi-catalog` lazy enrichment). Zero self-maintained model lists.

## Tools

15 built-in tools in 4 tiers (`src/capabilities/tools/`):

- **Core**: `execute_shell_command`, `read_file`, `write_file`, `get_current_datetime`
- **Comm**: `send_email`, `web_search`, `send_notification`
- **Advanced**: `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill`
- **Presentation**: `manage_todos` — drives the TUI's persistent task panel

Custom tools: `tool({ description, parameters, execute })` → `ToolModule` registered via `registerTool()`.

## Skills

File-based plugin system (`src/capabilities/skills/`). YAML frontmatter + body. Skills can specify allowed tools, preferred provider/model, and template args. Discovery from multiple sources with priority (last wins): bundled → `~/.agents/skills/` → `~/.seepient/skills/` → `/mnt/skills` → `.seepient/skills/` → `SEEPIENT_SKILLS_PATH`.

Domain orchestrates skill loading via `src/domain/skills/skill-invoker.ts` and `src/domain/skills/skill-catalog.ts`.

## Configuration

Multi-layer merge (highest wins): env vars → local `.seepient/setting.json` → global `~/.seepient/setting.json` → defaults. Managed by `src/domain/settings/settings-manager.ts`; schema in `src/foundations/settings-schema.ts`.

Inference credentials resolve only from provider management (setup wizard, `seepient auth login`, injected stores) — 022-5 demolished env-key synthesis; Seepient never reads provider API keys from the environment.

## Conventions

- **No bundler** — plain `tsc` to ES2022 NodeNext. Dev via `tsx`.
- **Package exports** — `seepient` (SDK), `seepient/server`. Binaries: `seepient` (CLI), `seepient-server`.
- **Vitest test suite** — 1370+ tests across 160 files; CI gates publish on test pass
- **Errors carry metadata** — `code` (machine-readable) + `retryable` flag on all `SeepientError` subclasses.
- **Hook errors are non-fatal** — never crash the agent loop.
- **Dynamic provider imports** — unused provider SDKs stay out of memory.
- **One-way dependency flow** — UI → Transport → Domain → Capabilities → Vendors. Foundations imported by all.

## Known Gaps

- Gateway registration (`src/capabilities/gateway/index.ts`) imports from Domain's `tool-executor` — should be wired at the composition root
- `use_skill` tool imports Skills internals directly — activation should be owned by Domain's skill invoker
- No automated layer-boundary lint enforcement yet — vendor quarantine and import-direction rules are aspirational
<!-- dgc-policy-v11 -->
# Dual-Graph Context Policy

This project uses a local dual-graph MCP server for efficient context retrieval.

## MANDATORY: Always follow this order

1. **Call `graph_continue` first** — before any file exploration, grep, or code reading.

2. **If `graph_continue` returns `needs_project=true`**: call `graph_scan` with the
   current project directory (`pwd`). Do NOT ask the user.

3. **If `graph_continue` returns `skip=true`**: project has fewer than 5 files.
   Do NOT do broad or recursive exploration. Read only specific files if their names
   are mentioned, or ask the user what to work on.

4. **Read `recommended_files`** using `graph_read` — **one call per file**.
   - `graph_read` accepts a single `file` parameter (string). Call it separately for each
     recommended file. Do NOT pass an array or batch multiple files into one call.
   - `recommended_files` may contain `file::symbol` entries (e.g. `src/auth.ts::handleLogin`).
     Pass them verbatim to `graph_read(file: "src/auth.ts::handleLogin")` — it reads only
     that symbol's lines, not the full file.
   - Example: if `recommended_files` is `["src/auth.ts::handleLogin", "src/db.ts"]`,
     call `graph_read(file: "src/auth.ts::handleLogin")` and `graph_read(file: "src/db.ts")`
     as two separate calls (they can be parallel).

5. **Check `confidence` and obey the caps strictly:**
   - `confidence=high` -> Stop. Do NOT grep or explore further.
   - `confidence=medium` -> If recommended files are insufficient, call `fallback_rg`
     at most `max_supplementary_greps` time(s) with specific terms, then `graph_read`
     at most `max_supplementary_files` additional file(s). Then stop.
   - `confidence=low` -> Call `fallback_rg` at most `max_supplementary_greps` time(s),
     then `graph_read` at most `max_supplementary_files` file(s). Then stop.

## Token Usage

A `token-counter` MCP is available for tracking live token usage.

- To check how many tokens a large file or text will cost **before** reading it:
  `count_tokens({text: "<content>"})`
- To log actual usage after a task completes (if the user asks):
  `log_usage({input_tokens: <est>, output_tokens: <est>, description: "<task>"})`
- To show the user their running session cost:
  `get_session_stats()`

Live dashboard URL is printed at startup next to "Token usage".

## Rules

- Do NOT use `rg`, `grep`, or bash file exploration before calling `graph_continue`.
- Do NOT do broad/recursive exploration at any confidence level.
- `max_supplementary_greps` and `max_supplementary_files` are hard caps - never exceed them.
- Do NOT dump full chat history.
- Do NOT call `graph_retrieve` more than once per turn.
- Do NOT use npm to install dependencies. Use pnpm instead.
- After edits, call `graph_register_edit` with the changed files. Use `file::symbol` notation (e.g. `src/auth.ts::handleLogin`) when the edit targets a specific function, class, or hook.

## Context Store

Whenever you make a decision, identify a task, note a next step, fact, or blocker during a conversation, call `graph_add_memory`.

**To add an entry:**
```
graph_add_memory(type="decision|task|next|fact|blocker", content="one sentence max 15 words", tags=["topic"], files=["relevant/file.ts"])
```

**Do NOT write context-store.json directly** — always use `graph_add_memory`. It applies pruning and keeps the store healthy.

**Rules:**
- Only log things worth remembering across sessions (not every minor detail)
- `content` must be under 15 words
- `files` lists the files this decision/task relates to (can be empty)
- Log immediately when the item arises — not at session end

## Session End

When the user signals they are done (e.g. "bye", "done", "wrap up", "end session"), proactively update `CONTEXT.md` in the project root with:
- **Current Task**: one sentence on what was being worked on
- **Key Decisions**: bullet list, max 3 items
- **Next Steps**: bullet list, max 3 items

Keep `CONTEXT.md` under 20 lines total. Do NOT summarize the full conversation — only what's needed to resume next session.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
- **ACTIVE SPEC (027 — branch 027-serverless-chat-core IMPLEMENTED
  2026-10-07 + post-implementation-review repair round LANDED; 18/21
  tasks TRUE, 3 PARTIAL (T007 align-not-remove, T015/T016 ratified
  mechanisms — see task notes); gates green — suite + probes 11/11,
  boundary:check (orphan mode), pack:verify (core closure MEASURED 102MB
  ≤150; post-split full closure 301MB), qs:core-chat e2e green in CI;
  next: /release-gate in a fresh session, then the owner confirms
  NPM_TOKEN scope covers a second package name before tagging v0.9.0;
  review: Reviews/2026-10-07-post-027-implementation-review.md (🔴 not
  ready → repair round: P0-1 release build entry, P1-1 exact-BPE arming,
  P1-2 README construction, P1-3 read-only-HOME defaults + red gate,
  P1-4 e2e in CI, P2/P3 register)):**:
  `~/Documents/Obsidian/Seepient/Implementation-Specs/027-serverless-chat-core/plan.md`
  — serverless chat core package split: new slim `seepient-core` npm package
  (chat/agent engine; deps = pi-ai + typebox only; ≤150MB closure gate) with
  the full `seepient` package unchanged, consuming the engine via pnpm
  workspace; FIVE seams after the red team caught the dynamic-edge undercount
  (tools injection, tokenizer heuristic fallback, media/image registration,
  provider-SDK dedupe incl. anthropic — derived from pi-ai pins, and
  execution-pipeline injection: core default = light pipeline, boundary
  injected by full); core entry is a NEW file (today's sdk/index.ts
  re-exports full modules); dynamic-aware comment-stripping tracer +
  per-package pack:verify (npm-pack fallback deleted); lockstep dual publish
  (core-first pnpm publish, first-release bootstrap, tag-re-run recovery,
  dry-run mutation fix). Phantom createStatelessAgent corrected to
  createSeepient({stateless}) + chatStream method + askSeepient (all in
  core) PLUS createChat — the owner-approved multi-turn front door
  (send/stream/messages, thin sugar over the stateless agent; the single
  deliberate new API shape). Red team:
  Reviews/2026-10-07-027-pre-implementation-red-team.md
  (5 lenses; RT-1..RT-18 + ponytail net-cut folded; all six owner OQs
  answered 2026-10-07). 21 tasks ≈4.5 days.
- Prior train: 026 pi-ai 1.0 image port IMPLEMENTED (rides v0.8.2).
<!-- SPECKIT END -->
