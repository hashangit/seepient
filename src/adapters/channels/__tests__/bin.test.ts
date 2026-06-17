import { describe, it, expect, vi } from "vitest";

/**
 * Binary bootstrap test (T032/T034) — proves the `zoe-channels` entry wires
 * config → infrastructure → adapters → gateway WITHOUT any network. The
 * Telegram SDK + provider are mocked so the test is hermetic.
 */

// Mock the provider resolver.
vi.mock("../../../core/provider-resolver.js", () => ({
  getProvider: vi.fn(async () => ({
    provider: { chat: async () => ({ content: "ok" }) },
    model: "stub-model",
  })),
}));

// Mock grammY so the Telegram adapter constructs without a real token network.
vi.mock("grammy", () => ({
  Bot: class {
    api: any = {};
    on() {}
    callbackQuery() {}
    async start() {}
    stop() {}
  },
  InlineKeyboard: class {
    text() { return this; }
  },
}));

const { startChannelsBinary, registerPlatformBinary } = await import("../bin.js");
const { TelegramChannelAdapter } = await import("../telegram/adapter.js");

describe("zoe-channels binary bootstrap (T032)", () => {
  it("errors when no channels are enabled", async () => {
    await expect(startChannelsBinary({ config: { channels: {} } })).rejects.toThrow(
      /No channels enabled/,
    );
  });

  it("errors when an enabled platform has no adapter factory", async () => {
    await expect(
      startChannelsBinary({ config: { channels: { enabled: "slack" } } }),
    ).rejects.toThrow(/No adapter factory registered/);
  });

  it("errors when an enabled platform has no token", async () => {
    // Register telegram, but supply no token.
    registerPlatformBinary("telegram", (cfg) =>
      new TelegramChannelAdapter({ token: cfg.token!, webhookUrl: null }),
    );
    await expect(
      startChannelsBinary({ config: { channels: { enabled: "telegram", telegram: {} } } }),
    ).rejects.toThrow(/no token is configured/);
  });

  it("builds the gateway from config and starts it", async () => {
    registerPlatformBinary("telegram", (cfg) =>
      new TelegramChannelAdapter({ token: cfg.token!, webhookUrl: null }),
    );
    const config = {
      channels: {
        enabled: "telegram",
        telegram: { token: "test-token", allowlist: ["111"], admins: ["111"] },
      },
    };
    const { gateway, stop } = await startChannelsBinary({ config, healthPort: null });
    expect(gateway).toBeTruthy();
    // The outbox is wired and started.
    expect(gateway.getOutbox()).toBeTruthy();
    await stop();
  });

  it("parses comma-separated enabled list into multiple platforms", async () => {
    // Register both so parsing is exercised.
    registerPlatformBinary("telegram", (cfg) =>
      new TelegramChannelAdapter({ token: cfg.token!, webhookUrl: null }),
    );
    registerPlatformBinary("discord", () => ({}) as any);
    const config = {
      channels: {
        enabled: "telegram, discord",
        telegram: { token: "t", allowlist: ["1"] },
        discord: { token: "d", allowlist: ["2"] },
      },
    };
    // discord factory returns a bare object missing start() — that surfaces
    // only when the gateway calls start(), so here we just assert the parse
    // did not throw at the "no adapter" / "no token" gate.
    await expect(startChannelsBinary({ config, healthPort: null })).rejects.toThrow(
      /start is not a function|not a function|TypeError/,
    );
  });

  it("surfaces a clear error when no LLM provider is configured", async () => {
    // Override the mocked getProvider to throw, simulating a missing API key.
    const { getProvider } = await import("../../../core/provider-resolver.js");
    (getProvider as any).mockImplementationOnce(async () => {
      throw new Error("No provider is configured");
    });
    const config = {
      channels: {
        enabled: "telegram",
        telegram: { token: "t", allowlist: ["1"] },
      },
    };
    await expect(startChannelsBinary({ config, healthPort: null })).rejects.toThrow(
      /could not resolve an LLM provider/,
    );
  });
});
