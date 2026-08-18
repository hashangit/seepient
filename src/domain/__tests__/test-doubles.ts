import { ProviderRuntime } from "../providers/provider-runtime.js";
import { ProviderConfigStore } from "../providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../providers/credentials/memory-credential-store.js";
import { ModelCatalog } from "../providers/model-catalog.js";
import { AggregateInferenceAdapter } from "../../capabilities/inference/aggregate-adapter.js";
import type { LanguageBackend } from "../../foundations/contracts/backend-ports.js";

export interface MockStepResponse {
  content?: string;
  text?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string | Record<string, unknown> }>;
  toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown>; arguments?: string | Record<string, unknown> }>;
  usage?: { promptTokens?: number; completionTokens?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; cost?: number };
  error?: { message: string; code?: string; retryable?: boolean };
}

export function createMockRuntime(
  responses: MockStepResponse[] | ((req: any) => MockStepResponse),
): ProviderRuntime {
  let callIndex = 0;
  const mockLanguageBackend: LanguageBackend = {
    chatStream: async function* (_target, req) {
      const resp = typeof responses === "function" ? responses(req) : (responses[callIndex] ?? { content: "Done" });
      callIndex++;

      yield {
        type: "start",
        resolvedModel: {
          providerAccount: "mock-account",
          modelId: "mock-model",
        },
      };

      if (resp.error) {
        yield {
          type: "error",
          error: {
            code: resp.error.code ?? "PROVIDER_ERROR",
            message: resp.error.message,
            retryable: resp.error.retryable ?? false,
          },
        };
        return;
      }

      const textContent = resp.content ?? resp.text;
      if (textContent) {
        yield {
          type: "content_block_start",
          index: 0,
          block: {
            type: "text",
            text: "",
          },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: textContent,
          },
        };
        yield {
          type: "content_block_stop",
          index: 0,
        };
      }

      const rawToolCalls = resp.tool_calls ?? resp.toolCalls;
      if (rawToolCalls && rawToolCalls.length > 0) {
        for (let i = 0; i < rawToolCalls.length; i++) {
          const tc = rawToolCalls[i];
          const blockIdx = (textContent ? 1 : 0) + i;
          const args = tc.arguments ?? (tc as any).args ?? {};
          const argsStr = typeof args === "string" ? args : JSON.stringify(args);
          yield {
            type: "content_block_start",
            index: blockIdx,
            block: {
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: {},
            } as any,
          };
          yield {
            type: "content_block_delta",
            index: blockIdx,
            delta: {
              type: "tool_input_delta",
              partialJson: argsStr,
            } as any,
          };
          yield {
            type: "content_block_stop",
            index: blockIdx,
          };
        }
      }

      const inp = resp.usage?.inputTokens ?? resp.usage?.promptTokens ?? 10;
      const out = resp.usage?.outputTokens ?? resp.usage?.completionTokens ?? 5;
      yield {
        type: "finish",
        stopReason: "end_turn",
        usage: {
          inputTokens: inp,
          outputTokens: out,
          totalTokens: resp.usage?.totalTokens ?? inp + out,
        },
      };
    },
    chat: async () => ({
      message: { role: "assistant", content: [] },
      stopReason: "end_turn",
    }),
  };

  const adapter = new AggregateInferenceAdapter({
    language: mockLanguageBackend,
  });

  const credStore = new MemoryCredentialStore();
  const configStore = new ProviderConfigStore(":memory:");
  (configStore as any).currentOverlay = {
    revision: 1,
    updatedAt: new Date().toISOString(),
    patch: {
      providers: {
        "mock-account": {
          adapter: "pi-ai",
          upstreamProvider: "mock-account",
          credential: { kind: "none" },
        },
      },
      modelAssignments: {
        text: {
          standard: {
            providerAccount: "mock-account",
            model: "mock-model",
          },
        },
      },
    },
  };

  const runtime = new ProviderRuntime({
    configStore,
    credentialStore: credStore,
    modelCatalog: new ModelCatalog([]),
    adapter,
  });
  return runtime;
}
