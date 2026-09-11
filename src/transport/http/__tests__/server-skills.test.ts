import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { runSeepientServer } from "../index.js";
import { generateApiKey } from "../../auth/auth.js";
import { handleListSkills } from "../../ws/session-control.js";
import { createConnectionRegistry } from "../../ws/connection-registry.js";
import type { ConnectionState, WebSocketHandlerContext, ListSkillsMessage } from "../../ws/ws-types.js";

describe("Server Skills Parity & Scope (Spec 022-1, US5 / FR-037)", () => {
  let activeServers: Array<http.Server & { dispose?: () => void }> = [];
  let tempKeyPath: string;
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-server-skills-"));
    process.chdir(tempDir);

    tempKeyPath = path.join(
      tempDir,
      `test-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const s of activeServers) {
      if (s.dispose) s.dispose();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    activeServers = [];
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("GET /v1/skills rejects unauthenticated requests with 401", async () => {
    const server = await runSeepientServer({ port: 0 });
    activeServers.push(server);
    const addr = server.address() as any;
    const port = addr.port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/skills`);
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  it("GET /v1/skills rejects API key lacking 'agent:read' scope with 403", async () => {
    const keyEntry = generateApiKey(["agent:run"], { filePath: tempKeyPath, label: "run-only" });

    const server = await runSeepientServer({ port: 0 });
    activeServers.push(server);
    const addr = server.address() as any;
    const port = addr.port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/skills`, {
      headers: {
        Authorization: `Bearer ${keyEntry.rawKey}`,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(body.error?.message).toContain("agent:read");
  });

  it("GET /v1/skills succeeds with 'agent:read' scope and dynamically reflects new skills without restart", async () => {
    const keyEntry = generateApiKey(["agent:read"], { filePath: tempKeyPath, label: "read-key" });

    const server = await runSeepientServer({ port: 0 });
    activeServers.push(server);
    const addr = server.address() as any;
    const port = addr.port;

    // 1. Initial request: empty skills
    const res1 = await fetch(`http://127.0.0.1:${port}/v1/skills`, {
      headers: {
        Authorization: `Bearer ${keyEntry.rawKey}`,
      },
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as any;
    expect(Array.isArray(body1.skills)).toBe(true);
    expect(body1.skills.find((s: any) => s.name === "dynamic-skill")).toBeUndefined();

    // 2. Add skill to disk in workspace
    const skillDir = path.join(tempDir, ".seepient", "skills", "dynamic-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: dynamic-skill\ndescription: dynamically added skill\ntags: [test, dynamic]\n---\nSkill dynamic body\n`,
      "utf8",
    );

    // 3. Second request: should dynamically reflect without server restart
    const res2 = await fetch(`http://127.0.0.1:${port}/v1/skills`, {
      headers: {
        Authorization: `Bearer ${keyEntry.rawKey}`,
      },
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as any;
    expect(Array.isArray(body2.skills)).toBe(true);
    const dynamicSkill = body2.skills.find((s: any) => s.name === "dynamic-skill");
    expect(dynamicSkill).toBeDefined();
    expect(dynamicSkill.description).toBe("dynamically added skill");
    expect(dynamicSkill.tags).toContain("dynamic");
  });

  it("WS list_skills rejects connection lacking 'agent:read' with FORBIDDEN error frame", async () => {
    const sentMessages: any[] = [];
    const mockWs = {
      readyState: 1, // OPEN
      send: (data: string) => {
        sentMessages.push(JSON.parse(data));
      },
    } as any;

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "h1",
      apiKey: {
        keyHash: "h1",
        label: "run-only",
        scopes: ["agent:run"],
        created: new Date().toISOString(),
      },
    };

    const ctx: WebSocketHandlerContext = {
      registry: createConnectionRegistry(),
      sessionManager: {} as any,
      streamText: vi.fn() as any,
      listModels: () => ({}),
      listSkills: async () => [{ name: "s1", description: "d1", version: "1.0.0", tags: [] }],
    };

    const msg: ListSkillsMessage = {
      type: "list_skills",
      id: "req-123",
    };

    await handleListSkills(mockWs, msg, state, ctx);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].type).toBe("error");
    expect(sentMessages[0].code).toBe("FORBIDDEN");
    expect(sentMessages[0].message).toContain("agent:read");
    expect(sentMessages[0].clientMsgId).toBe("req-123");
  });

  it("WS list_skills sends skills_list frame when connection has 'agent:read' scope", async () => {
    const sentMessages: any[] = [];
    const mockWs = {
      readyState: 1, // OPEN
      send: (data: string) => {
        sentMessages.push(JSON.parse(data));
      },
    } as any;

    const state: ConnectionState = {
      sessionId: null,
      activeChats: new Set(),
      activeProvider: null,
      activeModel: null,
      apiKeyHash: "h2",
      apiKey: {
        keyHash: "h2",
        label: "read-key",
        scopes: ["agent:read"],
        created: new Date().toISOString(),
      },
    };

    const ctx: WebSocketHandlerContext = {
      registry: createConnectionRegistry(),
      sessionManager: {} as any,
      streamText: vi.fn() as any,
      listModels: () => ({}),
      listSkills: async () => [{ name: "s1", description: "d1", version: "1.0.0", tags: ["tag1"] }],
    };

    const msg: ListSkillsMessage = {
      type: "list_skills",
      id: "req-456",
    };

    await handleListSkills(mockWs, msg, state, ctx);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].type).toBe("skills_list");
    expect(sentMessages[0].clientMsgId).toBe("req-456");
    expect(sentMessages[0].skills).toEqual([{ name: "s1", description: "d1", version: "1.0.0", tags: ["tag1"] }]);
  });
});
