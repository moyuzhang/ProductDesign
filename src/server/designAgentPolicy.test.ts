import { describe, expect, it } from "vitest";
import { assertDesignTool, codexDesignProblem } from "./designAgentPolicy.js";
import { agentProfileProblem } from "./agentHarness.js";
import type { LlmProfile } from "../shared/types.js";

describe("design-only capabilities", () => {
  it("fails Codex turns closed without silently changing providers", () => {
    const profile = { enabled: true, credentialConfigured: true, protocol: "openai-responses" } as LlmProfile;
    expect(agentProfileProblem(profile)).toBe(codexDesignProblem());
    expect(agentProfileProblem({ ...profile, authMode: "chatgpt" })).toBe(codexDesignProblem());
    expect(agentProfileProblem({ ...profile, protocol: "openai-chat" })).toBeUndefined();
  });
  it("blocks development orchestration and code generation", () => {
    for (const name of ["generate_database_code", "transition_plan_delivery", "create_evidence", "start_agent_task", "dispatch_child_task", "shell", "apply_patch"]) {
      expect(() => assertDesignTool(name, {})).toThrow("不允许");
    }
  });
  it("allows design drafts while preserving human approval", () => {
    expect(() => assertDesignTool("create_design_doc", { status: "草拟", category: "需求文档" })).not.toThrow();
    expect(() => assertDesignTool("create_design_doc", { status: "已批准" })).toThrow("批准");
    expect(() => assertDesignTool("create_design_doc", { category: "验收文档" })).toThrow("验收");
    expect(() => assertDesignTool("mutate_diagram", { operations: [{ patch: { requirementStatus: "已批准" } }] })).toThrow("批准");
    expect(() => assertDesignTool("mutate_diagram", { operations: [{ patch: { label: "设计草稿" } }] })).not.toThrow();
  });
});
