---
title: Build Your Own Chat UI
description: Tutorial for building a chat interface with React and Seepient Agent's streaming API.
---

# Build Your Own Chat UI

Build a real-time chat interface powered by Seepient Agent's streaming API. This tutorial walks you through creating a full-stack chat application with React on the frontend and Express on the backend.

## Prerequisites

- Node.js 18+
- A running Seepient Agent server or a Seepient Agent SDK installation
- An LLM provider API key (OpenAI, Anthropic, or GLM)
- Basic familiarity with React and Express

## Architecture Overview

```
Browser (React)  -->  Express Server  -->  Seepient Agent SDK  -->  LLM Provider
     |                     |
     |  SSE stream         |  streamText()
     |<--------------------|  toResponse()
```

The React frontend sends chat messages to an Express endpoint. The server calls `streamText()` and converts the result into a Server-Sent Events (SSE) response using `toResponse()`. The frontend reads the SSE stream to display text in real time.

## Step 1: Set Up the Backend

Create an Express server that uses Seepient Agent's `streamText` function.

```bash
mkdir seepient-chat && cd seepient-chat
npm init -y
npm install express cors seepient
```

Create `server.js`:

```javascript
import express from "express";
import cors from "cors";
import { streamText } from "seepient";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Chat endpoint — returns SSE stream
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const stream = await streamText(message, {
      tools: ["core"],            // enable shell, file read/write, datetime
      maxSteps: 5,
      onToolCall: (tool) => {
        console.log(`[Tool] ${tool.name}`, tool.args);
      },
    });

    // Convert to SSE Response and pipe to Express
    const response = stream.toResponse();
    const headers = Object.fromEntries(response.headers.entries());
    res.writeHead(200, headers);

    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    };
    pump().catch(() => res.end());
  } catch (err) {
    console.error("Stream error:", err);
    res.status(500).json({ error: "Generation failed" });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Chat server running on http://localhost:${PORT}`);
});
```

::: tip Environment Variables
Set your provider API key before starting the server:

```bash
export OPENAI_API_KEY=sk-...
# or
export ANTHROPIC_API_KEY=sk-ant-...
```

Seepient Agent auto-detects available providers based on environment variables.
:::

## Step 2: Set Up the React Frontend

Create the React application:

```bash
npm create vite@latest client -- --template react
cd client
npm install
```

No additional Seepient Agent packages are needed on the client. The frontend communicates with the backend via HTTP.

## Step 3: Create the Chat Component

Create `src/Chat.jsx`:

```jsx
import { useState, useRef, useCallback } from "react";

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef(null);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isStreaming) return;

    const userMessage = { role: "user", content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsStreaming(true);

    // Placeholder for assistant response
    let assistantText = "";
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const response = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input }),
      });

      if (!response.ok) throw new Error("Request failed");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      abortRef.current = reader;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("event: text")) {
            // Next data line contains the text delta
          } else if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "text" || event.delta) {
                const delta = event.delta || event.content || "";
                assistantText += delta;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: assistantText,
                  };
                  return updated;
                });
              }
            } catch {
              // Not JSON — may be raw text delta
              assistantText += line.slice(6);
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: assistantText,
                };
                return updated;
              });
            }
          }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: "Error: Failed to get response.",
          };
          return updated;
        });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [input, isStreaming]);

  const handleAbort = () => {
    if (abortRef.current) {
      abortRef.current.cancel();
      setIsStreaming(false);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h2>Seepient Agent Chat</h2>

      <div
        style={{
          height: 480,
          overflowY: "auto",
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: 16,
          marginBottom: 16,
        }}
      >
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              marginBottom: 12,
              textAlign: msg.role === "user" ? "right" : "left",
            }}
          >
            <span
              style={{
                display: "inline-block",
                padding: "8px 14px",
                borderRadius: 12,
                background:
                  msg.role === "user" ? "#007bff" : "#f0f0f0",
                color: msg.role === "user" ? "white" : "black",
                maxWidth: "80%",
                whiteSpace: "pre-wrap",
              }}
            >
              {msg.content || (
                <span style={{ opacity: 0.5 }}>Thinking...</span>
              )}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="Type a message..."
          disabled={isStreaming}
          style={{
            flex: 1,
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #ddd",
            fontSize: 14,
          }}
        />
        {isStreaming ? (
          <button
            onClick={handleAbort}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: "#dc3545",
              color: "white",
              cursor: "pointer",
            }}
          >
            Stop
          </button>
        ) : (
          <button
            onClick={sendMessage}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: "#007bff",
              color: "white",
              cursor: "pointer",
            }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
