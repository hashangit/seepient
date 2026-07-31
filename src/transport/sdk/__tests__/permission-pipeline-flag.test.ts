/**
 * P3 permission-pipeline opt-in flag (spec 008, T302/T303).
 *
 * Verifies the `permissionPipeline` flag is accepted on every surface's
 * options (GenerateTextOptions, StreamTextOptions, AgentCreateOptions) and
 * defaults to false (legacy behavior preserved). The composition root
 * constructs the ActionLifecycle when true; the agent loop routes through it.
 */
import { describe, it, expect } from "vitest";
import type {
  GenerateTextOptions,
  StreamTextOptions,
  AgentCreateOptions,
} from "../../../foundations/types.js";

describe("permissionPipeline opt-in flag (T302/T303)", () => {
  it("GenerateTextOptions accepts permissionPipeline", () => {
    const opts: GenerateTextOptions = { permissionPipeline: true };
    expect(opts.permissionPipeline).toBe(true);
  });

  it("StreamTextOptions inherits permissionPipeline", () => {
    const opts: StreamTextOptions = { permissionPipeline: true, onText: () => {} };
    expect(opts.permissionPipeline).toBe(true);
  });

  it("AgentCreateOptions accepts permissionPipeline", () => {
    const opts: AgentCreateOptions = { permissionPipeline: true };
    expect(opts.permissionPipeline).toBe(true);
  });

  it("permissionPipeline defaults to undefined (legacy path) when omitted", () => {
    const opts: GenerateTextOptions = {};
    expect(opts.permissionPipeline).toBeUndefined();
  });

  it("legacy options (approveTool/permissionLevel/grants) still accepted alongside", () => {
    const opts: GenerateTextOptions = {
      permissionPipeline: true,
      approveTool: async () => true,
      permissionLevel: "moderate",
      grants: [{ tool: "write_file", pattern: "/p/a.txt" }],
    };
    expect(opts.approveTool).toBeDefined();
    expect(opts.permissionLevel).toBe("moderate");
    expect(opts.grants).toHaveLength(1);
  });
});
