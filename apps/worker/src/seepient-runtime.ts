/**
 * S08 development-candidate composition (spec 029, M02 T029, decision D7);
 * S10 account mapping (M04 T009/T010).
 *
 * Wires the engine's SeepientAgentRuntime as this app's AgentRuntime.
 * Credentials are resolved through the trusted run composition: the app's own
 * `resolveModel` callback decrypts the bot's provider credential exactly as
 * the upstream runtime received it, and the key rides the NORMAL Seepient
 * provider runtime via an injected per-run memory store — never env keys,
 * never ambient fallback. The operator-trusted PLATFORM DEPLOYMENT ACCOUNT is
 * the fourth precedence tier of the run path's `selectConfiguredModel`
 * (`resolveDeploymentModel`): when it wins, the deployment key arrives
 * request-borne on `request.model.apiKey` and is admitted here as the
 * declared operator account row — it is not re-synthesized from the
 * environment. Model-oauth runs take the DURABLE credential adapter (T010):
 * refreshes write back through the product secret rows under the run path's
 * fences; retire → needs-reauth. A run whose composition yields no key and no
 * oauth handle fails closed with the typed `ModelCredentialRequiredError`.
 * `MemoryCredentialStore` remains only for api-key bindings (B-9). Model,
 * instructions, external history and the tool
 * set flow through the adapter's translation; an explicitly empty tool list
 * stays empty end to end.
 */
import {
  DEFAULT_CONTEXT_STRATEGY,
  ModelCredentialRequiredError,
  describeToolActivity,
  governedDeclarationFor,
  type SecretStore,
} from "@seepients/adapter-kit";
import { DurableModelCredentialStore } from "@seepients/adapters";
import { SeepientAgentRuntime } from "seepient/app-runtime";
import { MemoryCredentialStore } from "seepient";
import type { AgentRunRequest, AgentRuntime } from "@seepients/adapter-kit";
import type { CreateSeepientOptions } from "seepient/types";
import type { PrismaClient } from "@seepients/db";

/** Engine provider-account id bound to the run's request-borne credential. */
const ACCOUNT_ID = "seepients-app-model";

export interface SeepientAgentRuntimeDeps {
  prisma: PrismaClient;
  /** The app's secret store (encrypt/decrypt) for durable oauth write-back. */
  secretStore: Pick<SecretStore, "load" | "put">;
}

export async function seepientResolveEngineOptions(
  request: AgentRunRequest,
  deps: SeepientAgentRuntimeDeps,
): Promise<CreateSeepientOptions> {
  // Model-oauth runs take the DURABLE credential adapter (T010): refreshes
  // write back through the product secret rows' fences, deletes retire with
  // the failed-secret match. An oauth credential without its row handle
  // cannot write back durably and is refused rather than silently dropped.
  const oauth = request.model.oauth;
  if (oauth?.credential) {
    if (!oauth.handle) {
      throw new ModelCredentialRequiredError(
        "CREDENTIAL_REQUIRED: model-oauth run arrived without its durable row handle " +
          "(refresh write-back would be lost at run end)",
      );
    }
    const credentials = new DurableModelCredentialStore({
      prisma: deps.prisma,
      secretStore: deps.secretStore,
      scope: { userId: oauth.handle.userId, spaceId: oauth.handle.spaceId },
      handle: { credentialId: oauth.handle.credentialId, secretId: oauth.handle.secretId },
      accountId: `${ACCOUNT_ID}-key`,
      provider: request.model.provider,
    });
    return {
      tenancy: "single",
      consentMode: "autonomous",
      model: request.model.id,
      providerAccount: ACCOUNT_ID,
      credentials,
      providers: {
        [ACCOUNT_ID]: {
          adapter: "pi-ai",
          upstreamProvider: request.model.provider,
          credential: { kind: "seepient", id: `${ACCOUNT_ID}-key` },
        },
      },
    };
  }
  // Platform-managed models carry no key on the request; the app's
  // resolveModel callback resolves (and decrypts) it from the store.
  const credentialed = request.model.apiKey
    ? request.model
    : request.resolveModel
      ? await request.resolveModel(request.model.provider, request.model.id)
      : undefined;
  if (!credentialed?.apiKey) {
    throw new ModelCredentialRequiredError(
      "CREDENTIAL_REQUIRED: the trusted run composition resolved no model API key " +
        "and no operator-trusted platform account applies (the seepient runtime " +
        "never reads env keys)",
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
}

export function createSeepientAgentRuntime(deps: SeepientAgentRuntimeDeps): AgentRuntime {
  return new SeepientAgentRuntime({
    resolveEngineOptions: (request) => seepientResolveEngineOptions(request, deps),
    // The engine's adapter-kit edge is types-only (ARCHITECTURE.md §118);
    // the composition root owns the adapter-kit VALUES.
    describeToolActivity,
    governedDeclarationFor,
    defaultContextStrategy: DEFAULT_CONTEXT_STRATEGY,
  });
}
