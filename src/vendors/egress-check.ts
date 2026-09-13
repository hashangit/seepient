import type { Capability } from "../foundations/contracts/permission-policy.js";
import type { InferenceTarget } from "../foundations/contracts/backend-ports.js";
import { InferenceError } from "../foundations/errors.js";

/**
 * Asserts that a target baseUrl is allowed by granted network-destination capabilities in multi-tenant mode (FR-014 / DP4).
 */
export function assertBaseUrlEgressAllowed(
  baseUrl: string,
  capabilities?: readonly Capability[],
  target?: InferenceTarget,
): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new InferenceError({
      code: "invalid_request",
      message: `Invalid baseUrl "${baseUrl}"`,
      providerAccount: target?.providerAccount,
      model: target?.model,
      retryable: false,
    });
  }

  const scheme = parsed.protocol.replace(/:$/, "");
  const host = parsed.hostname;
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : scheme === "https"
      ? 443
      : scheme === "http"
        ? 80
        : undefined;

  const allowed = capabilities?.some((cap) => {
    if (cap.kind !== "network-destination") return false;
    if (cap.scheme !== scheme) return false;
    if (cap.host !== "*" && cap.host !== host) return false;
    if (cap.port !== undefined && port !== undefined && cap.port !== port) return false;
    if (cap.port !== undefined && port === undefined) return false;
    return true;
  });

  if (!allowed) {
    throw new InferenceError({
      code: "unsupported_capability",
      message: `EGRESS_REQUIRED: Multi-tenant inference to baseUrl "${baseUrl}" requires an explicit network-destination capability for ${scheme}://${host}.`,
      providerAccount: target?.providerAccount,
      model: target?.model,
      retryable: false,
    });
  }
}
