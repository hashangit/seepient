import { OpenAI } from "openai";
import type {
  DiscoverySource,
  DiscoveryResult,
  ProviderAccountContext,
} from "../../foundations/contracts/backend-ports.js";

/**
 * OpenAI model discovery source querying `/v1/models`.
 * Failure-safe: returns empty list with recorded error without throwing.
 */
export class OpenAIDiscoverySource implements DiscoverySource {
  async discover(account: ProviderAccountContext): Promise<DiscoveryResult> {
    const lease = account.credential.acquireLease();
    try {
      const rawSecret = await lease.secret();
      // 022-5 FR-006/FR-007: the value gate is the point — an undefined
      // apiKey makes the vendored OpenAI client fall back to host
      // process.env and transmit it to this account's baseUrl.
      const secret = rawSecret.kind === "none" ? { kind: "api_key" as const, value: "unused" } : rawSecret;
      if (secret.kind !== "api_key" || !secret.value) {
        return {
          modelIds: [],
          error: `CREDENTIAL_REQUIRED: OpenAI discovery requires a value-present api_key credential, received kind "${secret.kind}"${secret.kind === "api_key" ? " with an empty value" : ""}`,
        };
      }

      const client = new OpenAI({
        apiKey: secret.value,
        baseURL: account.baseUrl,
      });

      const list = await client.models.list();
      const ids: string[] = [];
      for await (const model of list) {
        if (model.id) ids.push(model.id);
      }
      return { modelIds: ids };
    } catch (err: any) {
      return { modelIds: [], error: err?.message || "Failed to discover OpenAI models" };
    } finally {
      await lease.release();
    }
  }
}
