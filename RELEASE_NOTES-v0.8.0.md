# Seepient 0.8.0

Seepient 0.8.0 is the multi-tenant release. One process can now serve many principals through the standalone server, the SDK, or the reference worker, and every principal gets its own sessions, approvals, policy verdicts, audit trail, and capability grants. The operator's own configuration, credentials, and skills stay out of tenant reach unless you explicitly compose them in.

This release closes out the 022 hardening train: six specs (022, 022-1 through 022-5) and four remediation work orders, verified by fifteen adversarial review passes in which reviewers attacked the shipped tree with live proofs rather than checklists. The release label is defensible with caveats, and the caveats are printed below rather than buried.

## What multi-tenant means now

- **Isolated by construction.** A provider runtime built with no arguments is isolated and in-memory, and the in-memory store classes (audit, policy, capability ledger, replay ledger) carry the isolated stamp. The ambient disk stores (`LocalAuditStore`, `LocalPolicyStore`, `PersistedCapabilityLedger`) remain single-user stores for local-operator roots; multi-tenant hosts reject them with `TENANCY_STORE_INCOMPLETE`. Host dotfiles, host environment variables, and the operator's skills directory are invisible to tenant execution unless a local-operator root explicitly composes `createAmbientProviderRuntime()`. In multi-tenant mode, ambient discovery is disabled, not filtered.
- **Principal-scoped everything.** Sessions, audit records, policy stores, capability ledgers, and approval records key on the authenticated principal. Session storage keys are `apiKeyHash:sessionId`, so tenants sharing a session id can never read, list, evict, or squat each other's sessions. `principalId` is slug-validated at the ingestion edge, which makes path traversal through identity parameters structurally impossible.
- **Credentials fail closed.** A tenant tool that needs a secret and did not get one denies with `CREDENTIAL_REQUIRED` instead of resolving the host's API keys. Vendored client libraries are pinned so ambient env vars can neither supply nor redirect stored credentials.
- **Injectable state, injectable skills.** Hosts inject audit, policy, ledger, session, and credential stores; skills come from injected `SkillSource`s (filesystem layers, database-backed, or inline literals) with strict last-wins composition. The generated-skill write path targets the embedder's store or fails closed with `SKILL_STORE_UNAVAILABLE`, so SDK runs never write to host disk.
- **The reference worker is hardened.** Control-plane principals derive exclusively from authenticated tokens, request bodies cannot re-bind identity, endpoints partition by composite principal-scoped keys, and the 1 MiB request-body cap destroys the connection the moment it trips.

## Breaking changes

Read these before upgrading. Each has a worked migration path in `docs/sdk/migration.md`.

