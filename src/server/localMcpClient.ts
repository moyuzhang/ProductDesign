import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
  type McpServer,
} from "@modelcontextprotocol/server";

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AgentMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentMcpResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

const OPEN_DIAGRAM_AGENT_TOOL: AgentMcpTool = {
  name: "open_diagram",
  description: "在发起当前 Agent 消息的前端页面中静默打开本项目画布；可选定位一个画布节点。只改变前端视图，不修改画布数据。",
  inputSchema: {
    type: "object",
    properties: {
      diagramId: { type: "string", minLength: 1, description: "要打开的画布 ID" },
      nodeId: { type: "string", minLength: 1, description: "可选，要选中并居中的画布节点 ID" },
    },
    required: ["diagramId"],
    additionalProperties: false,
  },
};

export const AGENT_MCP_TOOL_NAMES = new Set([
  "begin_agent_auth",
  "complete_agent_auth",
  "ack_agent_policy",
  "issue_agent_write_nonce",
  "get_project",
  "get_project_workspace",
  "get_project_workflow",
  "get_agent_orchestration",
  "claim_coordination_lease",
  "heartbeat_coordination_lease",
  "dispatch_child_task",
  "claim_dispatched_child_task",
  "reclaim_child_task",
  "reassign_child_task",
  "pause_coordination_lease",
  "resume_coordination_lease",
  "release_coordination_lease",
  "advance_coordination_stage",
  "list_coordination_leases",
  "list_child_task_dispatches",
  "get_agent_task_package",
  "claim_next_agent_task",
  "list_claimable_agent_tasks",
  "list_agent_task_leases",
  "get_agent_task_capacity",
  "update_agent_task_capacity",
  "list_agent_runners",
  "list_agent_worker_pools",
  "request_agent_reassignment",
  "approve_agent_reassignment",
  "start_agent_task",
  "heartbeat_agent_task",
  "complete_agent_task",
  "fail_agent_task",
  "release_agent_task",
  "get_next_project_action",
  "validate_project_workflow",
  "list_project_workspace_nodes",
  "get_project_snapshot",
  "list_plan_items",
  "get_plan_item",
  "list_design_docs",
  "get_design_doc",
  "create_design_doc",
  "patch_design_doc",
  "list_document_references",
  "create_document_reference",
  "refresh_document_reference",
  "list_governance",
  "create_governance",
  "patch_governance",
  "list_diagrams",
  "get_diagram",
  "create_diagram",
  "update_diagram",
  "mutate_diagram",
  "auto_layout_diagram",
  "align_diagram_nodes",
  "validate_diagram",
  "export_diagram",
  "list_database_models",
  "get_database_model",
  "create_database_model",
  "update_database_model",
  "auto_layout_database_model",
  "validate_database_model",
  "generate_database_code",
  "list_node_database_bindings",
  "create_node_database_binding",
  "update_node_database_binding",
  "create_plan_item_full",
  "patch_plan_item",
  "transition_plan_delivery",
  "request_design_change",
  "report_design_gap", "dismiss_design_gap",
  "request_agent_reassignment",
  "approve_agent_reassignment",
  "start_agent_task",
  "heartbeat_agent_task",
  "complete_agent_task",
  "fail_agent_task",
  "release_agent_task",
  "list_evidence",
  "create_evidence",
  "update_project_status",
  "get_diagram_layers",
  "update_diagram_layers",
  "list_diagram_components",
  "create_diagram_component",
  "instantiate_diagram_component",
  "delete_diagram_component",
  "list_diagram_templates",
  "get_diagram_template",
  "create_diagram_template",
  "update_diagram_template",
  "revoke_diagram_template",
  "apply_diagram_template",
]);

export const MUTATING_AGENT_MCP_TOOLS = new Set([
  "claim_coordination_lease",
  "heartbeat_coordination_lease",
  "dispatch_child_task",
  "claim_dispatched_child_task",
  "reclaim_child_task",
  "reassign_child_task",
  "pause_coordination_lease",
  "resume_coordination_lease",
  "release_coordination_lease",
  "advance_coordination_stage",
  "update_agent_task_capacity",
  "create_design_doc",
  "patch_design_doc",
  "create_document_reference",
  "refresh_document_reference",
  "create_governance",
  "patch_governance",
  "create_diagram",
  "update_diagram",
  "mutate_diagram",
  "auto_layout_diagram",
  "align_diagram_nodes",
  "create_database_model",
  "update_database_model",
  "auto_layout_database_model",
  "create_node_database_binding",
  "update_node_database_binding",
  "create_plan_item_full",
  "patch_plan_item",
  "transition_plan_delivery",
  "request_design_change",
  "report_design_gap", "dismiss_design_gap",
  "create_evidence",
  "update_project_status",
  "update_diagram_layers",
  "create_diagram_component",
  "instantiate_diagram_component",
  "delete_diagram_component",
  "create_diagram_template",
  "update_diagram_template",
  "revoke_diagram_template",
  "apply_diagram_template",
]);

export class LocalMcpClient {
  private readonly server: McpServer;
  private readonly clientTransport: InMemoryTransport;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  private nextId = 1;
  private connected = false;

  private constructor(server: McpServer, clientTransport: InMemoryTransport) {
    this.server = server;
    this.clientTransport = clientTransport;
    this.clientTransport.onmessage = (message: JSONRPCMessage) => {
      const response = message as unknown as RpcResponse;
      if (typeof response.id !== "number") return;
      const waiter = this.pending.get(response.id);
      if (!waiter) return;
      this.pending.delete(response.id);
      if (response.error) waiter.reject(new Error(response.error.message ?? `MCP 请求失败（${response.error.code ?? "unknown"}）`));
      else waiter.resolve(response.result);
    };
    this.clientTransport.onerror = (error) => this.rejectAll(error);
    this.clientTransport.onclose = () => this.rejectAll(new Error("本地 MCP 连接已关闭"));
  }

  static async connect(factory: () => McpServer): Promise<LocalMcpClient> {
    const server = factory();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new LocalMcpClient(server, clientTransport);
    await clientTransport.start();
    await server.connect(serverTransport);
    await client.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "product-design-agent-bridge", version: "0.1.0" },
    });
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    client.connected = true;
    return client;
  }

  async listAgentTools(): Promise<AgentMcpTool[]> {
    const response = await this.request("tools/list", {}) as { tools?: AgentMcpTool[] };
    return [
      ...(response.tools ?? []).filter((tool) => AGENT_MCP_TOOL_NAMES.has(tool.name)),
      OPEN_DIAGRAM_AGENT_TOOL,
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<AgentMcpResult> {
    if (!AGENT_MCP_TOOL_NAMES.has(name) && name !== "get_project_workflow") {
      throw new Error(`Agent 不允许调用 MCP 工具: ${name}`);
    }
    return await this.request("tools/call", { name, arguments: args }) as AgentMcpResult;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.clientTransport.close();
    await this.server.close();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    void this.clientTransport.send({ jsonrpc: "2.0", id, method, params }).catch((error: Error) => {
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      waiter?.reject(error);
    });
    return response;
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

export function mcpResultText(result: AgentMcpResult, maxLength = 24_000): string {
  const text = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
  const payload = text || (result.structuredContent === undefined ? "工具未返回文本" : JSON.stringify(result.structuredContent));
  return payload.length > maxLength ? `${payload.slice(0, maxLength)}\n[工具结果已截断]` : payload;
}
