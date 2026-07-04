---
title: React Chat Application
description: Complete React + Express chat application with streaming, tool visualization, and session management.
---

# React Chat Application

A full-stack chat application built with React and Seepient Agent. Features real-time streaming, tool call visualization, and a clean chat interface.

## Architecture

```
React Frontend (Vite)  -->  Express Backend  -->  Seepient Agent SDK  -->  LLM
     |                           |
     |  SSE stream               |  streamText()
     |<--------------------------|  toResponse()
```

## Backend: Express Server

Create the project and install dependencies:

```bash
mkdir seepient-react-chat && cd seepient-react-chat
mkdir server client
cd server
npm init -y
npm install express cors seepient
```

Create `server/index.js`:

```javascript
import express from "express";
import cors from "cors";
import { streamText } from "seepient";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// POST /api/chat — streaming chat endpoint
app.post("/api/chat", async (req, res) => {
  const { message, tools } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const stream = await streamText(message, {
      tools: tools || ["core"],
      maxSteps: 8,
    });

    // Convert to SSE Response
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
    console.error("Chat error:", err);
    res.status(500).json({ error: "Generation failed" });
  }
});

// GET /api/health
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

app.listen(PORT, () => {
  console.log(`Seepient Agent chat server running on http://localhost:${PORT}`);
});
```

## Frontend: React Application

Create the React app:

```bash
cd ../client
npm create vite@latest . -- --template react
npm install
```

### Chat Component

Create `src/Chat.jsx`:

```jsx
import { useState, useRef, useEffect, useCallback } from "react";

