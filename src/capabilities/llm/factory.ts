import type {
  LLMProvider,
  ProviderConfig,
  ProviderMessage,
  ProviderResponse,
  ProviderToolCall,
  ChatOptions,
  StreamDelta,
} from '../../foundations/contracts/llm.js';
import type { ToolDefinition } from '../../foundations/contracts/tool.js';
import type { InferenceTarget } from '../../foundations/contracts/backend-ports.js';
import { PiLanguageRaw } from '../../vendors/pi-ai/pi-language-raw.js';
import { resolveDefaultModel } from '../../foundations/models-catalog.js';
import { SeepientError } from '../../foundations/errors.js';

class BridgedLLMProvider implements LLMProvider {
  name: string;
  defaultModel: string;
  private raw: PiLanguageRaw;
  private apiKey: string;
  private baseUrl?: string;
  private upstreamProvider: string;

  constructor(apiKey: string, defaultModel: string, upstreamProvider: string, baseUrl?: string) {
    this.name = upstreamProvider;
    this.defaultModel = defaultModel;
    this.apiKey = apiKey;
    this.upstreamProvider = upstreamProvider;
    this.baseUrl = baseUrl;
    this.raw = new PiLanguageRaw();
  }

  private makeTarget(): InferenceTarget {
    return {
      providerAccount: this.upstreamProvider,
      upstreamProvider: this.upstreamProvider,
      model: this.defaultModel,
      credential: {
        id: `legacy-${this.upstreamProvider}`,
        ref: { kind: "none" },
        isResolvable: async () => true,
        acquireLease: () => ({
          leaseId: "legacy-lease",
          secret: async () => ({ kind: "api_key", value: this.apiKey }),
          release: async () => {},
          isReleased: false,
        }),
        activeLeaseCount: 0,
      },
      baseUrl: this.baseUrl,
    };
  }

  private convertMessages(messages: ProviderMessage[]): any[] {
    return messages.map((m) => {
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        return {
          role: "assistant",
          content: [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.tool_calls.map((tc) => ({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: JSON.parse(tc.arguments || "{}"),
            })),
          ],
        };
      }
      if (m.role === "tool") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: m.tool_call_id,
              content: m.content,
            },
          ],
        };
      }
      return {
        role: m.role,
        content: m.content,
      };
    });
  }

  async chat(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): Promise<ProviderResponse> {
    const target = this.makeTarget();
    const resp = await this.raw.chat(target, {
      messages: this.convertMessages(messages),
      tools,
    }, { signal: options?.signal });

    let text = "";
    const tool_calls: ProviderToolCall[] = [];

    for (const block of resp.message.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        tool_calls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    const pt = resp.usage?.inputTokens ?? 0;
    const ct = resp.usage?.outputTokens ?? 0;

    return {
      content: text || undefined,
      tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
      usage: resp.usage
        ? {
            promptTokens: pt,
            completionTokens: ct,
            totalTokens: pt + ct,
            cost: resp.usage.cost ?? 0,
          }
        : undefined,
    };
  }

  async *chatStream(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): AsyncIterable<StreamDelta> {
    const target = this.makeTarget();
    const stream = this.raw.chatStream(target, {
      messages: this.convertMessages(messages),
      tools,
    }, { signal: options?.signal });

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text_delta", content: event.delta.text };
        } else if (event.delta.type === "tool_input_delta") {
          yield {
            type: "tool_call_delta",
            index: event.index,
            argumentsDelta: event.delta.partialJson,
          };
        }
      } else if (event.type === "content_block_start" && event.block.type === "tool_use") {
        yield {
          type: "tool_call_begin",
          index: event.index,
          id: event.block.id,
          name: event.block.name,
        };
      } else if (event.type === "finish") {
        const pt = event.usage?.inputTokens ?? 0;
        const ct = event.usage?.outputTokens ?? 0;
        yield {
          type: "finish",
          usage: event.usage
            ? {
                promptTokens: pt,
                completionTokens: ct,
                totalTokens: pt + ct,
                cost: event.usage.cost ?? 0,
              }
            : undefined,
        };
      }
    }
  }
}

export async function createProvider(config: ProviderConfig): Promise<LLMProvider> {
  switch (config.type) {
    case 'openai':
      return new BridgedLLMProvider(config.apiKey, config.model, 'openai', 'https://api.openai.com/v1');
    case 'openai-compatible':
      return new BridgedLLMProvider(config.apiKey, config.model, 'openai', config.baseUrl);
    case 'anthropic':
      return new BridgedLLMProvider(config.apiKey, config.model, 'anthropic');
    case 'glm': {
      let resolvedModel = config.model;
      if (!resolvedModel || resolvedModel === 'sonnet') {
        resolvedModel = resolveDefaultModel('glm', 'standard');
      } else if (resolvedModel === 'haiku') {
        resolvedModel = resolveDefaultModel('glm', 'efficient');
      } else if (resolvedModel === 'opus') {
        resolvedModel = resolveDefaultModel('glm', 'complex');
      }
      return new BridgedLLMProvider(
        config.apiKey,
        resolvedModel,
        'glm',
        'https://api.z.ai/api/anthropic',
      );
    }
    default:
      throw new SeepientError(`Unknown provider type: ${(config as any).type}`, 'INVALID_CONFIG', false);
  }
}
