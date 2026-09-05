---
title: Security and sandbox overview
description: Threat model, security invariants, and the monotonic 4-layer permission pipeline.
---

# Security and sandbox overview

Autonomous AI agents introduce risks that traditional software avoids. When a model authoring code has shell access and file write capabilities, minor hallucinations or malicious prompt injections can lead to catastrophic data loss or credential leaks.

Seepient treats security as a core architectural constraint rather than an optional add-on. Every action is gated by a monotonic four-layer pipeline.

<DiagramFlow numbered
  :steps="[
    { title: 'Policy Engine', note: 'Computes the monotonic capability ceiling' },
    { title: 'Approval Broker', note: 'Gathers human confirmation or verifies pre-grants' },
    { title: 'Execution Boundary', note: 'Runs inside an OS jail (Seatbelt / Bubblewrap)' },
    { title: 'Audit Recorder', note: 'Appends an fsync record to the 0600 ledger' }
  ]"
/>
---

## Core security invariants

1. **Monotonic capability intersection**: Permissions only narrow as they flow inward. No inner component, tool module, or model instruction can expand an outer ceiling set by configuration or policy.
2. **Separation of policy, approval, and execution**: The component deciding whether an action is permissible (`PolicyEngine`) does not display user prompts, and the component gathering confirmation (`ApprovalBroker`) does not execute commands.
3. **No unguarded write fallback**: All model-authored file modifications require exact pre-image hash verification via the compiled native Rust helper (`native/fs-commit`). If the native helper is unavailable on an unsupported platform (such as native Windows), writes are refused before approval.
4. **Secret isolation from execution workers**: The process holding LLM provider credentials is not the process executing shell commands. In distributed mode, workers run with zero provider keys.
5. **Fail-closed default**: If a sandbox binary is missing, an approval file is corrupted, or a pre-image hash fails to match, execution aborts immediately.

---

## Threat model

Seepient protects against four primary threat vectors:

### 1. Indirect prompt injection
An untrusted webpage, issue description, or git commit message contains adversarial instructions attempting to exfiltrate environment variables, run destructive commands (such as `rm -rf /`), or curl remote servers. 
*Defense*: The permission engine and OS sandbox block access to sensitive host files, and the secret shield redacts tokens from outgoing network requests.

### 2. File modification hallucinations
A model hallucinates line offsets, truncates large files during edits, or replaces code outside the user's intent.
*Defense*: The atomic commit broker requires exact target search block matching against a pre-image SHA-256 hash before applying mutations.

### 3. Privilege creep in long-running sessions
An agent gradually attempts wider operations after being granted permission for a smaller task.
*Defense*: Capabilities have strict lifetimes and scopes. A grant to edit `src/utils.ts` does not authorize editing `package.json` or running bash scripts.

### 4. Self-evolution attacks
A model attempts to disable security checks, alter approval files, or tamper with the audit log.
*Defense*: Self-change guard rules reject any model-authored modification targeting Seepient configuration directories, security source files, or audit logs.
