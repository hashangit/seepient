/**
 * 013 T039 / M5.1 — pi-ai OAuth & CredentialStore adapter.
 *
 * Implements pi-ai's `CredentialStore` interface over Seepient's CredentialStore.
 * Serializes `modify()` read-modify-writes per providerId to ensure token refresh
 * safety. Exposes bundled OAuth flows from `@earendil-works/pi-ai`.
 *
 * Boundary rules:
 * - All pi-ai auth imports are quarantined in this file (R9/R14).
 * - Never imports Bun runtime OAuth packages (Node runtime only).
 * - Tokens are stored only via the credential store as `kind: "oauth"`.
 */

import type {
  CredentialStore as PiCredentialStore,
  Credential as PiCredential,
  CredentialInfo as PiCredentialInfo,
  AuthOperationOptions,
  OAuthAuth,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import type { CredentialStore as SeepientCredentialStore } from "../../foundations/contracts/credential-store.js";
import type { PersistedCredentialRecord } from "../../foundations/schemas/credential-store.js";
import { redactString } from "../../foundations/security/redact.js";

/** The seven bundled OAuth flows supported in pi-ai. */
export const AVAILABLE_OAUTH_FLOWS: readonly string[] = [
  "anthropic",
  "openai-codex",
  "github-copilot",
  "openrouter",
  "kimi-coding",
  "xai",
  "radius",
] as const;

/** Canonical mapping from common upstream provider names to OAuth flow ids. */
export const FLOW_MAP: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai-codex",
  "openai-codex": "openai-codex",
  github: "github-copilot",
  "github-copilot": "github-copilot",
  copilot: "github-copilot",
  openrouter: "openrouter",
  kimi: "kimi-coding",
  "kimi-coding": "kimi-coding",
  moonshot: "kimi-coding",
  xai: "xai",
  grok: "xai",
  radius: "radius",
};

/** Get the canonical OAuth flow ID for a provider name or alias. */
export function getCanonicalOAuthFlowId(provider: string): string {
  return FLOW_MAP[provider.toLowerCase()] ?? provider.toLowerCase();
}

/**
 * Get the OAuth flow instance for a provider if supported.
 */
export async function getOAuthFlow(provider: string): Promise<OAuthAuth | undefined> {
  const normalized = getCanonicalOAuthFlowId(provider);
  switch (normalized) {
    case "anthropic":
      return anthropicProvider().auth.oauth;
    case "openai-codex":
      return openaiCodexProvider().auth.oauth;
    case "github-copilot":
      return githubCopilotProvider().auth.oauth;
    case "openrouter":
      return openrouterProvider().auth.oauth;
    case "kimi-coding":
      return kimiCodingProvider().auth.oauth;
    case "xai":
      return xaiProvider().auth.oauth;
    case "radius":
      return radiusProvider({ name: "radius", gateway: "https://api.radius.ai/v1" }).auth.oauth;
    default:
      return undefined;
  }
}

/** Check if a provider supports OAuth sign-in. */
export function isOAuthSupported(provider: string): boolean {
  const normalized = getCanonicalOAuthFlowId(provider);
  return AVAILABLE_OAUTH_FLOWS.includes(normalized);
}

/**
 * Adapter implementing pi-ai's `CredentialStore` over Seepient's CredentialStore.
 * Mutex promise chains serialize writes per providerId.
 */
export class PiCredentialStoreAdapter implements PiCredentialStore {
  private chains = new Map<string, Promise<unknown>>();

