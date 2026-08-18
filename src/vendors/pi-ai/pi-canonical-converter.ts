import type {
  CanonicalMessage,
} from "../../foundations/schemas/inference.js";
import type { ToolDefinition } from "../../foundations/contracts/tool.js";
import type {
  Message as PiMessage,
  UserMessage as PiUserMessage,
  AssistantMessage as PiAssistantMessage,
  ToolResultMessage as PiToolResultMessage,
  TextContent as PiTextContent,
  ThinkingContent as PiThinkingContent,
  ImageContent as PiImageContent,
  ToolCall as PiToolCall,
  Tool as PiTool,
  Context as PiContext,
} from "@earendil-works/pi-ai";

export interface PiConvertedContext {
  systemPrompt?: string;
  messages: PiMessage[];
}

/**
 * Converts Seepient canonical messages to Pi AI message representations.
 * Preserves tool identity, thinking signatures, and constructs conforming
 * Context.systemPrompt and ToolResultMessage shapes without `as any` casts.
 */
export function canonicalToPiContext(
  messages: CanonicalMessage[],
  defaults?: { api?: string; provider?: string; model?: string },
): PiConvertedContext {
  const piMessages: PiMessage[] = [];
  const systemPrompts: string[] = [];
  const toolNameMap = new Map<string, string>();

  // Pass 1: Index tool call names from assistant messages to populate toolName on results
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolNameMap.set(block.id, block.name);
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = msg.content.map((b) => b.text).join("\n\n");
      if (text.trim().length > 0) {
        systemPrompts.push(text);
      }
    } else if (msg.role === "user") {
      const parts: (PiTextContent | PiImageContent)[] = [];
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
          }
        }
      }
      const userMsg: PiUserMessage = {
        role: "user",
        content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
        timestamp: Date.now(),
      };
      piMessages.push(userMsg);
    } else if (msg.role === "assistant") {
      const contentParts: (PiTextContent | PiThinkingContent | PiToolCall)[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          contentParts.push({ type: "text", text: block.text });
        } else if (block.type === "reasoning") {
          contentParts.push({
            type: "thinking",
            thinking: block.text,
            thinkingSignature: block.signature,
          });
        } else if (block.type === "tool_use") {
          let parsedArgs: Record<string, any> = {};
          if (typeof block.input === "string") {
            try {
              parsedArgs = JSON.parse(block.input);
            } catch {
              parsedArgs = { raw: block.input };
            }
          } else if (typeof block.input === "object" && block.input !== null) {
            parsedArgs = block.input;
          }
          contentParts.push({
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: parsedArgs,
          });
        }
      }

      const assistantMsg: PiAssistantMessage = {
        role: "assistant",
        content: contentParts,
        api: (defaults?.api as any) ?? "openai-completions",
        provider: (defaults?.provider as any) ?? "openai",
        model: defaults?.model ?? "unknown",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      piMessages.push(assistantMsg);
    } else if (msg.role === "tool") {
      const blocks: any[] = Array.isArray(msg.content)
        ? msg.content
        : [
            {
              type: "tool_result",
              toolUseId: (msg as any).toolCallId ?? (msg as any).id ?? "tool-call",
              content: [{ type: "text", text: String((msg as any).content ?? "") }],
            },
          ];

      for (const block of blocks) {
        if (!block) continue;
        const toolUseId = block.toolUseId ?? (msg as any).toolCallId ?? "tool-call";
        let textParts: PiTextContent[] = [];
        if (Array.isArray(block.content)) {
          textParts = block.content
            .filter((c: any): c is { type: "text"; text: string } => c && c.type === "text")
            .map((c: any) => ({ type: "text" as const, text: String(c.text ?? "") }));
        } else if (typeof block.content === "string") {
          textParts = [{ type: "text" as const, text: block.content }];
        }

        const toolName = toolNameMap.get(toolUseId) ?? "tool";

        const toolResultMsg: PiToolResultMessage = {
          role: "toolResult",
          toolCallId: toolUseId,
          toolName,
          content: textParts.length > 0 ? textParts : [{ type: "text", text: "" }],
          isError: block.isError ?? false,
          timestamp: Date.now(),
        };
        piMessages.push(toolResultMsg);
      }
    }
  }

  return {
    systemPrompt: systemPrompts.length > 0 ? systemPrompts.join("\n\n") : undefined,
    messages: piMessages,
  };
}

/**
 * Backward-compatible helper returning only the Message[] list.
 */
export function canonicalToPiMessages(messages: CanonicalMessage[]): PiMessage[] {
  return canonicalToPiContext(messages).messages;
}

/**
 * Converts Seepient tool definitions to Pi AI tools.
 */
export function canonicalToPiTools(tools?: ToolDefinition[]): PiTool[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: (t.function.parameters ?? { type: "object", properties: {} }) as any,
  }));
}
