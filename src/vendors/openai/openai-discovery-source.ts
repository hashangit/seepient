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
      const secret = await lease.secret();
      if (secret.kind !== "api_key") {
        return { modelIds: [], error: `OpenAI discovery requires an api_key credential, received kind "${secret.kind}"` };
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
