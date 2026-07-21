/**
 * P3/P5 TUI self-evolution status tests (spec 008, T308, QS-5.4).
 *
 * Verifies the deterministic status rendering:
 *  - delegated routine candidate shows supervisor + ready activation
 *  - protected (security-kernel) shows "authority required" + cannot-self-attest
 *  - absent supervisor shows "verified-pending-activation" (no fallback implication)
 *  - verification evidence renders per-check pass/fail
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { SelfEvolutionStatus } from "../components/self-evolution-status.js";
import type { ChangeProposal } from "../../../foundations/contracts/self-evolution.js";

function proposal(overrides: Partial<ChangeProposal> = {}): ChangeProposal {
  return {
    proposalId: "prop_1",
    parentArtifactDigest: "parent-sha-1234567890abcdef",
    candidateArtifactDigest: "cand-sha-1234567890abcdef",
    changeClasses: ["application-code"],
    changedPaths: ["/cand/x.ts"],
    authorRunId: "run-1",
    verification: [
      { checkId: "unit", state: "passed", evidenceDigest: "ev1", workerId: "w1", completedAt: 0 },
      { checkId: "integration", state: "passed", evidenceDigest: "ev2", workerId: "w1", completedAt: 0 },
    ],
    requestedActivation: true,
    ...overrides,
  };
}

describe("SelfEvolutionStatus (T308)", () => {
  it("delegated routine candidate shows supervisor + ready activation", () => {
    const { lastFrame } = render(
      <SelfEvolutionStatus
        proposal={proposal()}
        classification={{ status: "delegated", rule: { supervisorId: "sup-1" } }}
        activationStatus="accepted"
        supervisorConfigured={true}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Self-maintenance candidate");
    expect(out).toContain("sha256:cand-sha-123456");
    expect(out).toContain("delegated");
    expect(out).toContain("sup-1");
    expect(out).toContain("unit:✓");
    expect(out).toContain("integration:✓");
  });

  it("protected (security-kernel) shows authority required + cannot self-attest", () => {
    const { lastFrame } = render(
      <SelfEvolutionStatus
        proposal={proposal({ changeClasses: ["security-kernel"] })}
        classification={{ status: "protected", protectedClasses: ["security-kernel"] }}
        supervisorConfigured={true}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("protected");
    expect(out).toContain("authority required");
    expect(out).toContain("cannot replace active trusted state");
  });

  it("absent supervisor shows verified-pending-activation (no fallback)", () => {
    const { lastFrame } = render(
      <SelfEvolutionStatus
        proposal={proposal()}
        classification={{ status: "needs-attestation" }}
        supervisorConfigured={false}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("verified-pending-activation");
    expect(out).toContain("no supervisor configured");
  });

  it("disallowed classification is rendered", () => {
    const { lastFrame } = render(
      <SelfEvolutionStatus
        proposal={proposal()}
        classification={{ status: "disallowed", disallowedClasses: ["dependencies"] }}
        supervisorConfigured={false}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("disallowed");
    expect(out).toContain("dependencies");
  });

  it("failed verification check is marked ✗", () => {
    const { lastFrame } = render(
      <SelfEvolutionStatus
        proposal={proposal({
          verification: [
            { checkId: "unit", state: "passed", evidenceDigest: "ev", workerId: "w", completedAt: 0 },
            { checkId: "security", state: "failed", evidenceDigest: "ev", workerId: "w", completedAt: 0 },
          ],
        })}
        classification={{ status: "delegated", rule: {} }}
        supervisorConfigured={true}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("unit:✓");
    expect(out).toContain("security:✗");
  });
});
