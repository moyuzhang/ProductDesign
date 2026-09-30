/** Built-in Codex local tool enforcement is not yet verified for design-only sessions. */
export function codexDesignProblem(): string | undefined {
  return "Codex 设计执行暂不可用：当前运行时尚未验证能禁止代码执行和文件写入。ChatGPT 登录与模型目录可用；可另选 API 配置进行受控设计对话，不会自动切换或计费。";
}

export const DESIGN_AGENT_MCP_TOOLS = new Set([
  "get_project", "get_project_workspace", "get_project_workflow", "get_next_project_action", "validate_project_workflow",
  "list_project_workspace_nodes", "get_project_snapshot", "list_plan_items", "get_plan_item",
  "list_design_docs", "get_design_doc", "create_design_doc", "list_document_references",
  "list_governance", "list_diagrams", "get_diagram", "validate_diagram", "open_diagram",
  "list_database_models", "get_database_model", "validate_database_model", "list_node_database_bindings",
  "create_diagram", "update_diagram", "mutate_diagram", "auto_layout_diagram", "align_diagram_nodes",
  "create_database_model", "update_database_model", "auto_layout_database_model",
  "create_node_database_binding", "update_node_database_binding",
  "list_evidence", "get_diagram_layers", "list_diagram_components", "list_diagram_templates", "get_diagram_template",
]);

/** Fail closed even if an unadvertised tool is returned by a model. Drafts need human approval. */
export function assertDesignTool(name: string, args: Record<string, unknown>): void {
  if (!DESIGN_AGENT_MCP_TOOLS.has(name)) throw new Error(`设计会话不允许执行此工具：${name}`);
  if (["create_diagram", "update_diagram", "mutate_diagram"].includes(name)) {
    const check = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (["requirementStatus", "designStatus", "developmentStatus", "testStatus", "acceptanceStatus", "lifecycleStatus"].includes(key)
          && ["已批准", "已完成", "已验收", "已通过", "approved", "accepted"].includes(String(child))) throw new Error("设计 Agent 不能代替用户批准或宣告开发验收完成");
        check(child);
      }
    };
    check(args);
  }
  if (name === "create_design_doc") {
    if (args.status !== undefined && !["草拟", "评审中"].includes(String(args.status))) throw new Error("设计 Agent 只能创建草稿，批准必须由用户完成");
    if (["测试报告", "验收文档"].includes(String(args.category))) throw new Error("设计 Agent 不能生成开发测试或验收证据");
    if (["implements", "verifies"].includes(String(args.relationType))) throw new Error("设计草稿不能声明已经实现或验证");
  }
}
