/**
 * WS egress backpressure pin (R3, pass-10 P2-1): a connection whose send
 * buffer exceeds the cap is closed instead of buffering without bound in the
 * shared process.
 */
import { describe, it, expect, vi } from "vitest";
import { safeSend } from "../connection-registry.js";

function fakeWs(bufferedAmount: number) {
  return {
    readyState: 1,
    bufferedAmount,
    send: vi.fn(),
    close: vi.fn(),
  } as never as import("../ws-types.js").WebSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

describe("safeSend egress backpressure", () => {
  it("sends while the buffer is under the cap", () => {
    const ws = fakeWs(1024);
    safeSend(ws, { type: "text", delta: "x" } as never);
    expect((ws as any).send).toHaveBeenCalledOnce();
    expect((ws as any).close).not.toHaveBeenCalled();
  });

  it("closes (1013) without sending once the buffer exceeds 4 MiB", () => {
    const ws = fakeWs(4 * 1024 * 1024 + 1);
    safeSend(ws, { type: "text", delta: "x" } as never);
    expect((ws as any).send).not.toHaveBeenCalled();
    expect((ws as any).close).toHaveBeenCalledWith(1013, expect.stringContaining("not reading"));
  });
});
