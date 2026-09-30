/** Never serialize upstream errors: messages, stacks, causes and custom fields
 * can contain provider response bodies, credentials or user content. */
const SAFE_FAILURE_CODES = new Map<string, "persistence" | "transport">([
  ["SQLITE_BUSY", "persistence"],
  ["SQLITE_LOCKED", "persistence"],
  ["SQLITE_FULL", "persistence"],
  ["SQLITE_IOERR", "persistence"],
  ["SQLITE_READONLY", "persistence"],
  ["SQLITE_CORRUPT", "persistence"],
  ["SQLITE_CANTOPEN", "persistence"],
  ["EPIPE", "transport"],
  ["ECONNRESET", "transport"],
  ["ERR_STREAM_DESTROYED", "transport"],
]);

export function agentRunFailureLogFields(error: unknown, sessionId: string) {
  const code = error && typeof error === "object"
    ? Object.getOwnPropertyDescriptor(error, "code")?.value as unknown : undefined;
  const category = typeof code === "string" ? SAFE_FAILURE_CODES.get(code) : undefined;
  return {
    sessionId,
    phase: "agent_turn",
    category: category ?? "unknown",
    code: category ? code as string : "AGENT_TURN_FAILED",
  };
}
