import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../server/db.js";
import { LocalMcpClient } from "../server/localMcpClient.js";
import { classifyMcpTool } from "../server/controlledWriteRegistry.js";
import { createMcpServer } from "./index.js";

const dataDir = mkdtempSync(join(tmpdir(), "pcs-reassignment-mcp-"));
const dbPath = join(dataDir, "test.db");
const store = new Store(dbPath, dataDir);
let client: LocalMcpClient;

beforeAll(async () => {
  client = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir }));
});

afterAll(async () => {
  await client?.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("agent reassignment MCP contract", () => {
  it("exposes a non-authorizing request and a lease-scoped approval as controlled tools", async () => {
    const tools = await client.listAgentTools();
    const request = tools.find((tool) => tool.name === "request_agent_reassignment")!;
    const approve = tools.find((tool) => tool.name === "approve_agent_reassignment")!;
    expect(request).toBeTruthy();
    expect(approve).toBeTruthy();
    expect(classifyMcpTool(request.name)).toBe("controlled");
    expect(classifyMcpTool(approve.name)).toBe("controlled");
    const requestRequired = (request.inputSchema.required ?? []) as string[];
    expect(requestRequired).toEqual(expect.arrayContaining([
      "projectRef", "targetTaskKey", "targetTaskRevision", "originalAgentId",
      "replacementAgentId", "replacementPoolId", "reason", "requestedBy", "idempotencyKey",
    ]));
    expect(requestRequired).not.toContain("leaseToken");
    const approveRequired = (approve.inputSchema.required ?? []) as string[];
    expect(approveRequired).toEqual(expect.arrayContaining([
      "requestId", "approvalNote", "workOrderId", "leaseToken", "taskKey",
      "taskRevision", "workerId", "agentId", "role", "idempotencyKey",
    ]));
  });
});
