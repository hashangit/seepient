import { describe, it, expect } from "vitest";
import {
  SeepientError,
  ProviderError,
  ToolError,
  MaxStepsError,
  AbortedError,
  WidgetError,
  HashlineError,
} from "../errors.js";

describe("SeepientError", () => {
  it("stores code and retryable", () => {
    const err = new SeepientError("something broke", "GENERIC", false);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SeepientError);
    expect(err.message).toBe("something broke");
    expect(err.code).toBe("GENERIC");
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("SeepientError");
  });

  it("defaults retryable to false", () => {
    const err = new SeepientError("msg", "CODE");
    expect(err.retryable).toBe(false);
  });

  it("accepts retryable=true", () => {
    const err = new SeepientError("msg", "CODE", true);
    expect(err.retryable).toBe(true);
  });
});

describe("ProviderError", () => {
  it("is a SeepientError with code PROVIDER_ERROR", () => {
    const err = new ProviderError("rate limited");
    expect(err).toBeInstanceOf(SeepientError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("ProviderError");
  });

  it("stores optional provider name", () => {
    const err = new ProviderError("fail", "openai");
    expect(err.provider).toBe("openai");
  });

  it("leaves provider undefined when not passed", () => {
    const err = new ProviderError("fail");
    expect(err.provider).toBeUndefined();
  });
});

describe("ToolError", () => {
  it("is a SeepientError with code TOOL_FAILED", () => {
    const err = new ToolError("tool crashed");
    expect(err).toBeInstanceOf(SeepientError);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("TOOL_FAILED");
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("ToolError");
  });

  it("stores optional tool name", () => {
    const err = new ToolError("bad", "execute_shell_command");
    expect(err.tool).toBe("execute_shell_command");
  });
});

describe("MaxStepsError", () => {
  it("formats message and stores steps", () => {
    const err = new MaxStepsError(15, 10);
    expect(err).toBeInstanceOf(SeepientError);
    expect(err).toBeInstanceOf(MaxStepsError);
    expect(err.message).toBe("Maximum steps reached (15/10)");
    expect(err.code).toBe("MAX_STEPS");
    expect(err.retryable).toBe(false);
    expect(err.steps).toBe(15);
    expect(err.name).toBe("MaxStepsError");
  });
});

describe("AbortedError", () => {
  it("uses default message when none provided", () => {
    const err = new AbortedError();
    expect(err).toBeInstanceOf(SeepientError);
    expect(err).toBeInstanceOf(AbortedError);
    expect(err.message).toBe("Operation was aborted");
    expect(err.code).toBe("ABORTED");
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("AbortedError");
  });

  it("accepts custom message", () => {
    const err = new AbortedError("user cancelled");
    expect(err.message).toBe("user cancelled");
  });
});

describe("WidgetError", () => {
  // Contract widget-protocol.md §2: all three codes are retryable (the model
  // can retry render_widget with corrected JSON).
  it.each([
    ["WIDGET_INVALID_KIND"],
    ["WIDGET_INVALID_PROPS"],
    ["WIDGET_DUPLICATE_ACTION"],
  ] as const)("code %s is retryable and carries the code", (code) => {
    const err = new WidgetError("bad widget", code);
    expect(err).toBeInstanceOf(SeepientError);
    expect(err).toBeInstanceOf(WidgetError);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("WidgetError");
  });

  it("stores optional widgetId", () => {
    const err = new WidgetError("bad", "WIDGET_INVALID_PROPS", "w1");
    expect(err.widgetId).toBe("w1");
  });

  it("leaves widgetId undefined when not passed", () => {
    const err = new WidgetError("bad", "WIDGET_INVALID_PROPS");
    expect(err.widgetId).toBeUndefined();
  });
});

describe("HashlineError", () => {
  // Contract hashline-edit.md "Error codes" table:
  //   NO_STORE / UNKNOWN_TAG → retryable:false
  //   STALE_ANCHOR / PARSE_ERROR / OUT_OF_RANGE → retryable:true
  it.each([
    ["HASHLINE_NO_STORE", false],
    ["HASHLINE_UNKNOWN_TAG", false],
    ["HASHLINE_STALE_ANCHOR", true],
    ["HASHLINE_PARSE_ERROR", true],
    ["HASHLINE_OUT_OF_RANGE", true],
  ] as const)("code %s has retryable=%s", (code, retryable) => {
    const err = new HashlineError("msg", code, retryable);
    expect(err).toBeInstanceOf(SeepientError);
    expect(err).toBeInstanceOf(HashlineError);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.name).toBe("HashlineError");
  });
});
