import type {
  DiscoverySource,
  ProviderAccountContext,
} from "../../foundations/contracts/backend-ports.js";

/**
 * Google Gemini model discovery source querying `/v1beta/models`.
 * Safe against network failures (returns empty array on error without throwing).
 */
export class GoogleDiscoverySource implements DiscoverySource {
  async discover(account: ProviderAccountContext): Promise<readonly string[]> {
    const lease = account.credential.acquireLease();
    try {
      const secret = await lease.secret();
      if (secret.kind !== "api_key") return [];

      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(secret.value)}`;
      const response = await fetch(url);
      if (!response.ok) return [];

      const data: any = await response.json();
      if (!data?.models || !Array.isArray(data.models)) return [];

      return data.models
        .map((m: any) => (m.name ? m.name.replace(/^models\//, "") : undefined))
        .filter((id: any): id is string => typeof id === "string" && id.length > 0);
    } catch {
      return [];
    } finally {
      await lease.release();
    }
  }
}
