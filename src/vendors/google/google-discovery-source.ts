import type {
  DiscoverySource,
  DiscoveryResult,
  ProviderAccountContext,
} from "../../foundations/contracts/backend-ports.js";

/**
 * Google Gemini model discovery source querying `/v1beta/models`.
 * Safe against network failures (returns empty array with recorded error without throwing).
 */
export class GoogleDiscoverySource implements DiscoverySource {
  async discover(account: ProviderAccountContext): Promise<DiscoveryResult> {
    const lease = account.credential.acquireLease();
    try {
      const secret = await lease.secret();
      if (secret.kind !== "api_key") {
        return { modelIds: [], error: `Google discovery requires an api_key credential, received kind "${secret.kind}"` };
      }

      const url = "https://generativelanguage.googleapis.com/v1beta/models";
      const response = await fetch(url, {
        headers: {
          "x-goog-api-key": secret.value,
        },
      });
      if (!response.ok) {
        return { modelIds: [], error: `Google discovery endpoint returned ${response.status}: ${response.statusText}` };
      }

      const data: any = await response.json();
      if (!data?.models || !Array.isArray(data.models)) {
        return { modelIds: [] };
      }

      const modelIds = data.models
        .map((m: any) => (m.name ? m.name.replace(/^models\//, "") : undefined))
        .filter((id: any): id is string => typeof id === "string" && id.length > 0);

      return { modelIds };
    } catch (err: any) {
      return { modelIds: [], error: err?.message || "Failed to discover Google models" };
    } finally {
      await lease.release();
    }
  }
}
