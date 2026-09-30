import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SystemGuideView } from "./SystemGuideView";

describe("SystemGuideView", () => {
  it("gives administrators a complete first-level orientation", () => {
    const html = renderToStaticMarkup(createElement(SystemGuideView));

    expect(html).toContain("从目标开始，完成可审阅的产品设计");
    expect(html).toContain("角色与职责边界");
    expect(html).toContain("标准治理流程");
    expect(html).toContain("管理员日常怎么用");
    expect(html).toContain("关键边界");
    expect(html).toContain("#/projects");
    expect(html).toContain("#/guide?section=agent-mcp");
    expect(html).toContain("Agent MCP 接入、双线路编排与工作流程");
    expect(html).toContain("http://127.0.0.1:4310/mcp");
    expect(html).toContain("get_agent_orchestration");
    expect(html).toContain("设计交付闭环");
    expect(html).toContain("编码交付闭环");
    expect(html).toContain("Builder 完成的是");
    expect(html).toContain("managerApproval");
    expect(html).toContain("SELF_AUDIT_FORBIDDEN");
    expect(html).toContain("每个 Designer、Builder 和 Auditor 都必须提交与本人任务绑定的工单");
    for (const step of ["了解项目", "项目简报", "系统主画布", "模块/功能节点", "节点定义与验收标准", "需求批准", "详细设计", "开发计划", "开发", "测试证据", "验收"]) {
      expect(html).toContain(step);
    }
  });

  it("uses a wrapping workflow grid and a single-column narrow-screen layout", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/web/styles.css"), "utf8");
    expect(styles).not.toContain("repeat(9, minmax(104px, 1fr))");
    expect(styles).toContain("repeat(auto-fit, minmax(118px, 1fr))");
    expect(styles).toMatch(/@media \(max-width: 660px\)[\s\S]*\.system-guide-flow[\s\S]*grid-template-columns: 1fr/);
  });

  it("documents audit actions through the registered transition tool", () => {
    const html = renderToStaticMarkup(createElement(SystemGuideView));
    const mcpSource = readFileSync(resolve(process.cwd(), "src/mcp/fullTools.ts"), "utf8");

    expect(html).toContain("transition_plan_delivery(action=pass_design_audit|fail_design_audit)");
    expect(html).toContain("transition_plan_delivery(action=pass_audit|fail_audit)");
    for (const action of ["pass_design_audit", "fail_design_audit", "pass_audit", "fail_audit"]) {
      expect(html).not.toContain(`<code>${action}</code>`);
      expect(mcpSource).not.toContain(`registerTool("${action}"`);
    }
    expect(mcpSource).toContain('registerTool("transition_plan_delivery"');
    expect(mcpSource).toContain("action: z.enum(PLAN_TRANSITION_ACTIONS)");
    expect(html).not.toContain("待实现：无");
    expect(html).not.toContain("不在页面内启动 Agent");
    expect(html).toContain("Codex Harness");
    expect(html).toContain("managerApproval");
    expect(html).toContain("始终交给人类");
  });
});
