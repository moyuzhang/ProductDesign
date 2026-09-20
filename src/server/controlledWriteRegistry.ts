export type WriteRisk = "read" | "controlled" | "high";

const READ_MCP = new Set([
  "service_health", "get_control_capabilities", "list_projects", "get_project", "get_project_workspace", "list_project_workspace_nodes",
  "get_project_workflow", "get_next_project_action", "validate_project_workflow", "get_agent_orchestration", "get_agent_task_capacity",
  "get_agent_task_package", "list_agent_runners", "list_agent_task_leases", "list_agent_worker_pools", "list_claimable_agent_tasks",
  "list_work_nodes", "list_plan_items", "get_plan_item", "list_design_docs", "get_design_doc", "list_governance", "list_diagrams",
  "get_diagram", "dashboard", "search", "get_project_snapshot", "get_agent_workspace", "list_agent_sessions", "list_agent_messages",
  "list_audit", "list_backups", "list_document_references", "list_evidence", "list_llm_profiles", "export_diagram",
  "check_database_connection", "generate_database_code", "get_database_model", "inspect_database_schema", "list_database_models",
  "list_node_database_bindings", "preview_database_deploy", "preview_database_reverse", "validate_database_model", "validate_diagram",
  "list_coordination_leases", "list_child_task_dispatches",
  // 图层、组件与模板的只读工具（设计第 7 节）。
  "get_diagram_layers", "list_diagram_components", "list_diagram_templates", "get_diagram_template",
]);
const CONTROLLED_MCP = new Set([
  "create_product_design_project", "update_project", "update_project_status", "create_work_node", "update_work_node", "create_plan_item",
  "create_plan_item_full", "patch_plan_item", "create_design_doc", "patch_design_doc", "create_governance", "patch_governance",
  "collect_git_evidence", "collect_project_git_evidence", "create_evidence", "transition_plan_delivery", "update_agent_task_capacity",
  "start_agent_task", "heartbeat_agent_task", "complete_agent_task", "fail_agent_task", "release_agent_task",
  "request_agent_reassignment", "approve_agent_reassignment",
  "report_design_gap", "dismiss_design_gap",
  "claim_coordination_lease", "claim_dispatched_child_task", "dispatch_child_task", "reclaim_child_task", "reassign_child_task",
  "heartbeat_coordination_lease", "pause_coordination_lease", "release_coordination_lease", "advance_coordination_stage",
  "resume_coordination_lease",
  "create_agent_session", "send_agent_message", "set_agent_workspace_profile", "create_backup", "create_diagram", "update_diagram",
  "mutate_diagram", "align_diagram_nodes", "auto_layout_diagram", "duplicate_diagram_nodes", "extract_diagram", "undo_diagram",
  "redo_diagram", "create_document_reference", "refresh_document_reference", "create_llm_profile", "update_llm_profile",
  "test_llm_profile", "create_database_model", "update_database_model", "auto_layout_database_model", "import_database_schema_as_model",
  "reverse_database_into_model", "create_node_database_binding", "update_node_database_binding", "request_design_change",
  "submit_design_change_intent", "request_evidence_repair_assessment", "dismiss_design_change_intent",
  // 图层、组件与模板的写工具（设计第 7 节）：登记为受控写，由 MCP 网关注入租约上下文。
  "update_diagram_layers", "create_diagram_component", "instantiate_diagram_component", "delete_diagram_component",
  "create_diagram_template", "update_diagram_template", "revoke_diagram_template", "apply_diagram_template",
]);
const CONTROL_EXCEPTIONS = new Set(["begin_agent_auth", "complete_agent_auth", "ack_agent_policy", "issue_agent_write_nonce", "claim_next_agent_task", "get_agent_task_package", "claim_coordination_lease", "claim_dispatched_child_task"]);
const HIGH_RISK_MCP = new Set([
  "delete_project", "delete_work_node", "delete_plan_item", "delete_evidence", "delete_governance",
  "delete_document_reference", "delete_design_doc", "delete_diagram", "delete_database_model",
  "delete_node_database_binding", "restore_backup", "deploy_database_model",
]);

