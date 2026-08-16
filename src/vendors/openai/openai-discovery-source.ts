import { OpenAI } from "openai";
import type {
  DiscoverySource,
  ProviderAccountContext,
} from "../../foundations/contracts/backend-ports.js";

/**
 * OpenAI model discovery source querying `/v1/models`.
 * Safe against network failures (returns empty list on failure without throwing).
 */
export class OpenAIDiscoverySource implements DiscoverySource {
  async discover(account: ProviderAccountContext): Promise<readonly string[]> {
    const lease = account.credential.acquireLease();
    try {
      const secret = await lease.secret();
      if (secret.kind !== "api_key") return [];

      const client = new OpenAI({
        apiKey: secret.value,
        baseURL: account.baseUrl,
      });

      const list = await client.models.list();
      const ids: string[] = [];
      for await (const model of list) {
        if (model.id) ids.push(model.id);
      }
      return ids;
    } catch {
      return [];
    } finally {
      await lease.release();
    }
  }
}
