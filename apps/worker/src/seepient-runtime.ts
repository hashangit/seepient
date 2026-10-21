/**
 * S08 development-candidate composition (spec 029, M02 T029, decision D7).
 *
 * Wires the engine's SeepientAgentRuntime as this app's AgentRuntime.
 * Credentials are resolved through the trusted run composition: the app's own
 * `resolveModel` callback decrypts the bot's provider credential exactly as
 * the upstream runtime received it, and the key rides the NORMAL Seepient
 * provider runtime via an injected per-run memory store — never env keys,
 * never ambient fallback. A run whose composition yields no key fails closed
 * (OAuth passthrough is M04/S10, bridge-inventory B-10). Model, instructions,
 * external history and the tool set flow through the adapter's translation;
 * an explicitly empty tool list stays empty end to end.
 */
import { SeepientAgentRuntime } from "seepient/app-runtime";
import { MemoryCredentialStore } from "seepient";
import type { AgentRunRequest, AgentRuntime } from "@seepients/adapter-kit";
import type { CreateSeepientOptions } from "seepient/types";

/** Engine provider-account id bound to the run's request-borne credential. */
const ACCOUNT_ID = "seepients-app-model";

export function createSeepientAgentRuntime(): AgentRuntime {
  return new SeepientAgentRuntime({
    resolveEngineOptions: async (request: AgentRunRequest): Promise<CreateSeepientOptions> => {
      // Platform-managed models carry no key on the request; the app's
      // resolveModel callback resolves (and decrypts) it from the store.
      const credentialed = request.model.apiKey
        ? request.model
        : request.resolveModel
          ? await request.resolveModel(request.model.provider, request.model.id)
          : undefined;
      if (!credentialed?.apiKey) {
        throw new Error(
          "CREDENTIAL_REQUIRED: the trusted run composition resolved no model API key " +
            "(the seepient runtime never reads env keys; OAuth passthrough is M04/S10, bridge-inventory B-10)",
        );
      }
      const credentials = new MemoryCredentialStore();
      await credentials.put(`${ACCOUNT_ID}-key`, { kind: "api_key", keyValue: credentialed.apiKey });
      return {
        // Per-run stateless engine instance with per-run in-memory stores: no
        // state outlives the run, so this is single tenancy by construction.
        // Without the explicit mode, the credential injection silently
        // upgrades to "multi", which then demands principalId, cwd, and a
        // full isolated store set this composition intentionally does not use.
        tenancy: "single",
        // The app's own executor governs tool effects (it held this authority
        // upstream); the engine's bridge is trusted-host, so headless runs
        // declare autonomous consent instead of double-gating. Interactive
        // approvals are M05 (bridge-inventory B-6).
        consentMode: "autonomous",
        model: credentialed.id,
        providerAccount: ACCOUNT_ID,
        credentials,
        providers: {
          [ACCOUNT_ID]: {
            adapter: "pi-ai",
            upstreamProvider: credentialed.provider,
            credential: { kind: "seepient", id: `${ACCOUNT_ID}-key` },
            ...(credentialed.baseUrl ? { baseUrl: credentialed.baseUrl } : {}),
          },
        },
      };
    },
  });
}
