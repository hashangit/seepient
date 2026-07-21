import { describe, it, expect } from "vitest";
import { parseInvocation, substituteArgs } from "../args.js";

describe("parseInvocation", () => {
  it("returns null for non-slash input", () => {
    expect(parseInvocation("hello")).toBeNull();
  });

  it("returns null for bare slash", () => {
    expect(parseInvocation("/")).toBeNull();
  });

  it("parses skill name with no args", () => {
    const result = parseInvocation("/deploy");
    expect(result).toEqual({
      skillName: "deploy",
      args: { positional: [], raw: "" },
    });
  });

  it("parses skill name with args", () => {
    const result = parseInvocation("/docker-ops build myapp:1.2.0 --no-cache");
    expect(result?.skillName).toBe("docker-ops");
    expect(result?.args.positional).toEqual(["build", "myapp:1.2.0", "--no-cache"]);
    expect(result?.args.raw).toBe("build myapp:1.2.0 --no-cache");
  });

  it("handles single quoted argument", () => {
    const result = parseInvocation('/skill "multi word arg"');
    expect(result?.skillName).toBe("skill");
    expect(result?.args.positional).toEqual(["multi word arg"]);
  });

  it("handles single-quoted argument", () => {
    const result = parseInvocation("/skill 'hello world'");
    expect(result?.args.positional).toEqual(["hello world"]);
  });

  it("trims leading whitespace from raw args", () => {
    const result = parseInvocation("/skill   foo   bar");
    expect(result?.args.raw).toBe("foo   bar");
    expect(result?.args.positional).toEqual(["foo", "bar"]);
  });
});

describe("substituteArgs", () => {
  const args = {
    positional: ["build", "myapp:1.2.0", "--no-cache"],
    raw: "build myapp:1.2.0 --no-cache",
  };

  it("substitutes $ALL with raw args string", () => {
    expect(substituteArgs("echo $ALL", args)).toBe("echo build myapp:1.2.0 --no-cache");
  });

  it("substitutes $COUNT with number of args", () => {
    expect(substituteArgs("count=$COUNT", args)).toBe("count=3");
  });

  it("substitutes $FIRST with first argument", () => {
    expect(substituteArgs("first=$FIRST", args)).toBe("first=build");
  });

  it("substitutes $LAST with last argument", () => {
    expect(substituteArgs("last=$LAST", args)).toBe("last=--no-cache");
  });

  it("substitutes positional $1, $2, $3", () => {
    expect(substituteArgs("$1 $2 $3", args)).toBe("build myapp:1.2.0 --no-cache");
  });

  it("handles $FIRST/$LAST with empty args", () => {
    const empty = { positional: [], raw: "" };
    expect(substituteArgs("$FIRST", empty)).toBe("");
    expect(substituteArgs("$LAST", empty)).toBe("");
  });

  it("replaces $10 correctly (not as $1)", () => {
    const manyArgs = {
      positional: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      raw: "a b c d e f g h i j",
    };
    expect(substituteArgs("$10", manyArgs)).toBe("j");
    expect(substituteArgs("$1", manyArgs)).toBe("a");
  });

  it("leaves unknown $ vars untouched", () => {
    expect(substituteArgs("$UNKNOWN", args)).toBe("$UNKNOWN");
  });
});