  constructor(private readonly seepientStore: SeepientCredentialStore) {}

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(providerId) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => {}).finally(() => {
      if (this.chains.get(providerId) === tail) {
        this.chains.delete(providerId);
      }
    });
    this.chains.set(providerId, tail);
    return next;
  }

  private async resolveRecordAndId(providerId: string): Promise<{ record: PersistedCredentialRecord | undefined; targetId: string }> {
    let targetId = providerId;
    let record = this.seepientStore.getRecord
      ? await this.seepientStore.getRecord(providerId)
      : undefined;

    if (!record && typeof this.seepientStore.list === "function") {
      try {
        const records = await this.seepientStore.list();
        const hintMatches = records.filter((r) => r.meta?.providerAccountHint === providerId);
        const match =
          records.find((r) => r.id === providerId) ??
          (hintMatches.length === 1 ? hintMatches[0] : undefined);
        if (match && this.seepientStore.getRecord) {
          record = await this.seepientStore.getRecord(match.id);
          targetId = match.id;
        }
      } catch {}
    }
    return { record, targetId };
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<PiCredential | undefined> {
    const { record } = await this.resolveRecordAndId(providerId);

    if (!record) {
      return undefined;
    }

    if (record.kind === "oauth") {
      const oauth: OAuthCredential = {
        type: "oauth",
        access: record.access,
        refresh: record.refresh,
        expires: record.expires,
      };
      return oauth;
    }

    return {
      type: "api_key",
      key: record.keyValue,
    };
  }

  async list(_options?: AuthOperationOptions): Promise<readonly PiCredentialInfo[]> {
    const records = typeof this.seepientStore.list === "function"
      ? await this.seepientStore.list()
      : [];
    return records.map((r) => ({
      providerId: r.id,
      type: (r.materialKind === "oauth" ? "oauth" : "api_key") as PiCredential["type"],
    }));
  }

  async modify(
    providerId: string,
    fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<PiCredential | undefined> {
    return this.enqueue(providerId, async () => {
      if (options?.signal?.aborted) {
        throw new Error("Auth operation aborted");
      }
      const { record, targetId } = await this.resolveRecordAndId(providerId);
      const current = record
        ? (record.kind === "oauth"
            ? ({ type: "oauth", access: record.access, refresh: record.refresh, expires: record.expires } as OAuthCredential)
            : ({ type: "api_key", key: record.keyValue } as PiCredential))
        : await this.read(providerId, options);

      const next = await fn(current);

      if (next === undefined) {
        return current;
      }

      let existingMeta: any;
      if (typeof this.seepientStore.get === "function") {
        try {
          existingMeta = (await this.seepientStore.get(targetId))?.meta;
        } catch {}
      }

      if (next.type === "oauth") {
        const persisted: PersistedCredentialRecord = {
          kind: "oauth",
          access: next.access,
          refresh: next.refresh,
          expires: next.expires,
        };
        const hint = existingMeta?.providerAccountHint ?? getCanonicalOAuthFlowId(providerId);
        const description = existingMeta?.description ?? `OAuth login for ${targetId}`;
        let putErr: unknown;
        for (let i = 0; i < 3; i++) {
          try {
            await this.seepientStore.put(targetId, persisted, {
              source: existingMeta?.source ?? "disk",
              providerAccountHint: hint,
              description,
              ...(existingMeta?.tags ? { tags: existingMeta.tags } : {}),
            });
            putErr = undefined;
            break;
          } catch (err) {
            putErr = err;
            if (i < 2) await new Promise((r) => setTimeout(r, 50 * (i + 1)));
          }
        }
        if (putErr) {
          console.warn(`[warning] Failed to persist refreshed OAuth token for "${targetId}": ${redactString(String(putErr))}`);
        }
      } else if (next.type === "api_key") {
        const persisted: PersistedCredentialRecord = {
          kind: "api_key",
          keyValue: next.key ?? "",
        };
        await this.seepientStore.put(targetId, persisted, { source: existingMeta?.source ?? "disk" });
      }

      return next;
    });
  }

  async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(providerId, async () => {
      const { targetId } = await this.resolveRecordAndId(providerId);
      await this.seepientStore.delete(targetId);
    });
  }
}

const adapterCache = new WeakMap<SeepientCredentialStore, PiCredentialStore>();

/**
 * Factory creating a pi-ai CredentialStore backed by a Seepient CredentialStore.
 * Adapters are cached per SeepientCredentialStore instance so mutex queues serialize concurrently.
 */
export function createPiCredentialStore(seepientStore: SeepientCredentialStore): PiCredentialStore {
  let adapter = adapterCache.get(seepientStore);
  if (!adapter) {
    adapter = new PiCredentialStoreAdapter(seepientStore);
    adapterCache.set(seepientStore, adapter);
  }
  return adapter;
}
