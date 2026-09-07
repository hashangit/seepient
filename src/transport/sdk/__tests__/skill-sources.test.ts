import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askSeepient,
  createSeepient,
  FsSkillSources,
  type SkillSource,
  type SkillStore,
  type SkillLiteral,
  saveGeneratedSkill,
  initializeSkillRegistry,
  SkillStoreUnavailableError,
  SkillCollisionError,
} from "../index.js";
import {
  FakeAuditStore,
  FakePolicyStore,
  FakeCapabilityLedger,
  createFakeRuntime,
} from "./helpers/fake-stores.js";

let tmpHome: string;
let tmpCwd: string;

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "seepient-sdk-skill-home-"));
  tmpCwd = mkdtempSync(join(tmpdir(), "seepient-sdk-skill-cwd-"));
  process.env.SEEPIENT_NO_BUNDLED_SKILLS = "1";
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpCwd, { recursive: true, force: true });
  delete process.env.SEEPIENT_NO_BUNDLED_SKILLS;
});

function messageText(msg?: { content: any }): string {
  if (!msg || !msg.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((c: any) => c.text ?? "").join("\n");
  }
  return "";
}

describe("SDK Skill Sources & Inline Tier (Spec 021-1, QS-S1)", () => {
  it("QS-S1: zero-fs agent with inline literals and fake DB source builds working catalog and executes use_skill", async () => {
    let capturedReq: any = null;
    let stepCount = 0;

    const runtime = createFakeRuntime({
      responses: (req) => {
        capturedReq = req;
        stepCount++;
        if (stepCount === 1) {
          return {
            toolCalls: [
              {
                id: "call_1",
                name: "use_skill",
                arguments: { skill_name: "inline-summarize" },
              },
            ],
          };
        }
        return { text: "Summarized successfully." };
      },
    });

    const fakeDbSource: SkillSource = {
      list: () => [
        {
          name: "db-report",
          content: "---\nname: db-report\ndescription: generate report from db\n---\nReport procedure",
          source: "db:global",
        },
      ],
    };

    const literals: SkillLiteral[] = [
      {
        name: "inline-summarize",
        content: "---\nname: inline-summarize\ndescription: summarize text in place\n---\nSummarize procedure body",
      },
    ];

    const result = await askSeepient("Summarize this", {
      cwd: tmpCwd,
      tenancy: "single",
      runtime,
      sources: [fakeDbSource],
      skills: literals,
    });

    expect(result.toolCalls.length).toBe(1);
    const call = result.toolCalls[0];
    expect(call.name).toBe("use_skill");
    const toolStep = result.steps.find((s) => s.type === "tool_call");
    expect(toolStep?.toolCall?.result).toContain("# inline-summarize Skill Activated");
    expect(toolStep?.toolCall?.result).toContain("Summarize procedure body");

    // Check system prompt has both skills
    const sysMsg = capturedReq?.messages?.find((m: any) => m.role === "system");
    expect(messageText(sysMsg)).toContain("inline-summarize: summarize text in place");
    expect(messageText(sysMsg)).toContain("db-report: generate report from db");
  });

  it("createSeepient with inline literals and fake DB source builds working catalog and use_skill executes", async () => {
    let stepCount = 0;
    const runtime = createFakeRuntime({
      responses: () => {
        stepCount++;
        if (stepCount === 1) {
          return {
            toolCalls: [
              {
                id: "call_2",
                name: "use_skill",
                arguments: { skill_name: "db-report" },
              },
            ],
          };
        }
        return { text: "Report executed." };
      },
    });

    const fakeDbSource: SkillSource = {
      list: () => [
        {
          name: "db-report",
          content: "---\nname: db-report\ndescription: generate report from db\n---\nReport procedure body",
          source: "db:tenant",
        },
      ],
    };

    const literals: SkillLiteral[] = [
      {
        name: "inline-tool",
        content: "---\nname: inline-tool\ndescription: inline description\n---\nInline body",
      },
    ];

    const agent = await createSeepient({
      cwd: tmpCwd,
      tenancy: "single",
      runtime,
      sources: [fakeDbSource],
      skills: literals,
    });

    const history = agent.getHistory();
    const sysMsg = history.find((m: any) => m.role === "system");
    expect(messageText(sysMsg)).toContain("db-report: generate report from db");
    expect(messageText(sysMsg)).toContain("inline-tool: inline description");

    const reply = await agent.chat("run db report");
    expect(reply.toolCalls.length).toBe(1);
    const toolMsg = agent.getHistory().find((m: any) => m.role === "tool");
    expect(toolMsg?.content).toContain("# db-report Skill Activated");
    expect(toolMsg?.content).toContain("Report procedure body");
  });

  it("literals shadow an injected source on name collision with attribution inline", async () => {
    let capturedReq: any = null;
    const runtime = createFakeRuntime({
      responses: (req) => {
        capturedReq = req;
        return { text: "Done" };
      },
    });

    const fakeSource: SkillSource = {
      list: () => [
        {
          name: "shadowed",
          content: "---\nname: shadowed\ndescription: from db source\n---\nDB body",
          source: "db:source",
        },
      ],
    };

    const literals: SkillLiteral[] = [
      {
        name: "shadowed",
        content: "---\nname: shadowed\ndescription: from inline literal\n---\nLiteral body",
      },
    ];

    await askSeepient("Test shadow", {
      cwd: tmpCwd,
      tenancy: "single",
      runtime,
      sources: [fakeSource],
      skills: literals,
    });

    const sysMsg = capturedReq?.messages?.find((m: any) => m.role === "system");
    expect(messageText(sysMsg)).toContain("shadowed: from inline literal");
    expect(messageText(sysMsg)).not.toContain("from db source");
  });

  it("skills: ['name'] filters the composed catalog", async () => {
    let capturedReq: any = null;
    const runtime = createFakeRuntime({
      responses: (req) => {
        capturedReq = req;
        return { text: "Done" };
      },
    });

    const fakeSource: SkillSource = {
      list: () => [
        {
          name: "skill-one",
          content: "---\nname: skill-one\ndescription: skill one desc\n---\nBody 1",
          source: "db:source",
        },
        {
          name: "skill-two",
          content: "---\nname: skill-two\ndescription: skill two desc\n---\nBody 2",
          source: "db:source",
        },
      ],
    };

    await askSeepient("Filter test", {
      cwd: tmpCwd,
      tenancy: "single",
      runtime,
      sources: [fakeSource],
      skills: ["skill-one"],
    });

    const sysMsg = capturedReq?.messages?.find((m: any) => m.role === "system");
    expect(messageText(sysMsg)).toContain("skill-one: skill one desc");
    expect(messageText(sysMsg)).not.toContain("skill-two");
  });

  it("literals-only multi-mode call resolves and serves content without downgrade or silent skip", async () => {
    let capturedReq: any = null;
    const runtime = createFakeRuntime({
      responses: (req) => {
        capturedReq = req;
        return { text: "Done" };
      },
    });

    const literals: SkillLiteral[] = [
      {
        name: "multi-inline",
        content: "---\nname: multi-inline\ndescription: multi tenant inline skill\n---\nMulti inline body",
      },
    ];

    await askSeepient("Multi-mode literals test", {
      cwd: tmpCwd,
      tenancy: "multi",
      runtime,
      auditStore: new FakeAuditStore(),
      policyStore: new FakePolicyStore(),
      capabilityLedger: new FakeCapabilityLedger(),
      stateless: true,
      skills: literals,
    });

    const sysMsg = capturedReq?.messages?.find((m: any) => m.role === "system");
    expect(messageText(sysMsg)).toContain("AVAILABLE SKILLS");
    expect(messageText(sysMsg)).toContain("multi-inline: multi tenant inline skill");
  });

  it("skills: [] passed to askSeepient filters catalog to empty (no AVAILABLE SKILLS in system prompt)", async () => {
    let capturedReq: any = null;
    const runtime = createFakeRuntime({
      responses: (req) => {
        capturedReq = req;
        return { text: "Done" };
      },
    });

    const fakeSource: SkillSource = {
      list: () => [
        {
          name: "source-skill",
          content: "---\nname: source-skill\ndescription: should be filtered out\n---\nBody",
          source: "test-source",
        },
      ],
    };

    await askSeepient("Empty skills filter test", {
      cwd: tmpCwd,
      tenancy: "single",
      runtime,
      sources: [fakeSource],
      skills: [],
    });

    const sysMsg = capturedReq?.messages?.find((m: any) => m.role === "system");
    expect(messageText(sysMsg)).not.toContain("AVAILABLE SKILLS");
    expect(messageText(sysMsg)).not.toContain("source-skill");
  });

  it("skills: [] passed to createSeepient filters catalog to empty (no AVAILABLE SKILLS in system prompt)", async () => {
    const runtime = createFakeRuntime({
      responses: () => ({ text: "Done" }),
    });

    const fakeSource: SkillSource = {
      list: () => [
        {
          name: "source-skill",
          content: "---\nname: source-skill\ndescription: should be filtered out\n---\nBody",
          source: "test-source",
        },
      ],
    };

    const agent = await createSeepient({
      cwd: tmpCwd,
      tenancy: "single",
      runtime,
      sources: [fakeSource],
      skills: [],
    });

    const history = agent.getHistory();
    const sysMsg = history.find((m: any) => m.role === "system");
    expect(messageText(sysMsg)).not.toContain("AVAILABLE SKILLS");
    expect(messageText(sysMsg)).not.toContain("source-skill");
  });

  it("exports saveGeneratedSkill, initializeSkillRegistry, and errors from SDK entry point", async () => {
    expect(typeof saveGeneratedSkill).toBe("function");
    expect(typeof initializeSkillRegistry).toBe("function");
    expect(SkillStoreUnavailableError).toBeDefined();
    expect(SkillCollisionError).toBeDefined();

    const err = new SkillStoreUnavailableError();
    expect(err.code).toBe("SKILL_STORE_UNAVAILABLE");

    const coll = new SkillCollisionError("test-skill", "fs");
    expect(coll.code).toBe("SKILL_COLLISION");
  });

  it("W220: source list() rejection produces console.warn and omits catalog in askSeepient", async () => {
    let capturedReq: any = null;
    const runtime = createFakeRuntime({
      responses: (req) => {
        capturedReq = req;
        return { text: "Done" };
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const rejectingSource: SkillSource = {
        list: () => Promise.reject(new Error("Database connection refused")),
      };

      await askSeepient("Test failing source", {
        cwd: tmpCwd,
        tenancy: "single",
        runtime,
        sources: [rejectingSource],
      });

      const sysMsg = capturedReq?.messages?.find((m: any) => m.role === "system");
      expect(messageText(sysMsg)).not.toContain("AVAILABLE SKILLS");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to resolve skills: Database connection refused/),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("W220: source list() rejection produces console.warn and omits catalog in createSeepient", async () => {
    const runtime = createFakeRuntime({
      responses: () => ({ text: "Done" }),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const rejectingSource: SkillSource = {
        list: () => Promise.reject(new Error("Database connection refused")),
      };

      const agent = await createSeepient({
        cwd: tmpCwd,
        tenancy: "single",
        runtime,
        sources: [rejectingSource],
      });

      const history = agent.getHistory();
      const sysMsg = history.find((m: any) => m.role === "system");
      expect(messageText(sysMsg)).not.toContain("AVAILABLE SKILLS");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to resolve skills: Database connection refused/),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
