import { describe, expect, it } from "vitest";
import { classifyMcpTool, classifyRestRequest } from "./controlledWriteRegistry.js";

describe("controlled write registry", () => {
  it("fails unknown MCP and REST writes closed", () => {
    expect(classifyMcpTool("future_mutation")).toBe("high");
    expect(classifyRestRequest("POST", "/api/future-mutation")).toBe("high");
  });
  it("classifies reads and human-only high risk operations", () => {
    expect(classifyMcpTool("get_project_workflow")).toBe("read");
    expect(classifyMcpTool("restore_backup")).toBe("high");
    expect(classifyRestRequest("DELETE", "/api/plans/x")).toBe("high");
  });
  it("allows governed design-change requests while retaining high-risk execution gates", () => {
    expect(classifyMcpTool("request_design_change")).toBe("controlled");
    expect(classifyRestRequest("POST", "/api/projects/project/design-changes")).toBe("controlled");
    for (const name of ["delete_design_doc", "delete_evidence", "restore_backup", "deploy_database_model"]) {
      expect(classifyMcpTool(name)).toBe("high");
    }
  });
  it("classifies the complete Agent lease lifecycle as controlled", () => {
    for (const name of [
      "start_agent_task",
      "heartbeat_agent_task",
      "complete_agent_task",
      "fail_agent_task",
      "release_agent_task",
    ]) {
      expect(classifyMcpTool(name)).toBe("controlled");
    }
  });
});
