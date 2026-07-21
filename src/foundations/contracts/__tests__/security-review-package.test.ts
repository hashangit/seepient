/**
 * T605 review-package structural test (spec 008, FR-020).
 *
 * Verifies the security-review package exists and covers every asset class
 * the spec requires. This is NOT the independent review itself — by spec
 * definition (FR-020), the authoring trust domain cannot self-attest a
 * security-kernel change. The reviewer signs their own attestation through
 * the ActivationSupervisor contract; this package is the input to that review.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../..");
const REVIEW = join(ROOT, "docs/security-review-008.md");

describe("security review package (T605)", () => {
  it("the review document exists", () => {
    expect(existsSync(REVIEW), `${REVIEW} must exist`).toBe(true);
  });

  it("the review document is authored for an independent reviewer (not a self-attestation)", () => {
    const text = readFileSync(REVIEW, "utf8");
    // The document explicitly states it is NOT a certification.
    expect(text).toMatch(/not.*certification|cannot self-attest/i);
    // And identifies the reviewer's attestation responsibility.
    expect(text).toMatch(/independent.*reviewer|ActivationAttestation/);
  });

  it("the threat model covers every asset class", () => {
    const text = readFileSync(REVIEW, "utf8");
    const assets = [
      "Provider API keys",
      "Server/SMTP/release credentials",
      "Active security policy",
      "Filesystem (exact write)",
      "Network egress",
      "Secrets at the broker",
      "Model-visible history",
      "Tenant isolation",
      "Docker socket",
      "Dispatch forgery",
      "Self-evolution activation",
      "Audit integrity",
    ];
    for (const asset of assets) {
      expect(text, `threat model missing asset: ${asset}`).toContain(asset);
    }
  });

  it("the audit checklist covers every layer", () => {
    const text = readFileSync(REVIEW, "utf8");
    const sections = [
      "Foundations (contracts)",
      "Domain (policy + lifecycle)",
      "Capabilities (execution)",
      "Vendors (platform adapters)",
      "Transport (surfaces)",
      "Deployment (server)",
      "Self-evolution",
    ];
    for (const s of sections) {
      expect(text, `audit checklist missing section: ${s}`).toContain(s);
    }
  });

  it("known limitations are disclosed for reviewer acknowledgement", () => {
    const text = readFileSync(REVIEW, "utf8");
    expect(text).toMatch(/Known limitations/i);
    // In-memory store durability caveat.
    expect(text).toMatch(/in-memory.*not.*durable|PendingApprovalStore.*in-memory/i);
    // Native helper is a separate artifact.
    expect(text).toMatch(/seepient-fs-commit.*separate.*artifact|Rust/i);
  });

  it("the attestation path requires an independent verifier (FR-020)", () => {
    const text = readFileSync(REVIEW, "utf8");
    expect(text).toMatch(/verifierId.*authorRunId|verifier-identity.*author/i);
    expect(text).toMatch(/ActivationSupervisor/);
  });
});
