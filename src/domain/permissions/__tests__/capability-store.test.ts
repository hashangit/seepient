/**
 * P1 capability intersection + policy property tests (spec 008, T106/T107).
 *
 * Property: no inner input may expand an outer ceiling. Every intersection
 * narrows or preserves — never widens.
 */
import { describe, it, expect } from "vitest";
import {
  covers,
  intersect,
  effectiveCapabilities,
  capabilitiesForEffect,
  requiredCapabilities,
  isDeniedByRule,
  setCovers,
  EMPTY_CAPABILITY_SET,
} from "../capability-store.js";
import type {
  Capability,
  CapabilitySet,
} from "../../../foundations/contracts/permission-policy.js";
import type { EffectRequest } from "../../../foundations/contracts/tool-effects.js";

const set = (...caps: Capability[]): CapabilitySet => ({
  version: 1,
  capabilities: caps,
});

describe("capability covers (T106)", () => {
  it("exact commit-file never covers a sibling path", () => {
    const outer: Capability = { kind: "commit-file", path: "/p/a.txt" };
    expect(covers(outer, { kind: "commit-file", path: "/p/a.txt" })).toBe(true);
    expect(covers(outer, { kind: "commit-file", path: "/p/b.txt" })).toBe(false);
    expect(covers(outer, { kind: "commit-file", path: "/p/a.txt.bak" })).toBe(false);
  });

  it("read-root covers read-file within root", () => {
    const outer: Capability = { kind: "read-root", root: "/proj" };
    expect(covers(outer, { kind: "read-file", path: "/proj/src/x.ts" })).toBe(true);
    expect(covers(outer, { kind: "read-file", path: "/etc/passwd" })).toBe(false);
  });

  it("model-egress requires every requested data class", () => {
    const outer: Capability = {
      kind: "model-egress",
      providerClass: "openai",
      dataClasses: ["normal"],
    };
    expect(
      covers(outer, {
        kind: "model-egress",
        providerClass: "openai",
        dataClasses: ["normal"],
      }),
    ).toBe(true);
    expect(
      covers(outer, {
        kind: "model-egress",
        providerClass: "openai",
        dataClasses: ["secret"],
      }),
    ).toBe(false);
    expect(
      covers(outer, {
        kind: "model-egress",
        providerClass: "anthropic",
        dataClasses: ["normal"],
      }),
    ).toBe(false);
  });

  it("network-destination matches host+scheme, optional port", () => {
    const outer: Capability = {
      kind: "network-destination",
      scheme: "https",
      host: "api.example.com",
    };
    expect(
      covers(outer, {
        kind: "network-destination",
        scheme: "https",
        host: "api.example.com",
      }),
    ).toBe(true);
    expect(
      covers(outer, {
        kind: "network-destination",
        scheme: "http",
        host: "api.example.com",
      }),
    ).toBe(false);
  });
});

describe("monotonic intersection (T106 property)", () => {
  it("intersect narrows: inner caps outside outer are dropped", () => {
    const outer = set({ kind: "commit-file", path: "/p/a.txt" });
    const inner = set(
      { kind: "commit-file", path: "/p/a.txt" },
      { kind: "commit-file", path: "/p/b.txt" }, // outside outer
    );
    const result = intersect(outer, inner);
    expect(result.capabilities).toHaveLength(1);
    expect(result.capabilities[0]).toMatchObject({ path: "/p/a.txt" });
  });

  it("empty outer denies everything", () => {
    const inner = set({ kind: "commit-file", path: "/p/a.txt" });
    expect(intersect(EMPTY_CAPABILITY_SET, inner).capabilities).toHaveLength(0);
  });

  it("effectiveCapabilities narrows at each step", () => {
    const deployment = set(
      { kind: "commit-file", path: "/p/a.txt" },
      { kind: "commit-file", path: "/p/b.txt" },
    );
    const principal = set({ kind: "commit-file", path: "/p/a.txt" }); // narrower
    const runtime = set({ kind: "commit-file", path: "/p/a.txt" });
    const active = set({ kind: "commit-file", path: "/p/a.txt" });
    const eff = effectiveCapabilities(deployment, principal, runtime, active);
    expect(eff.capabilities).toHaveLength(1);
    expect(eff.capabilities[0]).toMatchObject({ path: "/p/a.txt" });
  });

  it("property: intersection result size ≤ inner size", () => {
    // Randomized property check (deterministic seed via fixed inputs).
    const outer = set({ kind: "read-root", root: "/a" });
    const inner = set(
      { kind: "read-file", path: "/a/x" }, // covered
      { kind: "read-file", path: "/b/y" }, // not covered
      { kind: "commit-file", path: "/a/z" }, // wrong kind
    );
    const result = intersect(outer, inner);
    expect(result.capabilities.length).toBeLessThanOrEqual(inner.capabilities.length);
    expect(result.capabilities.every((c) => setCovers(outer, c))).toBe(true);
  });
});

