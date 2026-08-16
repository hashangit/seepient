import { describe, it, expect } from "vitest";
import { canonicalToPiContext, canonicalToPiMessages, canonicalToPiTools } from "../pi-canonical-converter.js";
import type { CanonicalMessage } from "../../../foundations/schemas/inference.js";
import type { ToolDefinition } from "../../../foundations/contracts/tool.js";

describe("Pi Canonical Converter Conformance (Gate 2)", () => {
  it("converts multi-turn conversation with system, assistant tool calls, and tool results conforming to Pi types", () => {
    const canonicalMessages: CanonicalMessage[] = [
      {
        role: "system",
        content: [{ type: "text", text: "You are a helpful coding assistant." }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Please inspect the directory." },
          { type: "image", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "I need to run the shell command.",
            signature: "sig_abc123",
          },
          {
            type: "text",
            text: "I will list the directory contents.",
          },
          {
            type: "tool_use",
            id: "call_ls_123",
            name: "execute_shell_command",
            input: { command: "ls -la" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_ls_123",
            content: [{ type: "text", text: "total 0\n-rw-r--r-- 1 user staff 0 Aug 17 package.json" }],
            isError: false,
          },
        ],
      },
    ];

    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "execute_shell_command",
          description: "Run shell command",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          },
        },
      },
    ];

    const converted = canonicalToPiContext(canonicalMessages, {
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-7-sonnet",
    });

    // 1. System prompt extraction
    expect(converted.systemPrompt).toBe("You are a helpful coding assistant.");

    // 2. Converted messages array length
    expect(converted.messages.length).toBe(3); // User, Assistant, ToolResult (System was extracted)

    // 3. User message
    const userMsg = converted.messages[0];
    expect(userMsg.role).toBe("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect((userMsg.content as any)[0]).toEqual({ type: "text", text: "Please inspect the directory." });
    expect((userMsg.content as any)[1].type).toBe("image");

    // 4. Assistant message
    const assistantMsg = converted.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    if (assistantMsg.role === "assistant") {
      expect(assistantMsg.content.length).toBe(3);

      const thinking = assistantMsg.content[0];
      expect(thinking.type).toBe("thinking");
      if (thinking.type === "thinking") {
        expect(thinking.thinking).toBe("I need to run the shell command.");
        expect(thinking.thinkingSignature).toBe("sig_abc123");
      }

      const text = assistantMsg.content[1];
      expect(text).toEqual({ type: "text", text: "I will list the directory contents." });

      const toolCall = assistantMsg.content[2];
      expect(toolCall.type).toBe("toolCall");
      if (toolCall.type === "toolCall") {
        expect(toolCall.id).toBe("call_ls_123");
        expect(toolCall.name).toBe("execute_shell_command");
        expect(toolCall.arguments).toEqual({ command: "ls -la" });
      }
    }

    // 5. Tool result message
    const toolResultMsg = converted.messages[2];
    expect(toolResultMsg.role).toBe("toolResult");
    if (toolResultMsg.role === "toolResult") {
      expect(toolResultMsg.toolCallId).toBe("call_ls_123");
      expect(toolResultMsg.toolName).toBe("execute_shell_command"); // Properly indexed from assistant message!
      expect(toolResultMsg.isError).toBe(false);
      expect(Array.isArray(toolResultMsg.content)).toBe(true);
      expect(toolResultMsg.content[0]).toEqual({
        type: "text",
        text: "total 0\n-rw-r--r-- 1 user staff 0 Aug 17 package.json",
      });
    }

    // 6. Converted tools
    const piTools = canonicalToPiTools(tools);
    expect(piTools.length).toBe(1);
    expect(piTools[0].name).toBe("execute_shell_command");
    expect(piTools[0].description).toBe("Run shell command");
    expect(piTools[0].parameters).toBeDefined();
  });
});
