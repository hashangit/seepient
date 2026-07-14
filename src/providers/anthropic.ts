import Anthropic from '@anthropic-ai/sdk';
import { ProviderMessage, ProviderResponse, ProviderToolCall, LLMProvider, ChatOptions, StreamDelta } from './types.js';
import type { ToolDefinition } from '../tools/interface.js';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string, options?: { baseURL?: string; timeout?: number }) {
    this.client = new Anthropic({
      apiKey,
      baseURL: options?.baseURL,
      timeout: options?.timeout,
    });
    this.model = model;
  }

  /**
   * Translate Seepient messages + tools into Anthropic's request shape. Shared by
   * `chat()` and `chatStream()` so the (non-trivial) translation lives once.
   */
  private buildRequest(messages: ProviderMessage[], tools: ToolDefinition[]): {
    system: string | undefined;
    anthropicMessages: Anthropic.MessageParam[];
    anthropicTools: Anthropic.Tool[];
  } {
    const systemParts: string[] = [];
    const nonSystem: ProviderMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        if (msg.content) systemParts.push(msg.content);
      } else {
        nonSystem.push(msg);
      }
    }

    const anthropicMessages: Anthropic.MessageParam[] = [];
    for (const msg of nonSystem) {
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments),
          });
        }
        anthropicMessages.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id!,
            content: msg.content ?? '',
          }],
        });
      } else {
        anthropicMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content ?? '',
        });
      }
    }

    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
    }));

    return {
      system: systemParts.length ? systemParts.join('\n') : undefined,
      anthropicMessages,
      anthropicTools,
    };
  }

  async chat(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): Promise<ProviderResponse> {
    const { system, anthropicMessages, anthropicTools } = this.buildRequest(messages, tools);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16384,
      system,
      messages: anthropicMessages,
      tools: anthropicTools,
    }, { signal: options?.signal });

    // Translate response
    let content: string | undefined;
    const toolCalls: ProviderToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content = content ? content + block.text : block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    const usage = response.usage ? {
      promptTokens: response.usage.input_tokens ?? 0,
      completionTokens: response.usage.output_tokens ?? 0,
      totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
      cost: 0,
    } : undefined;

    return {
      content: content || undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      usage,
    };
  }

  /**
   * Stream the response via Anthropic's message stream. Text blocks yield
   * `text_delta`; tool_use blocks yield `tool_call_begin` (on block start) then
   * `tool_call_delta` for each `input_json_delta` fragment, keyed by block index.
   */
  async *chatStream(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): AsyncIterable<StreamDelta> {
    const { system, anthropicMessages, anthropicTools } = this.buildRequest(messages, tools);

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 16384,
      system,
      messages: anthropicMessages,
      tools: anthropicTools,
    }, { signal: options?.signal });

    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        yield {
          type: 'tool_call_begin',
          index: event.index,
          id: event.content_block.id,
          name: event.content_block.name,
        };
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', content: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          yield { type: 'tool_call_delta', index: event.index, argumentsDelta: event.delta.partial_json };
        }
      } else if (event.type === 'message_delta' && event.usage) {
        const inputTokens = event.usage.input_tokens ?? 0;
        const outputTokens = event.usage.output_tokens ?? 0;
        yield {
          type: 'finish',
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens,
            cost: 0,
          },
        };
      }
    }
  }
}
