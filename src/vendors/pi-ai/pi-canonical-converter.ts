import type {
  CanonicalMessage,
  ContentBlock,
  StreamEvent,
  Usage,
  InferenceResponse,
} from "../../foundations/schemas/inference.js";
import type { ToolDefinition } from "../../foundations/contracts/tool.js";
import type {
  Message as PiMessage,
  UserMessage as PiUserMessage,
  Tool as PiTool,
  AssistantMessageEvent as PiAssistantMessageEvent,
} from "@earendil-works/pi-ai";

/**
 * Converts Seepient canonical messages to Pi AI message representations.
 */
export function canonicalToPiMessages(messages: CanonicalMessage[]): PiMessage[] {
  const result: PiMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = msg.content.map((b) => b.text).join("\n\n");
      result.push({
        role: "system",
        content: text,
      } as any);
    } else if (msg.role === "user") {
      const parts: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          if ("data" in block && block.data) {
            parts.push({
              type: "image",
              mimeType: block.mediaType,
              data: block.data,
            });
          } else if ("url" in block && block.url) {
            parts.push({
              type: "image",
              url: block.url,
            });
          }
        }
      }
      result.push({
        role: "user",
        content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
        timestamp: Date.now(),
      } as PiUserMessage);
    } else if (msg.role === "assistant") {
      const contentParts: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          contentParts.push({ type: "text", text: block.text });
        } else if (block.type === "reasoning") {
          contentParts.push({
            type: "thinking",
            thinking: block.text,
            signature: block.signature,
          });
        } else if (block.type === "tool_use") {
          contentParts.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
      result.push({
        role: "assistant",
        content: contentParts,
        timestamp: Date.now(),
      } as any);
    } else if (msg.role === "tool") {
      for (const block of msg.content) {
        const textContent = block.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        result.push({
          role: "toolResult",
          toolCallId: block.toolUseId,
          content: textContent,
          isError: block.isError ?? false,
          timestamp: Date.now(),
        } as any);
      }
    }
  }

  return result;
}

/**
 * Converts Seepient tool definitions to Pi AI tools.
 */
export function canonicalToPiTools(tools?: ToolDefinition[]): PiTool[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: (t.function.parameters ?? { type: "object", properties: {} }) as any,
  }));
}

/**
 * Converts Pi AI streaming event to Seepient canonical StreamEvent.
 */
export function piEventToCanonical(
  event: PiAssistantMessageEvent,
  context: {
    modelId: string;
    providerAccount: string;
    upstreamProvider: string;
    currentIndex: { value: number };
    activeBlockType?: string;
  },
): StreamEvent | null {
  if (event.type === "start") {
    return {
      type: "start",
      resolvedModel: {
        modelId: context.modelId,
        providerAccount: context.providerAccount,
      },
    };
  }

  if (event.type === "text_delta") {
    return {
      type: "content_block_delta",
      index: context.currentIndex.value,
      delta: {
        type: "text_delta",
        text: (event as any).content || (event as any).delta || "",
      },
    };
  }

  if (event.type === "thinking_delta") {
    return {
      type: "content_block_delta",
      index: context.currentIndex.value,
      delta: {
        type: "reasoning_delta",
        text: (event as any).content || (event as any).delta || "",
      },
    };
  }

  if (event.type === "done") {
    const msg = (event as any).message;
    const usage: Usage = {
      promptTokens: msg?.usage?.promptTokens ?? msg?.usage?.inputTokens ?? 0,
      completionTokens: msg?.usage?.completionTokens ?? msg?.usage?.outputTokens ?? 0,
      totalTokens:
        (msg?.usage?.promptTokens ?? msg?.usage?.inputTokens ?? 0) +
        (msg?.usage?.completionTokens ?? msg?.usage?.outputTokens ?? 0),
    };

    const hasToolCalls = msg?.content?.some((c: any) => c.type === "tool_use" || c.type === "tool_call");
    return {
      type: "finish",
      stopReason: hasToolCalls ? "tool_use" : "end_turn",
      usage,
    };
  }

  if (event.type === "error") {
    return {
      type: "error",
      error: {
        code: "internal_adapter",
        message: (event as any).error?.message || "Pi stream error",
        retryable: true,
      },
    };
  }

  return null;
}
