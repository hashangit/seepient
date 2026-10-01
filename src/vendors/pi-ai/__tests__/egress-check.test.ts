import { describe, it, expect } from "vitest";
import { assertBaseUrlEgressAllowed } from "../../egress-check.js";
import { InferenceError } from "../../../foundations/errors.js";

describe("Egress Scheme-Default Port Resolution (T027 / FR-017)", () => {
  it("http://host (effective 80) vs 443-pinned cap is denied", () => {
    expect(() =>
      assertBaseUrlEgressAllowed("http://api.example.com/v1", [
        { kind: "network-destination", scheme: "http", host: "api.example.com", port: 443 },
      ]),
    ).toThrow(InferenceError);
  });

  it("https://host vs 443 cap is allowed", () => {
    expect(() =>
      assertBaseUrlEgressAllowed("https://api.example.com/v1", [
        { kind: "network-destination", scheme: "https", host: "api.example.com", port: 443 },
      ]),
    ).not.toThrow();
  });

  it("explicit-port mismatch is denied", () => {
    expect(() =>
      assertBaseUrlEgressAllowed("https://api.example.com:8443/v1", [
        { kind: "network-destination", scheme: "https", host: "api.example.com", port: 443 },
      ]),
    ).toThrow(InferenceError);
  });

  it("wildcard port allows any port", () => {
    expect(() =>
      assertBaseUrlEgressAllowed("https://api.example.com:8443/v1", [
        { kind: "network-destination", scheme: "https", host: "api.example.com" },
      ]),
    ).not.toThrow();
  });
});
