import { describe, expect, it } from "vitest";
import { agentRunFailureLogFields } from "./agentRunDiagnostics.js";

describe("safe agent run diagnostics", () => {
  it.each([undefined, "SQLITE_FULL", "EPIPE", "unrecognized-secret-code"])("logs only allowlisted fields (code=%s)", (code) => {
    const secret = "fixture-secret-provider-body-do-not-log";
    const error = Object.assign(new Error(secret, { cause: new Error(secret) }), {
      code, responseBody: secret, request: { prompt: secret }, token: secret,
    });
    const record = agentRunFailureLogFields(error, "session-id");
    expect(record).toEqual({
      sessionId: "session-id", phase: "agent_turn",
      category: code === "SQLITE_FULL" ? "persistence" : code === "EPIPE" ? "transport" : "unknown",
      code: code === "SQLITE_FULL" || code === "EPIPE" ? code : "AGENT_TURN_FAILED",
    });
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain("unrecognized-secret-code");
    for (const key of ["err", "error", "message", "stack", "cause", "responseBody", "request", "token"]) {
      expect(record).not.toHaveProperty(key);
    }
  });
  it("does not evaluate an upstream code getter or stringify arbitrary values", () => {
    const error = { get code() { throw new Error("must not evaluate"); }, toString() { throw new Error("must not stringify"); } };
    expect(agentRunFailureLogFields(error, "session-id")).toMatchObject({ category: "unknown", code: "AGENT_TURN_FAILED" });
    expect(agentRunFailureLogFields(null, "session-id")).toMatchObject({ category: "unknown", code: "AGENT_TURN_FAILED" });
  });
});
