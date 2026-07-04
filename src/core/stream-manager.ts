/**
 * Seepient Core — StreamManager
 *
 * Shared streaming queue management for text deltas, step results,
 * and SSE conversion. Eliminates duplication between SDK's streamText()
 * and agent's chatStream().
 *
 * Pattern: push-based queues with resolver-based backpressure.
 * Producers call enqueueText/enqueueStep; consumers iterate via
 * textStream/stepsStream async iterables.
 */

import type { StepResult, Usage } from "./types.js";

// ── SSE helper ────────────────────────────────────────────────────────────

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── StreamManager ─────────────────────────────────────────────────────────

export class StreamManager {
  // Queues for individual consumers
  private textQueue: string[] = [];
  private stepQueue: StepResult[] = [];

  // Unified event queue preserving interleaved insertion order for SSE
  private eventQueue: Array<
    { type: "text"; delta: string } | { type: "step"; step: StepResult }
  > = [];

  // Done flags
  private textDone = false;
  private stepsDone = false;
  private eventsDone = false;

  // Resolvers for backpressure
  private textResolver: (() => void) | null = null;
  private stepResolver: (() => void) | null = null;
  private eventResolver: (() => void) | null = null;

  // Result promises
  private textResolve!: (text: string) => void;
  private usageResolve!: (usage: Usage) => void;
  private finishResolve!: (reason: string) => void;

  readonly fullText: Promise<string>;
  readonly usage: Promise<Usage>;
  readonly finishReason: Promise<string>;

  constructor() {
    this.fullText = new Promise<string>((r) => { this.textResolve = r; });
    this.usage = new Promise<Usage>((r) => { this.usageResolve = r; });
    this.finishReason = new Promise<string>((r) => { this.finishResolve = r; });
  }

  // ── Producer API ──────────────────────────────────────────────────────

  /** Enqueue a text delta and wake any waiting consumer. */
  enqueueText(delta: string): void {
    this.textQueue.push(delta);
    this.eventQueue.push({ type: "text", delta });
    if (this.textResolver) {
      this.textResolver();
      this.textResolver = null;
    }
    if (this.eventResolver) {
      this.eventResolver();
      this.eventResolver = null;
    }
  }

  /** Enqueue a step result and wake any waiting consumer. */
  enqueueStep(step: StepResult): void {
    this.stepQueue.push(step);
    this.eventQueue.push({ type: "step", step });
    if (this.stepResolver) {
      this.stepResolver();
      this.stepResolver = null;
    }
    if (this.eventResolver) {
      this.eventResolver();
      this.eventResolver = null;
    }
  }

  /** Resolve the fullText promise. */
  resolveText(text: string): void {
    this.textResolve(text);
  }

  /** Resolve the usage promise. */
  resolveUsage(usage: Usage): void {
    this.usageResolve(usage);
  }

  /** Resolve the finishReason promise. */
  resolveFinish(reason: string): void {
    this.finishResolve(reason);
  }

  /** Signal completion: set done flags and wake any waiting consumers. */
  complete(): void {
    this.textDone = true;
    this.stepsDone = true;
    this.eventsDone = true;
    if (this.textResolver) {
      this.textResolver();
      this.textResolver = null;
    }
    if (this.stepResolver) {
      this.stepResolver();
      this.stepResolver = null;
    }
    if (this.eventResolver) {
      this.eventResolver();
      this.eventResolver = null;
    }
  }

  // ── Consumer API ──────────────────────────────────────────────────────

  /** Async iterable of text deltas. */
  get textStream(): AsyncIterable<string> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (self.textQueue.length === 0 && !self.textDone) {
              await new Promise<void>((r) => { self.textResolver = r; });
            }
            if (self.textQueue.length > 0) {
              return { value: self.textQueue.shift()!, done: false };
            }
            return { value: undefined, done: true } as IteratorResult<string>;
          },
        };
      },
    };
  }

  /** Async iterable of step results. */
  get stepsStream(): AsyncIterable<StepResult> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (self.stepQueue.length === 0 && !self.stepsDone) {
              await new Promise<void>((r) => { self.stepResolver = r; });
            }
            if (self.stepQueue.length > 0) {
              return { value: self.stepQueue.shift()!, done: false };
            }
            return { value: undefined, done: true } as IteratorResult<StepResult>;
          },
        };
      },
    };
  }

  /**
   * Returns a ReadableStream that pipes text deltas and tool events as SSE.
   *
   * Events emitted:
   *  - `text`        — { delta: string }
   *  - `tool_call`   — { callId, name, args }
   *  - `tool_result` — { callId, output, success }
   *  - `done`        — { usage: { totalTokens, cost }, finishReason }
   */
  toSSEStream(): ReadableStream {
    const encoder = new TextEncoder();
    const self = this;

    return new ReadableStream({
      async start(controller) {
        try {
          // Drain unified event queue preserving interleaved order
          while (true) {
            while (self.eventQueue.length === 0 && !self.eventsDone) {
              await new Promise<void>((r) => { self.eventResolver = r; });
            }
            if (self.eventQueue.length === 0) break;

            const event = self.eventQueue.shift()!;
            if (event.type === "text") {
              controller.enqueue(encoder.encode(sseLine("text", { delta: event.delta })));
            } else if (event.type === "step" && event.step.type === "tool_call" && event.step.toolCall) {
              controller.enqueue(
                encoder.encode(
                  sseLine("tool_call", {
                    callId: event.step.toolCall.id,
                    name: event.step.toolCall.name,
                    args: event.step.toolCall.args,
                  }),
                ),
              );
              controller.enqueue(
                encoder.encode(
                  sseLine("tool_result", {
                    callId: event.step.toolCall.id,
                    output: event.step.toolCall.result,
                    success: true,
                  }),
                ),
              );
            }
          }

          // Done event
          const [usage, finishReason] = await Promise.all([
            self.usage,
            self.finishReason,
          ]);

          controller.enqueue(
            encoder.encode(
              sseLine("done", {
                usage: {
                  totalTokens: usage.totalTokens,
                  cost: usage.cost,
                },
                finishReason,
              }),
            ),
          );
        } catch (err) {
          if (err instanceof Error && err.name !== "AbortError") {
            console.warn("[StreamManager] SSE stream error:", err);
          }
        } finally {
          controller.close();
        }
      },
    });
  }

  /** Returns a Web API Response wrapping the SSE stream. */
  toResponse(): Response {
    return new Response(this.toSSEStream(), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}
