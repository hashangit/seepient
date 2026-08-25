---
name: repo-review-ultra-deep
description: >-
  Ultra-deep, evidence-backed repository and PR review (v5.4.2). Performs comprehensive audits across architecture, security, reliability, performance, observability, and maintainability with exact code citations [E#], minimal diffs, verification commands, Mermaid diagrams, and migration/rollback roadmaps. Trigger on /repo-review-ultra-deep, or when asked for a deep repo review, comprehensive codebase audit, architecture review, greenfield redesign review, or PR/diff audit.
---

# Repo Review Ultra-Deep (v5.4.2)

Execute a decision-ready, evidence-backed, ultra-deep repository or PR review. For greenfield projects or major overhauls, backward compatibility is not required—propose breaking changes and redesigns if they materially improve quality. Deliver precise diffs/snippets, prioritized recommendations, verification artifacts, and migration/rollback-aware roadmaps.

## 1. Instruction Hierarchy & Core Principles

- **Hierarchy**: System > Developer > User. If a lower layer conflicts with a higher one, record it in *Methods & Limitations* and resolve using prioritization order.
- **Evidence Over Opinion**: Base all claims on concrete repo artifacts (paths, lines, commits). Tag claims with `[E#]` evidence markers. Do not invent code or behavior.
- **P0 Rigor**: All P0 items MUST have direct code evidence and ≥2 independent verification methods (e.g., static analysis + targeted test). Downgrade severity with explicit rationale if this bar is not met.
- **Honor Documented Decisions**: Check ADRs, RFCs, and `ARCHITECTURE.md`. If a finding conflicts with an existing ADR, acknowledge the context and propose an ADR-respecting alternative or updated decision.
- **Installation & Supply Chain Integrity**: Verify reproducible installs, lockfiles, pinned digests, and supply chain security with concrete validation commands.
- **Safe, Reversible Changes**: Propose safe, reversible changes first; provide rollback plans for impactful changes.
- **Preserve Existing Style**: Respect existing conventions and "blend in" unless intentionally redesigning.

---

## 2. Autonomy & Review Type Detection

- **Autonomy**: Operate with high autonomy. Ask zero clarifying questions unless safety, legal/compliance, or irreversible actions are at stake. Otherwise, proceed with reasonable assumptions and document them.
- **Review Type Detection**: Classify review as **Breadth-first** (full audit), **Depth-first** (targeted hotspot/subsystem), or **Hybrid**. Justify the classification and sequencing in 2–4 bullets.

---

## 3. Planning Preamble

Emit this assessment before deep analysis (do not pause for user approval):

1. **Assessment & Breakdown**:
   - Objective & success criteria ("what good looks like").
   - Architecture map (components, services, modules), languages & frameworks.
   - Build/test/CI, deployment/runtime, datastores, and external dependencies.
   - Scope & constraints (environments, OS/arch, security posture, compliance).
   - Business impact mapping: infer objectives/KPIs and map top user journeys to business outcomes; state risk tolerance.
   - Detect canonical Build / Run / Test / Type / Lint commands (or propose a minimal Runbook/Makefile).
   - Deliverable expectations and assumption log.
2. **Review Type Determination**: (Breadth / Depth / Hybrid + justification).
3. **Work Plan**: Parallel/sequential tracks with dependency ordering.

---

## 4. Verbosity Modes

- **brief**: Focus on TL;DR and Summary; material-only gaps in Best Practices; full P0/P1 details with P2 compressed to grouped bullets with `[E#]` patterns; 1 representative E2E trace and journey outline.
- **balanced** (Default): Full deliverables with concise narrative, trimmed diffs, and complete matrices.
- **detailed**: Expanded verification artifacts, complete diffs, multiple E2E traces, full journey test outlines, and trade-off rationales across all items.

---

## 5. Parallel Workstreams & Audit Dimensions

Decompose review into parallel tracks:

1. **Security, Privacy & Supply Chain**: Input validation, authN/Z, cryptography, secret leakage, dependency vulnerabilities, SBOM, image hardening, OWASP/CWE mapping.
2. **Reliability, Availability & Data Integrity**: Error handling, retries, circuit breakers, idempotency, transaction boundaries, state leaks, concurrency/race conditions.
3. **Performance & Scalability**: I/O bottlenecks, async hygiene, caching, database indexing, memory allocations, connection pooling.
4. **Observability & Operability**: Structured logging, correlation/trace IDs, metrics, health/readiness probes, alerts, runbooks.
5. **Maintainability & Developer Experience**: Layering violations, modularity, test quality/determinism, CI/CD pipelines, dead code / deprecations.
6. **Portability & Interoperability**: OS/arch assumptions, API contracts, standards compliance.
7. **Accessibility & UX**: (If client/UI applicable) a11y, semantic markup, user feedback states.
8. **Cost Efficiency & Sustainability**: Compute utilization, idle resources, egress costs.
9. **Gap-Closing Tracks**: Licenses/compliance, DR/BC, i18n/l10n as relevant.

---

## 6. Deep Verification & Trace Protocols

### A. Stack Profile & Best-Practices Compliance
Detect runtime/framework versions from manifests and evaluate against modern stack best practices (e.g., TS strict mode, Express security headers/rate limiting, Go context timeouts, Docker non-root/pinned digests, Terraform state hardening).

### B. Logic & Semantic Checks
- Define pre/postconditions, invariants, and edge-case matrices for critical paths.
- Check for missed branches, off-by-one errors, resource leaks, and race conditions.
- Compare behavior against documented contracts (specs/API/README).

### C. End-to-End Tracing & Journey Validation
- Trace at least one full entrypoint path (HTTP/CLI/Worker).
- Generate a **Mermaid sequence diagram** (`component -> function -> deps`) with `[E#]` citations.
- Enumerate primary user journeys with preconditions, step verification, and executable test outlines.

### D. Redundancy & Safe Deprecation Protocol
1. Mark candidate dead code / deprecated dependencies with reference scans and call graphs.
2. Provide **guard tests** proving that existing public contracts pass and the candidate is unneeded.
3. Provide CI gating snippet (YAML/config) to block merge on failure.
4. Safe 4-step removal protocol: Deprecate -> Replace call sites -> Soft-delete/flag -> Final deletion + lint rule.

### E. Debt Register
Tabulate tech debt with columns: Name, Category, Impact, Effort, Dependencies, ROI, and sequenced refactoring recommendations.

---

## 7. Deliverables Format

Deliver the review using structured Markdown following this layout:

```markdown
# Repository Review (Ultra-Deep)

## 0. TL;DR
- P0/P1 Counts: [P0: X, P1: Y, P2: Z]
- Top Themes & Highest-Risk Areas
- Immediate First Actions

## 1. Summary & Planning Preamble
- Review Type & Justification (Breadth / Depth / Hybrid)
- Stack Profile & Detected Canonical Commands
- Core Intent & Architecture Map (with Mermaid C4/System diagram)
- Assumptions & Safety/Compliance notes

## 1a. Best-Practices Compliance Matrix
| Area | Best Practice | Status | Evidence [E#] | Proposed Diff / Verification |
| :--- | :--- | :--- | :--- | :--- |

## 2. Prioritized Recommendations
<!-- For each item: -->
### [P0/P1/P2] <Title>
- **Category**: Security | Reliability | Performance | Observability | Maintainability
- **Evidence [E#]**: `path/to/file.ext:lines` (Commit short-SHA)
- **Rationale & Impact**: Metric/SLO/benefit
- **Effort & Risk**: (H/M/L) + ≥2 alternatives considered with trade-offs
- **Proposed Change**:
```diff
- old
+ new
```
- **Disproof Attempts**: What was tested to falsify the finding
- **Verification Artifacts & Commands**:
  - Independent check 1: (e.g. static analyzer / typecheck)
  - Independent check 2: (e.g. failing-then-passing test snippet)
  - CLI command: `pnpm test path/to/test.ts`
- **OWASP/CWE**: (If applicable)
- **Confidence**: High | Medium | Low (with reasoning)

## 3. End-to-End Traces & Critical Journeys
- Entrypoint Call Graph & Analysis
- Mermaid Sequence Diagram

## 4. Journey Validation & Test Outlines
- Happy-path journeys & brittleness analysis
- Executable test snippets

## 5. Redundancy & Deprecation Register
- Dead code / deprecated APIs with guard tests & CI gate snippets

## 6. Technical Debt Register & Refactoring Roadmap
- Debt table with ROI and sequencing
- Strategic multi-day refactoring proposals with rollback plans

## 7. Documentation & Semantic Alignment
- Mismatches between documentation and actual implementation with doc diffs

## 8. Methods, Limitations & Final Contradiction Pass
- Repository snapshot (HEAD SHA, runtime versions)
- Clean-room re-evaluation confirmations
```

---

## 8. Self-Check & Quality Gate Before Finalizing

Before emitting final output:
1. **P0 Bar**: Ensure every P0 has direct `[E#]` code evidence and ≥2 independent verification methods.
2. **Contradiction Scan**: Scan across all recommendations and sections to verify no conflicting advice is given.
3. **PR Diff Mode**: If reviewing a PR/diff input, narrow scope to changed files and direct dependencies while maintaining all deliverable sections and verification rigor.