describe("effect → capability mapping (T102)", () => {
  it("filesystem-write maps to commit-file caps", () => {
    const effect: EffectRequest = {
      kind: "filesystem-write",
      targets: [
        {
          target: {
            canonicalPath: "/p/a.txt",
            canonicalParent: "/p",
            basename: "a.txt",
            exists: false,
            finalSymlink: false,
          },
          mode: "create",
        },
      ],
    };
    const caps = capabilitiesForEffect(effect);
    expect(caps).toEqual([{ kind: "commit-file", path: "/p/a.txt" }]);
  });

  it("model-egress maps to a model-egress cap", () => {
    const effect: {
      kind: "model-egress";
      providerClass: string;
      dataClasses: string[];
      sources: string[];
    } = {
      kind: "model-egress",
      providerClass: "openai",
      dataClasses: ["normal"],
      sources: ["/p/a.txt"],
    };
    expect(capabilitiesForEffect(effect)).toEqual([
      { kind: "model-egress", providerClass: "openai", dataClasses: ["normal"] },
    ]);
  });

  it("requiredCapabilities flattens all effects", () => {
    const effects: EffectRequest[] = [
      {
        kind: "filesystem-write",
        targets: [
          {
            target: {
              canonicalPath: "/p/a",
              canonicalParent: "/p",
              basename: "a",
              exists: false,
              finalSymlink: false,
            },
            mode: "create",
          },
        ],
      },
      { kind: "secret-use", secretRefs: ["smtp-user"] },
    ];
    expect(requiredCapabilities(effects)).toEqual([
      { kind: "commit-file", path: "/p/a" },
      { kind: "secret-ref", ref: "smtp-user" },
    ]);
  });
});

describe("immutable deny rules (T106)", () => {
  it("wildcard deny matches any effect", () => {
    const rules = [{ ruleId: "r1", effect: "*" as const, reason: "immutable-deny" as const }];
    expect(isDeniedByRule(rules, "process-exec")?.ruleId).toBe("r1");
    expect(isDeniedByRule(rules, "network-egress")?.ruleId).toBe("r1");
  });

  it("specific deny matches only that effect", () => {
    const rules = [
      { ruleId: "r1", effect: "process-exec" as const, reason: "immutable-deny" as const },
    ];
    expect(isDeniedByRule(rules, "process-exec")?.ruleId).toBe("r1");
    expect(isDeniedByRule(rules, "filesystem-read")).toBeUndefined();
  });

  it("target-scoped deny matches only that target", () => {
    const rules = [
      {
        ruleId: "r1",
        effect: "filesystem-read" as const,
        target: "/etc/passwd",
        reason: "immutable-deny" as const,
      },
    ];
    expect(isDeniedByRule(rules, "filesystem-read", "/etc/passwd")?.ruleId).toBe("r1");
    expect(isDeniedByRule(rules, "filesystem-read", "/home/me")).toBeUndefined();
  });
});

describe("path-segment containment (reviewer fix #6)", () => {
  it("read-root /project/data does NOT cover /project/database", () => {
    const outer: Capability = { kind: "read-root", root: "/project/data" };
    expect(covers(outer, { kind: "read-file", path: "/project/database/secret" })).toBe(false);
    expect(covers(outer, { kind: "read-file", path: "/project/data/file" })).toBe(true);
    expect(covers(outer, { kind: "read-file", path: "/project/data" })).toBe(true);
  });

  it("read-root /project/data does NOT cover /project/dat", () => {
    const outer: Capability = { kind: "read-root", root: "/project/data" };
    expect(covers(outer, { kind: "read-file", path: "/project/dat" })).toBe(false);
  });

  it("write-root segment containment", () => {
    const outer: Capability = { kind: "write-root", root: "/a/project" };
    expect(covers(outer, { kind: "write-root", root: "/a/project-evil" })).toBe(false);
    expect(covers(outer, { kind: "write-root", root: "/a/project/sub" })).toBe(true);
  });

  it("deny rule /etc/secure does NOT match /etc/security", () => {
    const rules = [{
      ruleId: "r1",
      effect: "filesystem-read" as const,
      target: "/etc/secure",
      reason: "immutable-deny" as const,
    }];
    expect(isDeniedByRule(rules, "filesystem-read", "/etc/security/passwords")?.ruleId).toBeUndefined();
    expect(isDeniedByRule(rules, "filesystem-read", "/etc/secure/key")?.ruleId).toBe("r1");
  });
});

describe("exact vs prefix argv coverage (P0 review fix)", () => {
  it("an EXACT process capability does not cover requests with extra trailing args", () => {
    const exact = { kind: "process" as const, executable: "/bin/rm", argvPrefix: ["safe.txt"], argvExact: true };
    expect(covers(exact, { kind: "process", executable: "/bin/rm", argvPrefix: ["safe.txt"], argvExact: true })).toBe(true);
    // The exact approval must NOT authorize "rm safe.txt other.txt".
    expect(covers(exact, { kind: "process", executable: "/bin/rm", argvPrefix: ["safe.txt", "other.txt"], argvExact: true })).toBe(false);
    // A shorter inner argv is not covered either.
    expect(covers(exact, { kind: "process", executable: "/bin/rm", argvPrefix: [], argvExact: true })).toBe(false);
  });

  it("a BOUNDED prefix capability still covers exact requests with more args", () => {
    const bounded = { kind: "process" as const, executable: "/usr/bin/git", argvPrefix: ["status"] };
    expect(covers(bounded, { kind: "process", executable: "/usr/bin/git", argvPrefix: ["status", "--porcelain"], argvExact: true })).toBe(true);
    // ...but not a different subcommand.
    expect(covers(bounded, { kind: "process", executable: "/usr/bin/git", argvPrefix: ["log"], argvExact: true })).toBe(false);
  });
});
