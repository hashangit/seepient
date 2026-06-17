import { describe, it, expect } from "vitest";
import {
  AllowlistIdentityResolver,
  createIdentityResolver,
  registerIdentityResolver,
} from "../identity-resolver.js";
import type { ResolveInput } from "../identity-resolver.js";

function input(senderId: string, over?: Partial<ResolveInput>): ResolveInput {
  return {
    platform: "telegram",
    platformSenderId: senderId,
    conversationId: "chat-1",
    conversationType: "dm",
    botId: "bot-1",
    ...over,
  };
}

const cfg = {
  platforms: {
    telegram: { allowlist: ["111", "222"], admins: ["111"] },
  },
  displayNames: { "telegram:111": "Alice" },
  cacheTtlMs: 1000,
};

describe("AllowlistIdentityResolver", () => {
  it("authorizes an allowlisted sender and resolves a canonical userId + role", async () => {
    const resolver = new AllowlistIdentityResolver(cfg);
    const r = await resolver.resolve(input("222"));
    expect(r.authorized).toBe(true);
    expect(r.userId).toBe("telegram:222");
    expect(r.role).toBe("member");
  });

  it("promotes admins to the admin role", async () => {
    const resolver = new AllowlistIdentityResolver(cfg);
    const r = await resolver.resolve(input("111"));
    expect(r.authorized).toBe(true);
    expect(r.role).toBe("admin");
    // Display name override applies.
    expect(r.displayName).toBe("Alice");
  });

  it("denies a non-allowlisted sender with a reason", async () => {
    const resolver = new AllowlistIdentityResolver(cfg);
    const r = await resolver.resolve(input("999"));
    expect(r.authorized).toBe(false);
    expect(r.role).toBe("guest");
    expect(r.reason).toMatch(/not on the allowlist/);
    // Canonical userId is still assigned for audit.
    expect(r.userId).toBe("telegram:999");
  });

  it("denies when no allowlist is configured for the platform", async () => {
    const resolver = new AllowlistIdentityResolver(cfg);
    const r = await resolver.resolve(input("111", { platform: "discord" }));
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/No allowlist configured/);
  });

  it("is idempotent — same input resolves to the same userId across calls", async () => {
    const resolver = new AllowlistIdentityResolver(cfg);
    const a = await resolver.resolve(input("222"));
    const b = await resolver.resolve(input("222"));
    expect(a.userId).toBe(b.userId);
    expect(a.role).toBe(b.role);
  });

  it("returns cached results within the TTL window", async () => {
    // Use a fresh resolver with a long TTL; mutate the underlying config by
    // creating a second resolver to prove the cache hit path.
    const resolver = new AllowlistIdentityResolver({ ...cfg, cacheTtlMs: 60_000 });
    const first = await resolver.resolve(input("111"));
    const cached = await resolver.resolve(input("111"));
    expect(cached).toBe(first); // same object reference → cache hit
  });

  it("falls back to senderName / raw id for displayName", async () => {
    const resolver = new AllowlistIdentityResolver(cfg);
    const r = await resolver.resolve(input("222", { senderName: "Bob" }));
    expect(r.displayName).toBe("Bob");
  });
});

describe("identity resolver registry", () => {
  it("createIdentityResolver defaults to the allowlist resolver", () => {
    const resolver = createIdentityResolver({ type: "allowlist", platforms: cfg.platforms });
    expect(resolver).toBeInstanceOf(AllowlistIdentityResolver);
  });

  it("registerIdentityResolver allows custom resolvers", async () => {
    registerIdentityResolver("custom", (config) => ({
      resolve: async (inp) => ({
        authorized: true,
        userId: `custom:${inp.platformSenderId}`,
        role: (config.role as any) ?? "member",
        displayName: inp.senderName ?? inp.platformSenderId,
      }),
    }));

    const resolver = createIdentityResolver({ type: "custom", role: "admin" });
    const r = await resolver.resolve(input("123"));
    expect(r.userId).toBe("custom:123");
    expect(r.role).toBe("admin");
  });

  it("throws on unknown resolver type", () => {
    expect(() => createIdentityResolver({ type: "nope" })).toThrow(/Unknown identity resolver type/);
  });
});
