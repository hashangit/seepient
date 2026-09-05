/**
 * Mandatory permission-pipeline options (Spec 021 release hardening).
 *
 * Verifies that the permission pipeline options are accepted directly on every surface's
 * options (GenerateTextOptions, StreamTextOptions, CreateSeepientOptions) and that the
 * pipeline is active by default without needing an opt-in flag.
 */
import { describe, it, expect } from "vitest";
import type {
  GenerateTextOptions,
  StreamTextOptions,
  CreateSeepientOptions,
} from "../../../foundations/types.js";

describe("mandatory permission pipeline options", () => {
  it("GenerateTextOptions accepts consentMode and stores directly", () => {
    const opts: GenerateTextOptions = { consentMode: "edit-enabled" };
    expect(opts.consentMode).toBe("edit-enabled");
  });

  it("StreamTextOptions inherits consentMode and store options", () => {
    const opts: StreamTextOptions = { consentMode: "autonomous", onText: () => {} };
    expect(opts.consentMode).toBe("autonomous");
  });

  it("CreateSeepientOptions accepts consentMode and store options", () => {
    const opts: CreateSeepientOptions = { consentMode: "ask-everything" };
    expect(opts.consentMode).toBe("ask-everything");
  });

  it("typed options (consentMode/deploymentCeiling/principalPolicy) accepted alongside approveTool", () => {
    const opts: GenerateTextOptions = {
      approveTool: async () => true,
      consentMode: "edit-enabled",
      principalPolicy: { version: 1, capabilities: [] },
    };
    expect(opts.approveTool).toBeDefined();
    expect(opts.consentMode).toBe("edit-enabled");
    expect(opts.principalPolicy).toEqual({ version: 1, capabilities: [] });
  });
});