```

Update `src/App.jsx`:

```jsx
import Chat from "./Chat";

export default function App() {
  return <Chat />;
}
```

## Step 4: Add Tool Call Display

When Seepient Agent executes a tool during generation, the SSE stream emits `tool_call` and `tool_result` events. Extend the message parsing to display these:

```jsx
// Add to the SSE parsing loop inside sendMessage:
if (event.type === "tool_call") {
  setMessages((prev) => {
    const updated = [...prev];
    updated[updated.length - 1] = {
      role: "assistant",
      content: assistantText,
      toolCalls: [
        ...(updated[updated.length - 1].toolCalls || []),
        {
          name: event.name,
          args: event.args,
          pending: true,
        },
      ],
    };
    return updated;
  });
}

if (event.type === "tool_result") {
  setMessages((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    const calls = [...(last.toolCalls || [])];
    const idx = calls.findIndex((c) => c.name === event.callId);
    if (idx >= 0) {
      calls[idx] = { ...calls[idx], pending: false, result: event.output };
    }
    updated[updated.length - 1] = {
      ...last,
      toolCalls: calls,
    };
    return updated;
  });
}
```

Then render tool calls inline with each message:

```jsx
{msg.toolCalls?.map((tc, j) => (
  <div
    key={j}
    style={{
      marginTop: 8,
      padding: 8,
      borderRadius: 6,
      background: "#e8f4fd",
      fontSize: 13,
    }}
  >
    <strong>{tc.name}</strong>
    {tc.pending ? (
      <span style={{ color: "#888" }}> running...</span>
    ) : (
      <pre style={{ margin: "4px 0 0", fontSize: 12 }}>
        {tc.result?.slice(0, 200)}
      </pre>
    )}
  </div>
))}
```

## Step 5: Add Streaming Indicators

Show a typing indicator while the model is generating a response. The empty content check in the message rendering already shows "Thinking..." text. You can enhance this with a CSS animation:

```css
/* Add to your CSS */
@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.typing-indicator span {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin: 0 2px;
  border-radius: 50%;
  background: #888;
  animation: pulse 1.2s infinite;
}

.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
```

Replace the "Thinking..." text with:

```jsx
<span className="typing-indicator">
  <span></span><span></span><span></span>
</span>
```

## Running the Application

Start both servers:

```bash
# Terminal 1: Backend
node server.js

# Terminal 2: Frontend
cd client && npm run dev
```

Open `http://localhost:5173` in your browser and start chatting.

## Styling Tips

- **Use a monospace font** for tool call results to improve readability of structured output.
- **Limit message width** to 80% of the container and align user messages to the right.
- **Add markdown rendering** with a library like `react-markdown` for formatted assistant responses.
- **Show token usage** by capturing the `done` SSE event, which includes `usage.totalTokens` and `usage.cost`.
- **Persist chat history** by storing messages in `localStorage` or connecting to Seepient Agent's session API.

## Common Pitfalls

::: warning CORS Configuration
If the frontend and backend run on different ports, ensure CORS is configured on the Express server. The example above uses the `cors` middleware with default (allow-all) settings. In production, restrict this to your frontend origin.
:::

::: warning SSE Event Parsing
The `data:` lines in SSE streams may be split across multiple `read()` calls. For production use, consider a dedicated SSE parsing library or buffer partial lines before parsing.
:::

## Next Steps

- [Deploy as a Backend](/guides/deploy-as-backend) -- put your chat server into production
- [Custom Tools Guide](/guides/custom-tools-guide) -- add specialized tools to your agent
- [Tools Reference](/tools/reference) -- browse all 12 built-in tools
