import { describe, it, expect } from "vitest";
import { redact, isSensitiveKey, redactString } from "../redact.js";
import { isSensitiveHeader, sanitizeHeaders } from "../headers.js";

describe("Security redaction & header denial (QS-P4.2)", () => {
  it("detects sensitive header names with pattern-based matching", () => {
    expect(isSensitiveHeader("Authorization")).toBe(true);
    expect(isSensitiveHeader("authorization")).toBe(true);
    expect(isSensitiveHeader("Cookie")).toBe(true);
    expect(isSensitiveHeader("Set-Cookie")).toBe(true);
    expect(isSensitiveHeader("X-Seepient-Internal")).toBe(true);
    expect(isSensitiveHeader("x-api-key")).toBe(true);
    expect(isSensitiveHeader("X-Auth-Token")).toBe(true);
    expect(isSensitiveHeader("x-custom-key")).toBe(true);
    expect(isSensitiveHeader("x-goog-api-key")).toBe(true);

    expect(isSensitiveHeader("Content-Type")).toBe(false);
    expect(isSensitiveHeader("Accept")).toBe(false);
    expect(isSensitiveHeader("User-Agent")).toBe(false);
  });

  it("sanitizes headers records cleanly", () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-12345678901234567890",
      "x-api-key": "secret-123",
      "x-session-id": "session-abc",
    };

    const sanitized = sanitizeHeaders(headers);
    expect(sanitized["Content-Type"]).toBe("application/json");
    expect(sanitized["Authorization"]).toBe("[REDACTED]");
    expect(sanitized["x-api-key"]).toBe("[REDACTED]");
    expect(sanitized["x-session-id"]).toBe("session-abc");
  });

  it("redacts sensitive keys in deeply nested objects and arrays", () => {
    const data = {
      user: {
        name: "Alice",
        apiKey: "sk-abcdef1234567890abcdef1234567890",
        credentials: {
          password: "my-password",
          tokens: ["tok-1", "xoxb-1234567890-12345"],
        },
      },
      metadata: {
        publicInfo: "hello",
      },
    };

    const redacted = redact(data);
    expect(redacted.user.name).toBe("Alice");
    expect(redacted.user.apiKey).toBe("[REDACTED]");
    expect(redacted.user.credentials.password).toBe("[REDACTED]");
    expect(redacted.metadata.publicInfo).toBe("hello");
  });

  it("redacts secret values embedded inside strings and Error messages", () => {
    const str = "Failed to connect to API with key sk-12345678901234567890abc";
    expect(redactString(str)).toContain("[REDACTED]");
    expect(redactString(str)).not.toContain("sk-12345678901234567890abc");

    const err = new Error("Auth failed using key sk-12345678901234567890abc");
    const redactedErr = redact(err);
    expect(redactedErr.message).toContain("[REDACTED]");
  });
});