/**
 * High-risk operations an Agent may perform only through an explicit, scoped and audited
 * delegation: the caller must present a matching active task lease whose workScopes cover
 * the affected node, and must pass confirm=true. Every other high-risk operation stays
 * human-only.
 *
 * Justification: the design rework workflow requires a node's Designer to converge the
 * node's document bindings onto the approved revision ("移除 v3.2.0/v3.1.0 旧修订绑定"),
 * and delete_document_reference is the only tool able to do that. Without a delegation
 * path the workflow demands an action its own security policy forbids.
 */
export const DELEGABLE_HIGH_RISK_MCP = new Set<string>(["delete_document_reference"]);

/**
 * Controlled writes whose target object is project-level (a governance / design-change record)
 * rather than node- or plan-scoped. Every role may hold a lease, but nothing tied the correction
 * to the object that lease actually covers, so a stale design-change record could deadlock the
 * audit gate (planLifecycle pass_audit requires every impacted document to keep a current
 * reference on the plan's node/plan) with no role authorized to repair it.
 *
 * These tools therefore additionally require: a matching work scope, confirm=true, and a
 * security_audit_events record. Behaviour for callers outside the agent path is unchanged.
 */
export const SCOPE_GUARDED_CONTROLLED_MCP = new Set<string>(["patch_governance"]);

export function classifyMcpTool(name: string): WriteRisk {
  if (HIGH_RISK_MCP.has(name)) return "high";
  if (CONTROL_EXCEPTIONS.has(name)) return "controlled";
  if (READ_MCP.has(name)) return "read";
  if (CONTROLLED_MCP.has(name)) return "controlled";
  return "high";
}

export function classifyRestRequest(method: string, path: string): WriteRisk {
  const verb = method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(verb)) return "read";
  if (/\/restore(?:\/|$)|\/deploy\/apply(?:\/|$)|\/agent-security\/credentials(?:\/|$)/i.test(path) || verb === "DELETE") return "high";
  const controlled = [
    /^\/api\/agent-security\/(auth\/challenge|auth\/complete|policy\/ack|nonces)\/?$/,
    /^\/api\/llm-profiles(?:\/[^/]+(?:\/test)?)?\/?$/, /^\/api\/projects(?:\/[^/]+(?:\/(?:agent-workspace|design-changes|design-change-intents(?:\/[^/]+\/dismiss)?|evidence-repair-assessments|agent-task-capacity|agent-task-package|evidence\/collect))?)?\/?$/,
    /^\/api\/agent-sessions(?:\/[^/]+(?:\/messages)?)?\/?$/, /^\/api\/agent-approvals\/[^/]+\/decision\/?$/,
    /^\/api\/agent-task-leases\/[^/]+\/?$/, /^\/api\/projects\/[^/]+\/agent-task-leases\/[^/]+\/release\/?$/, /^\/api\/agent-blueprints\/[^/]+\/?$/,
    /^\/api\/projects\/[^/]+\/coordination-leases(?:\/[^/]+(?:\/(?:dispatch|reclaim|reassign|heartbeat|pause|resume|release|advance))?)?\/?$/,
    /^\/api\/projects\/[^/]+\/child-task-dispatches\/[^/]+\/claim\/?$/,
    /^\/api\/(nodes|plans|evidence|governance|design-docs|document-references|database-models|node-database-bindings|diagrams)(?:\/[^/]+(?:\/[^/]+(?:\/[^/]+)?)?)?\/?$/,
    /^\/api\/database-connections\/check\/?$/, /^\/api\/backups\/?$/,
  ];
  return controlled.some((pattern) => pattern.test(path)) ? "controlled" : "high";
}
