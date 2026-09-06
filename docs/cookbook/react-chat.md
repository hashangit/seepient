---
title: React chat UI
description: Build a real-time streaming web chat interface connected to Seepient.
---

# React chat UI

This recipe shows how to connect a React web frontend to Seepient's streaming API, rendering text tokens, reasoning blocks, and tool executions.

---

## 1. Backend: Express streaming endpoint

Install backend dependencies:

```bash
pnpm add express cors seepient
```

Create `server.ts`:

```typescript
import express from 'express'
import cors from 'cors'
import { askSeepient } from 'seepient'

const app = express()
app.use(cors())
app.use(express.json())

app.post('/api/chat', async (req, res) => {
  const { message } = req.body
  if (!message) {
    return res.status(400).json({ error: 'message is required' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const stream = await askSeepient(message, {
    stream: true,
    provider: 'anthropic',
    model: 'claude-3-7-sonnet'
  })

  for await (const chunk of stream) {
    if (chunk.type === 'text_delta') {
      res.write(`data: ${JSON.stringify({ text: chunk.delta })}\n\n`)
    } else if (chunk.type === 'tool_call') {
      res.write(`data: ${JSON.stringify({ tool: chunk.toolName })}\n\n`)
    }
  }

  res.write('data: [DONE]\n\n')
  res.end()
})

app.listen(3001, () => console.log('Server listening on port 3001'))
```

---

## 2. Frontend: React chat component

Create `Chat.tsx`:

```tsx
import React, { useState } from 'react'

interface Message {
  role: 'user' | 'agent'
  text: string
}

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim() || isStreaming) return

    const userMessage: Message = { role: 'user', text: input }
    setMessages((prev) => [...prev, userMessage, { role: 'agent', text: '' }])
    setInput('')
    setIsStreaming(true)

    const response = await fetch('http://localhost:3001/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: input })
    })

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    while (reader) {
      const { done, value } = await reader.read()
      if (done) break

      const lines = decoder.decode(value).split('\n\n')
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.replace('data: ', '').trim()
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          if (parsed.text) {
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              last.text += parsed.text
              return updated
            })
          }
        } catch (_) {}
      }
    }

    setIsStreaming(false)
  }

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: 20 }}>
      <div style={{ minHeight: 400, border: '1px solid #ddd', padding: 15, marginBottom: 15 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <strong>{m.role === 'user' ? 'You' : 'Seepient'}:</strong> {m.text}
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 10 }}>
        <input
          style={{ flex: 1, padding: 10 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Seepient..."
          disabled={isStreaming}
        />
        <button style={{ padding: '10px 20px' }} type="submit" disabled={isStreaming}>
          {isStreaming ? 'Thinking...' : 'Send'}
        </button>
      </form>
    </div>
  )
}
```