1. **Environment variables no longer configure provider credentials.** Seepient no longer synthesizes provider accounts from env vars, and the `--credential env:` mode is gone from the CLI, TUI add-account, REST accounts API, and `auth login --env-var`. Migrate by running `seepient setup`, or `seepient auth login <account> --key <key>`, or by injecting a credential store from the SDK. If you want env-sourced keys as an embedder, you own that seam now.
2. **Multi-tenant embeds must stamp their runtimes.** `createSeepient` and `createTenantAgent` in multi mode refuse an injected runtime without the `tenancyMode: "multi"` stamp (`TENANCY_RUNTIME_REQUIRED`). Construct with `createIsolatedProviderRuntime({ tenancyMode: "multi", ... })`. The refusal replaces an earlier behavior where an unstamped runtime silently ran without egress enforcement.
3. **Multi-tenant construction requires explicit completeness.** `tenancy: "multi"` demands an explicit `principalId` (`PRINCIPAL_REQUIRED`), a non-empty `cwd` (`TENANCY_WORKSPACE_REQUIRED`), and isolated stamps on every injected store (`TENANCY_STORE_INCOMPLETE`). Chat edges accept tool names only (`string[]`); passing tool objects is rejected at the boundary.
4. **Construction defaults inverted.** `new ProviderRuntime()` used to bind the host's dotfiles; it is isolated and in-memory now, and the legacy default runtime export is deleted with no compatibility shims. Local single-user scripts that want ambient behavior call `createAmbientProviderRuntime()` explicitly, and a script that injects any runtime must declare `tenancy: "single"` to stay single-user.
5. **The standalone server derives its egress baseline from the providers file.** Boot with `--providers-file` and each configured account's scheme, host, and port is granted at boot and printed in the boot notice. A provider admin key can no longer point a stored credential at an ungranted host: `baseUrl` mutations and model refreshes deny with `EGRESS_REQUIRED` before any request or DNS lookup. Accounts on default vendor endpoints are unaffected.
6. **Consent is deny-by-default.** Omitting `consentMode` denies unpredeclared effectful tools instead of running them. Pass an explicit mode such as `edit-enabled` or `autonomous`, or attach an approval broker.
7. **The server binds to loopback by default**, and `--docker` / `--headless` no longer imply auto-approve. Pass `--host 0.0.0.0` to expose the server; pass `-y` or configure the `autonomous` consent mode for unattended runs.
8. **New typed denials on the read plane.** A file whose identity changes between authorization and read denies with `PATH_IDENTITY_MISMATCH`; hardlinks that would reach outside the workspace deny with `PATH_HARDLINK_REFUSED`; symlinks whose target escapes the workspace ceiling deny with `PATH_ESCAPES_WORKSPACE` while in-workspace symlinks are now allowed, applied to the target's real path. Denial messages no longer echo resolved host paths.
9. **Sandboxed commands leave no daemons.** When a command settles, its whole process group is killed. A long-running process must live outside the sandbox boundary.
10. **Legacy SDK surfaces removed.** Global tool registration and execution, the connector catalog mutators, and implicit gateway tool registration are gone; tools and connectors are instanced per agent. Sentinel identity is unified to `sdk-user`, so a workspace holding old `cli-user` approvals needs one re-approval.

## Security work in this release

- **Authorize-what-you-open.** The read plane pins the authorized file's device and inode and verifies them against the opened file descriptor, so symlink swaps between authorization and execution, including parent-directory swaps, fail closed. FIFOs deny typed on every read surface instead of wedging the turn. Brokered network responses cap mid-stream at 10 MiB; a 300 MiB response that previously buffered to roughly 975 MB of process memory now rejects in milliseconds.
- **Egress is asserted, not assumed.** Provider refreshes, `baseUrl` mutations, and inference and image calls assert the destination against granted network capabilities before any traffic, on both the server and SDK planes, at every composition root. Ambient `OPENAI_BASE_URL` and `GOOGLE_GEMINI_BASE_URL` redirects are dead: client endpoints are pinned explicitly, and decoy tests prove the stored key never reaches a foreign sink.
- **Approvals are principal-bound and merge-safe.** Compare-and-set on the approval store is principal-scoped, a just-made decision survives a racing disk read, and one principal's "always allow" can no longer erase another principal's grants.
- **The test gate is adversarial by construction.** Mutation probes neutralize real production seams and fail if a seam disappears; registration lints tie every security journey to a probe target or an explicit counter-only declaration; the full suite exits with zero unhandled rejections.

## Honest caveats

The multi-tenant label ships as defensible with caveats:

- Arming refuses unstamped runtimes on both the server and SDK planes, so a misconfigured embed fails loudly at construction rather than running silently unguarded.
- The standalone server's egress allowance is limited to hosts derived from the providers file at boot.
- Known accepted risks remain on the register: the operator gateway tool channel and shared provider-plane questions are owned by the 024 security-remediation spec, and some in-memory stores are unbounded over very long uptimes. Before exposing a multi-tenant deployment to hostile traffic: isolate tenants per process or container at scale, leave the operator gateway channel off (it is default-off until the 024 hardening lands), and put memory limits on the server process.

## Upgrading

Start with `docs/sdk/migration.md`, which covers the inverted construction defaults, the env-key demolition, the multi-stamp requirement, and the store-stamp rules with before and after examples. `docs/server/deployment.md` documents the providers-file operator channel end to end, and `docs/sdk/multi-tenant.md` walks the embed shapes that the stamp check accepts.
