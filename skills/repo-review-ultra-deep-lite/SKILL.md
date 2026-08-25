---
name: repo-review-ultra-deep-lite
description: >-
  Fast, token-efficient, evidence-backed repository and PR review (v5.4.2 Lite). Performs rigorous audits across architecture, security, reliability, performance, and maintainability with exact code citations [E#], minimal diffs, verification commands, Mermaid diagrams, and migration roadmaps while optimizing for brevity and token context. Trigger on /repo-review-ultra-deep-lite, or when asked for a fast/lite ultra-deep repo review, PR review, or quick architectural audit.
---

# Repo Review Ultra-Deep Lite (v5.4.2)

Produce a decision-ready, evidence-backed review of the repository or PR. For greenfield projects or overhauls, backward compatibility is not required—propose breaking changes and redesigns if they materially improve quality. Deliver precise diffs/snippets, prioritized recommendations, verification artifacts, and a migration/rollback-aware roadmap.

## 1. Instruction Hierarchy & Core Principles

- **Hierarchy**: System > Developer > User. If a lower layer conflicts with a higher one, note it in *Methods & Limitations* and resolve using the prioritization order.
- **Evidence Over Opinion**: Base all claims on repo artifacts (paths, lines, commits). Tag claims with `[E#]` evidence markers. Do not invent code or behavior.
- **P0 Rigor**: P0 items require direct code evidence and ≥2 independent verifications (e.g., static scan + targeted test). If unmet, downgrade severity with explicit rationale.
- **Honor Documented Decisions**: Prefer ADRs, RFCs, and `ARCHITECTURE.md` for architectural context. If a finding conflicts, propose an ADR-respecting alternative or an ADR update.
- **Installation Integrity**: Prefer reproducible installs and secure supply chain (lockfiles, pinned versions/digests, verified installers); include validation commands.
- **Safe, Reversible Changes**: Propose safe, reversible changes first; include rollback for impactful changes.
- **Respect Style**: Adhere to repo conventions and "blend in" unless intentionally redesigning.
- **Keep Chain-of-Thought Private**: Output conclusions, evidence, diffs/snippets, verification artifacts, and confidence levels only.

---

## 2. Autonomy & Review Type Detection

- **Autonomy**: Operate with high autonomy; do not hand back early. Ask 0 clarifying questions unless safety, legal/compliance, or irreversible actions are at stake.
- **Review Type Detection**: Classify review as **Breadth-first** (full audit), **Depth-first** (focused), or **Hybrid** (2–4 bullets justifying classification and sequencing).

---

## 3. Planning Preamble

Emit before deep analysis (do not pause for approval):
1. **Assessment & Breakdown**:
   - Objective & success criteria (what "good" looks like).
   - Architecture map (components/services/modules), languages/frameworks.
   - Build/test/CI, deployment/runtime, data stores, external dependencies.
   - Scope/constraints (envs, OS/arch, security posture, compliance).
   - Canonical Build/Run/Test/Type/Lint commands (or propose minimal Runbook/Makefile).
   - Expected deliverables & assumption log (safety/compliance only).
2. **Review Type Determination**: (Breadth/Depth/Hybrid + brief justification).
3. **Work Plan**: Tracks with dependencies.

---

## 4. Verbosity Modes

- **brief**: Focus narrative on TL;DR and Summary; material gaps only in Best-Practices Matrix; full P0/P1 details with P2 compressed to grouped bullets with `[E#]` patterns; 1 representative E2E trace and journey outline.
- **balanced** (Default): Full deliverables with concise narrative; use representative diffs for repeated patterns.
- **detailed**: Expand verification artifacts (tests/commands/tool outputs); multiple E2E traces and fuller journey test outlines; short trade-off rationales even for P2 items.

---

## 5. Parallel Workstreams & Audit Dimensions

Define and, where feasible, run in parallel:
1. **Security, Privacy & Supply Chain**: AuthN/Z, secret leaks, input validation, dependency CVEs, image hardening, OWASP/CWE mapping.
2. **Reliability, Availability & Data Integrity**: Error handling, retries/timeouts, circuit breakers, idempotency, transactions, race conditions.
3. **Performance & Scalability**: I/O bottlenecks, async hygiene, caching, indexing, memory/connection pooling.
4. **Observability & Operability**: Structured logs, trace IDs, metrics, health probes, alerts, runbooks.
5. **Maintainability & Developer Experience**: Modularity, test determinism, CI/CD pipelines, dead code / deprecations.
6. **Portability & Interoperability**: OS/arch assumptions, API contracts, standards compliance.
7. **Accessibility & UX**: (If applicable) a11y, semantic markup.
8. **Cost Efficiency & Sustainability**: Compute utilization, idle resources, egress costs.
9. **Gap-Closing Tracks**: Licenses/compliance, DR/BC, i18n/l10n if relevant.

---

## 6. Verification Protocols & Analysis

### A. Stack Profile & Best-Practices Compliance
Evaluate manifests/configs against version-aware best practices (e.g., TS strict mode, Express security headers/rate limiting, Go context timeouts, Docker non-root/pinned digests, Terraform backend state hardening). Focus on material gaps only.

### B. Logic, Invariants & Semantic Alignment
- Define pre/postconditions and edge-case matrices for critical paths.
- Identify logic errors, race/deadlock risks, and semantic drift vs specs/tests.
- Recommend property-based tests or assertions for key invariants.

### C. End-to-End Tracing & Journey Validation
- Trace at least one representative full path (or one per entrypoint if small).
- Produce a textual call graph and a **Mermaid sequence diagram** (`component -> function -> deps`) with `[E#]` citations.
- Enumerate primary happy-path journeys with preconditions, step validation, and at least one executable test outline/snippet.

### D. Redundancy & Safe Deprecation Protocol
- Identify dead/unreachable code and deprecated APIs via reference scans, call-graph sampling, and lints.
- Add guard tests proving public contracts remain and candidate path/symbol is unused.
- Provide evidence, safe removal diffs, guard tests, and a short CI gating snippet.

### E. Debt Register
Tabulate tech debt (Name, Category, Impact, Effort, Dependencies, ROI) and provide sequenced refactoring recommendations.

---

## 7. Deliverables Layout

```markdown
# Repository Review (Ultra-Deep Lite)

## 0. TL;DR
- P0/P1 Counts: [P0: X, P1: Y, P2: Z]
- Top Themes & Highest-Risk Areas
- Immediate First Actions

## 1. Summary & Planning Preamble
- Review Type (Breadth / Depth / Hybrid + justification)
- Stack Profile & Canonical Commands
- Core Intent & Architecture Map (with Mermaid System diagram)
- Assumptions & Safety/Compliance notes

## 1a. Best-Practices Compliance Matrix
| Area | Best Practice | Status | Evidence [E#] | Proposed Diff / Verification |
| :--- | :--- | :--- | :--- | :--- |

## 2. Prioritized Recommendations
<!-- For P0/P1 items: -->
### [P0/P1] <Title>
- **Category**: Security | Reliability | Performance | Observability | Maintainability
- **Evidence [E#]**: `path/to/file.ext:lines` (Commit short-SHA)
- **Rationale & Impact**: Metric/SLO/benefit
- **Effort & Risk**: (H/M/L) + ≥2 trade-offs
- **Proposed Change**:
```diff
- old
+ new
```
- **Verification Artifacts & Commands**:
  - Independent check 1: (static scan / typecheck)
  - Independent check 2: (failing->passing test snippet)
  - Verification command: `pnpm test path/to/test.ts`
- **Confidence**: High | Medium | Low

<!-- For P2 items: group by pattern with representative evidence and resolution pattern -->

## 3. End-to-End Traces & Critical Journeys
- Representative Call Graph
- Mermaid Sequence Diagram

## 4. Journey Validation & Test Outlines
- Primary happy-path journeys & brittleness points
- Executable test snippets

## 5. Redundancy & Deprecation Register
- Candidate dead code / deprecated dependencies with guard tests & CI gate snippet

## 6. Technical Debt Register & Refactoring Roadmap
- Debt table with ROI and sequencing
- Strategic refactors (>1 day) with migration & rollback plans

## 7. Documentation Alignment
- Mismatches between documentation and actual implementation with diffs

## 8. Methods, Limitations & Final Sanity Pass
- Repo snapshot (SHA, versions)
- Clean-room re-evaluation confirmations
```

---

## 8. Quality Gate & Self-Check

- **P0 Bar**: Direct code evidence + ≥2 independent checks (static scan + test run).
- **Contradiction Scan**: Scan across all recommendations to confirm no conflicting advice.
- **PR Diff Mode**: If reviewing a PR/diff, focus on changed areas and immediate dependencies while maintaining all deliverable sections and verification rigor.