const API_URL = "http://localhost:3001";

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef(null);
  const abortRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const parseSSEChunk = (chunk, currentText) => {
    const lines = chunk.split("\n");
    let text = currentText;
    const toolCalls = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);

          if (event.type === "text" || event.delta) {
            text += event.delta || event.content || "";
          }

          if (event.name && event.type === "tool_call") {
            toolCalls.push({
              name: event.name,
              args: event.args,
              pending: true,
            });
          }

          if (event.type === "tool_result" && event.output) {
            toolCalls.push({
              name: event.callId,
              result: event.output,
              pending: false,
            });
          }
        } catch {
          // Raw text fallback
          text += data;
        }
      }
    }

    return { text, toolCalls };
  };

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isStreaming) return;

    const userMessage = { role: "user", content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsStreaming(true);

    let assistantText = "";
    const toolCallsList = [];

    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", toolCalls: [] },
    ]);

    try {
      const response = await fetch(`${API_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: input,
          tools: ["core", "web_search"],
        }),
      });

      if (!response.ok) throw new Error("Request failed");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      abortRef.current = reader;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const parsed = parseSSEChunk(chunk, assistantText);
        assistantText = parsed.text;
        toolCallsList.push(...parsed.toolCalls);

        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: assistantText,
            toolCalls: [...toolCallsList],
          };
          return updated;
        });
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: "Error: Failed to get response. Please try again.",
            toolCalls: [],
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
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Seepient Agent Chat</h1>
        <span style={styles.badge}>
          {isStreaming ? "Streaming..." : "Ready"}
        </span>
      </header>

      <div style={styles.messages}>
        {messages.map((msg, i) => (
          <div key={i} style={styles.messageRow(msg.role)}>
            <div style={styles.bubble(msg.role)}>
              <div style={styles.messageText(msg.role)}>
                {msg.content || (
                  <span style={{ opacity: 0.5 }}>Thinking...</span>
                )}
              </div>

              {/* Tool calls display */}
              {msg.toolCalls?.length > 0 && (
                <div style={styles.toolCalls}>
                  {msg.toolCalls.map((tc, j) => (
                    <div key={j} style={styles.toolCall}>
                      <span style={styles.toolName}>
                        {tc.name}
                      </span>
                      {tc.pending ? (
                        <span style={styles.toolPending}>running...</span>
                      ) : tc.result ? (
                        <pre style={styles.toolResult}>
                          {tc.result.slice(0, 200)}
                          {tc.result.length > 200 ? "..." : ""}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div style={styles.inputRow}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="Type a message..."
          disabled={isStreaming}
          style={styles.input}
        />
        {isStreaming ? (
          <button onClick={handleAbort} style={styles.stopButton}>
            Stop
          </button>
        ) : (
          <button onClick={sendMessage} style={styles.sendButton}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    maxWidth: 760,
    margin: "0 auto",
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: "1px solid #e5e7eb",
  },
  title: { margin: 0, fontSize: 20, fontWeight: 600 },
  badge: {
    fontSize: 12,
    padding: "4px 10px",
    borderRadius: 12,
    background: "#f0fdf4",
    color: "#166534",
  },
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 20px",
  },
  messageRow: (role) => ({
    display: "flex",
    justifyContent: role === "user" ? "flex-end" : "flex-start",
    marginBottom: 12,
  }),
  bubble: (role) => ({
    maxWidth: "75%",
    padding: "10px 16px",
    borderRadius: 16,
    background: role === "user" ? "#2563eb" : "#f3f4f6",
    color: role === "user" ? "white" : "#111827",
  }),
  messageText: (role) => ({
    whiteSpace: "pre-wrap",
    lineHeight: 1.5,
    fontSize: 14,
  }),
  toolCalls: { marginTop: 8 },
  toolCall: {
    marginTop: 4,
    padding: "6px 10px",
    borderRadius: 8,
    background: "#eff6ff",
    fontSize: 12,
  },
  toolName: { fontWeight: 600, color: "#1d4ed8" },
  toolPending: { color: "#9ca3af", marginLeft: 6 },
  toolResult: {
    margin: "4px 0 0",
    fontSize: 11,
    whiteSpace: "pre-wrap",
    color: "#374151",
  },
  inputRow: {
    display: "flex",
    gap: 8,
    padding: "16px 20px",
    borderTop: "1px solid #e5e7eb",
  },
  input: {
    flex: 1,
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid #d1d5db",
    fontSize: 14,
    outline: "none",
  },
  sendButton: {
    padding: "10px 20px",
    borderRadius: 12,
    border: "none",
    background: "#2563eb",
    color: "white",
    cursor: "pointer",
    fontWeight: 500,
  },
  stopButton: {
    padding: "10px 20px",
    borderRadius: 12,
    border: "none",
    background: "#dc2626",
    color: "white",
    cursor: "pointer",
    fontWeight: 500,
  },
};
```

### App Entry Point

Update `src/App.jsx`:

```jsx
import Chat from "./Chat";

export default function App() {
  return <Chat />;
}
```

### CSS Reset

Update `src/index.css`:

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
```

## Running the Application

Start both servers in separate terminals:

```bash
# Terminal 1: Backend
cd server
node index.js
# Output: Seepient Agent chat server running on http://localhost:3001

# Terminal 2: Frontend
cd client
npm run dev
# Output: http://localhost:5173
```

Open `http://localhost:5173` in your browser.

## Environment Variables

The backend needs at least one LLM provider API key:

```bash
# Set before starting the server
export OPENAI_API_KEY=sk-...

# Optional: search capability
export TAVILY_API_KEY=tvly-...
```

## What This Example Demonstrates

| Feature | How |
|---|---|
| Streaming text | SSE via `streamText().toResponse()` |
| Tool call visualization | Parsing `tool_call` and `tool_result` SSE events |
| Abort support | Cancel button triggers `reader.cancel()` |
| Auto-scroll | `scrollIntoView` on new messages |
| Error handling | Fallback message on network or generation errors |
| Inline styles | No build dependencies beyond Vite + React |

## Next Steps

- [Build Your Own UI Guide](/guides/build-your-own-ui) -- detailed walkthrough with additional features
- [Deploy as Backend](/guides/deploy-as-backend) -- put this into production
- [Custom Tools Guide](/guides/custom-tools-guide) -- add domain-specific tools
