---
title: React Hook (useChat)
description: React hook for building chat interfaces with SSE streaming, tool call tracking, and Seepient Agent backend integration.
---

# React Hook (useChat)

The `useChat` hook provides a complete chat interface for React applications with SSE streaming, message management, and tool call tracking out of the box.

## Import

```typescript
import createUseChat from "seepient/react";

// createUseChat is an async factory -- call it once to get the useChat hook
const useChat = await createUseChat();
```

Or use the named export:

```typescript
import { createUseChat } from "seepient/react";

const useChat = await createUseChat();
```

::: info
The React hook is available from the `seepient/react` subpath import. `createUseChat` is an async factory that returns the `useChat` hook. Ensure your bundler supports package `exports` field.
:::

## Interface

### Options

```typescript
interface UseChatOptions {
  /** API endpoint URL. Default: "/api/chat" */
  api?: string;

  /** Custom headers sent with each request. */
  headers?: Record<string, string>;

  /** Extra body fields merged into each request. */
  body?: Record<string, unknown>;

  /** Called when an error occurs during the request. */
  onError?: (error: Error) => void;

  /** Called when the assistant finishes a response. */
  onFinish?: (message: Message) => void;

  /** Initial messages to populate the chat. */
  initialMessages?: Message[];
}
```

### Return value

```typescript
interface UseChatReturn {
  /** All messages in the conversation (user + assistant). */
  messages: Message[];

  /** Current input field value. */
  input: string;

  /** Set the input field value. */
  setInput: (value: string) => void;

  /** Set the messages array directly. */
  setMessages: (messages: Message[]) => void;

  /** Submit the current input as a new user message. */
  handleSubmit: (e?: React.FormEvent) => void;

  /** Whether a request is in progress. */
  isLoading: boolean;

  /** The most recent error, or null. */
  error: Error | null;

  /** Tool calls made during the current or most recent request. */
  toolCalls: ToolCall[];

  /** Abort the current streaming request. */
  stop: () => void;

  /** Re-send the last user message and regenerate the response. */
  reload: () => void;

  /** Append a message manually (without triggering a request). */
  append: (message: Message) => void;
}
```

## Quick example

```tsx
import createUseChat from "seepient/react";

const useChat = await createUseChat();

function ChatPage() {
  const { messages, input, setInput, handleSubmit, isLoading } = useChat();

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            {msg.content}
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading}>
          {isLoading ? "Thinking..." : "Send"}
        </button>
      </form>
    </div>
  );
}
```

## SSE streaming

`useChat` connects to your backend via Server-Sent Events (SSE). The response streams in real time -- the assistant message updates progressively as tokens arrive.

The hook expects the backend to return an SSE stream using Seepient Agent's `streamText().toResponse()` format:

```
event: text
data: {"delta":"Hello"}

event: text
data: {"delta":" world"}

event: tool_call
data: {"id":"call_abc123","name":"web_search","arguments":{"query":"..."}}

event: tool_result
data: {"id":"call_abc123","result":"..."}

event: done
data: {"usage":{"totalTokens":470,"cost":0},"finishReason":"stop"}
```

::: tip
The SSE format is the same one produced by `stream.toResponse()`. No custom serialization needed on the backend.
:::

## Tool call tracking

The `toolCalls` return value provides visibility into tool usage during the current or most recent response. It uses the core `ToolCall` type:

```typescript
interface ToolCall {
  /** Unique tool call identifier. */
  id: string;
  /** Tool name, e.g. "web_search". */
  name: string;
  /** Arguments passed to the tool. */
  arguments: Record<string, unknown>;
  /** Tool execution result, available once execution completes. */
  result?: string;
}
```

### Displaying tool calls

```tsx
function ChatWithTools() {
  const { messages, toolCalls, input, setInput, handleSubmit, isLoading } =
    useChat({
      api: "/api/chat",
    });

  return (
    <div>
      {/* Messages */}
      {messages.map((msg) => (
        <div key={msg.id} className={msg.role}>
          {msg.content}
        </div>
      ))}

      {/* Tool call indicators */}
      {toolCalls.length > 0 && (
        <div className="tool-calls">
          {toolCalls.map((tc) => (
            <div key={tc.id} className="tool-call">
              <span className="tool-name">{tc.name}</span>
              {tc.result ? (
                <span className="tool-done">done</span>
              ) : (
                <span className="tool-running">running...</span>
              )}
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading}>Send</button>
      </form>
    </div>
  );
}
```

## Full component example

A production-ready chat component with streaming, tool display, error handling, and abort support:

```tsx
import createUseChat from "seepient/react";

const useChat = await createUseChat();

function ChatApp() {
  const {
    messages,
    input,
    setInput,
    handleSubmit,
    isLoading,
    error,
    toolCalls,
    stop,
    reload,
  } = useChat({
    api: "/api/chat",
    onError: (err) => console.error("Chat error:", err),
    onFinish: (msg) => console.log("Response complete:", msg.id),
  });

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      {/* Message history */}
      <div style={{ minHeight: 400 }}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              padding: 12,
              marginBottom: 8,
              background: msg.role === "user" ? "#e3f2fd" : "#f5f5f5",
              borderRadius: 8,
            }}
          >
            <strong>{msg.role === "user" ? "You" : "Assistant"}</strong>
            <p style={{ margin: "4px 0 0" }}>{msg.content}</p>
          </div>
        ))}

        {/* Active tool calls */}
        {isLoading && toolCalls.map((tc) => (
          <div
            key={tc.id}
            style={{ padding: 8, background: "#fff3e0", borderRadius: 4, marginBottom: 4 }}
          >
            Calling {tc.name}({JSON.stringify(tc.arguments).slice(0, 60)}...)
            {tc.result && <span> -- done</span>}
          </div>
        ))}
      </div>

      {/* Error display */}
      {error && (
        <div style={{ color: "red", padding: 8, marginBottom: 8 }}>
          Error: {error.message}
        </div>
      )}

      {/* Input form */}
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask something..."
          style={{ flex: 1, padding: 8, borderRadius: 4, border: "1px solid #ccc" }}
          disabled={isLoading}
        />
        {isLoading ? (
          <button
            type="button"
            onClick={stop}
            style={{ padding: "8px 16px", background: "#ef5350", color: "white", border: "none", borderRadius: 4 }}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            style={{ padding: "8px 16px", background: "#1976d2", color: "white", border: "none", borderRadius: 4 }}
          >
            Send
          </button>
        )}
        {!isLoading && messages.length > 0 && (
          <button
            type="button"
            onClick={reload}
            style={{ padding: "8px 16px", border: "1px solid #ccc", borderRadius: 4 }}
          >
            Retry
          </button>
        )}
      </form>
    </div>
  );
}

export default ChatApp;
```

## Backend integration

### Express

```typescript
import express from "express";
import { streamText } from "seepient";

const app = express();
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;

  // Use the last user message as the prompt
  const lastMessage = messages.filter((m: { role: string }) => m.role === "user").pop();
  const prompt = lastMessage?.content ?? "";

  const stream = await streamText(prompt, {
    tools: ["web_search"],
  });

  return stream.toResponse();
});

app.listen(3000);
```

### Hono

```typescript
import { Hono } from "hono";
import { streamText } from "seepient";

const app = new Hono();

app.post("/api/chat", async (c) => {
  const { messages } = await c.req.json();

  const lastMessage = messages
    .filter((m: { role: string }) => m.role === "user")
    .pop();
  const prompt = lastMessage?.content ?? "";

  const stream = await streamText(prompt, {
    tools: ["web_search"],
  });

  return stream.toResponse();
});

export default app;
```

::: info
`stream.toResponse()` returns a standard Web API `Response` with SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`). It works with Express, Hono, Next.js Route Handlers, and any framework that supports the Web API `Response` object.
:::

### With agent session

For multi-turn conversations, create a persistent agent and map sessions to users:

```typescript
import express from "express";
import { createAgent } from "seepient";

const app = express();
app.use(express.json());

// Map user IDs to agents
const agents = new Map<string, Awaited<ReturnType<typeof createAgent>>>();

app.post("/api/chat", async (req, res) => {
  const { messages, sessionId } = req.body;

  // Get or create agent for this session
  let agent = agents.get(sessionId);
  if (!agent) {
    agent = await createAgent({
      persist: `./sessions/${sessionId}`,
      tools: ["core", "web_search"],
    });
    agents.set(sessionId, agent);
  }

  const lastMessage = messages.filter((m: { role: string }) => m.role === "user").pop();
  const prompt = lastMessage?.content ?? "";

  const stream = await agent.chatStream(prompt);
  return stream.toResponse();
});

app.listen(3000);
```

## Configuration

### Custom API endpoint

```tsx
const { messages, input, handleSubmit } = useChat({
  api: "https://api.example.com/v1/chat",
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
```

### Initial messages

Pre-populate the chat with existing messages:

```tsx
const { messages } = useChat({
  initialMessages: [
    {
      id: "1",
      role: "assistant",
      content: "Hello! How can I help you today?",
      timestamp: Date.now(),
    },
  ],
});
```

### Error and finish callbacks

```tsx
const { messages, input, handleSubmit } = useChat({
  onError: (error) => {
    toast.error(`Chat error: ${error.message}`);
  },
  onFinish: (message) => {
    analytics.track("chat_response", {
      messageId: message.id,
      contentLength: message.content.length,
    });
  },
});
```

### Extra body fields

Pass additional data to the backend with each request:

```tsx
const { messages, input, handleSubmit } = useChat({
  body: {
    userId: currentUser.id,
    sessionId: session.id,
  },
});
```

## Related APIs

- [streamText()](/sdk/stream-text) -- Backend SSE streaming with `toResponse()`
- [createAgent()](/sdk/create-agent) -- Stateful agent with `chatStream()`
- [Session Persistence](/sdk/session-persistence) -- Managing agent sessions
- [Types](/sdk/types) -- Full TypeScript type reference
