import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { buildApp } from "../../../src/server/index.js";
import { Store } from "../../../src/server/db.js";
import { designChangeBodyDigest } from "../../../src/server/designChange.js";
import { expectedChallengeResponse } from "../../../src/server/agentSecurity.js";
import { LocalMcpClient, mcpResultText } from "../../../src/server/localMcpClient.js";
import { createMcpServer } from "../../../src/mcp/index.js";
import type { AgentBlueprintKey, AgentTaskPackage, DesignDoc, Diagram, Evidence, PlanItem, Project } from "../../../src/shared/types.js";

type Actor = { agentId: string; workerId: string; role: AgentBlueprintKey; connectionId: string; authSessionToken: string; policyAckToken: string };
type Worker = Actor & { packet: AgentTaskPackage };
type Task = { actionCode: string; available: boolean; taskKey: string; requiredRole: AgentBlueprintKey; assignee: { agentId: string }; planItemId: string | null; nodeId: string | null };

/** Disposable scripted actors exercise the ordinary protocol; this is not model execution.
 * Store is owned solely by the non-trusted MCP server: no test writes SQL or approved state.
 */
export async function createGovernedProject(name = "设计变更浏览器测试") {
  const dir = mkdtempSync(join(tmpdir(), "pcs-governed-browser-"));
  const dataDir = join(dir, "data"), repo = join(dir, "repo"); mkdirSync(repo);
  const dbPath = join(dataDir, "browser.db");
  const priorAdmin = process.env.PCS_AGENT_ADMIN_TOKEN;
  const admin = `synthetic-browser-only-${randomUUID()}`;
  process.env.PCS_AGENT_ADMIN_TOKEN = admin;
  let app: ReturnType<typeof buildApp> | undefined;
  let store: Store | undefined;
  let client: LocalMcpClient | undefined;
  const close = async () => {
    try { await client?.close(); }
    finally {
      try { await app?.close(); }
      finally {
        try { store?.close(); }
        finally {
          if (priorAdmin === undefined) delete process.env.PCS_AGENT_ADMIN_TOKEN; else process.env.PCS_AGENT_ADMIN_TOKEN = priorAdmin;
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  };
  try {
  app = buildApp({ dbPath, dataDir });
  store = new Store(dbPath, dataDir);
  const mcpStore = store;
  const mcp = client = await LocalMcpClient.connect(() => createMcpServer({ store: mcpStore, dbPath, dataDir }));
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  let sequence = 0;
  const correlationId = `browser-governed-${randomUUID()}`;
  const raw = async (method: string, path: string, body?: object, credentialAdmin = false) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", ...(credentialAdmin ? { authorization: `Bearer ${admin}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ok: response.ok, body: await response.json() };
  };
  const http = async <T = any>(method: string, path: string, body?: object, credentialAdmin = false): Promise<T> => {
    const response = await raw(method, path, body, credentialAdmin);
    // Never print a successful enrollment or authentication response (contains ephemeral fixture credentials).
    expect(response.ok, `${method} ${path}: ${response.ok ? "ok" : JSON.stringify(response.body)}`).toBe(true);
    return response.body as T;
  };
  const project = await http<Project>("POST", "/api/projects", { code: `E2E-GOV-${randomUUID().slice(0, 8)}`, name, summary: "隔离脚本验收：设计、实现与独立复核保持工单和修订关联。" });
  const workflow = () => http("GET", `/api/projects/${project.id}/workflow`);
  await workflow();
  const actors = new Map<string, Actor>();
  const enroll = async (agentId: string, role: AgentBlueprintKey): Promise<Actor> => {
    const key = `${role}:${agentId}`; const cached = actors.get(key); if (cached) return cached;
    const workerId = `synthetic-worker-${++sequence}`, connectionId = `synthetic-connection-${sequence}`;
    const credential = await http("POST", "/api/agent-security/credentials", { principalId: `synthetic/${workerId}`, agentId, workerId, allowedRoles: [role], allowedProjects: [project.id] }, true);
    const challenge = await http("POST", "/api/agent-security/auth/challenge", { credentialId: credential.credentialId, connectionId });
    const timestamp = new Date().toISOString(), protocolVersion = "2025-06-18";
    const auth = await http("POST", "/api/agent-security/auth/complete", { challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion, response: expectedChallengeResponse(credential.credentialSecret, challenge.challenge, connectionId, credential.credentialId, timestamp, protocolVersion) });
    const policy = await http("GET", "/api/agent-security/policy");
    const ack = await http("POST", "/api/agent-security/policy/ack", { authSessionToken: auth.authSessionToken, role, projectId: project.id, policyVersion: policy.policyVersion });
    const actor = { agentId, workerId, role, connectionId, authSessionToken: auth.authSessionToken, policyAckToken: ack.policyAckToken }; actors.set(key, actor); return actor;
  };
  const context = (worker: Worker) => ({ workOrderId: worker.packet.lease!.workOrderId, leaseToken: worker.packet.lease!.leaseToken,
    taskKey: worker.packet.lease!.taskKey, taskRevision: worker.packet.lease!.taskRevision, workerId: worker.workerId, agentId: worker.agentId,
    role: worker.role, authSessionToken: worker.authSessionToken, connectionId: worker.connectionId, policyAckToken: worker.policyAckToken,
    idempotencyKey: `synthetic-operation-${++sequence}`, sessionId: `${worker.agentId}-session`, correlationId, actor: worker.agentId });
  const sign = async (worker: Worker, body: Record<string, unknown>, action: string, target: string) => {
    const bodyDigest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const nonce = await http("POST", "/api/agent-security/nonces", { policyAckToken: worker.policyAckToken, workOrderId: worker.packet.lease!.workOrderId, action, target, bodyDigest });
    return { ...body, bodyDigest, nonceId: nonce.nonceId };
  };
  const write = async <T = any>(worker: Worker, method: string, path: string, payload: object, action: string) => {
    await workflow(); const result = await http<T>(method, path, await sign(worker, { ...context(worker), ...payload }, action, `rest:${path}`)); await workflow(); return result;
  };
  const call = async (worker: Worker, name: string, fields: object) => {
    await workflow(); const args = await sign(worker, { ...context(worker), ...fields }, `mcp.${name}`, `mcp:${name}`);
    const response = await mcp.callTool(name, args); expect(response.isError, response.isError ? mcpResultText(response) : "ok").not.toBe(true); await workflow(); return response;
  };
  const claim = async (actionCode: string, planId?: string): Promise<Worker> => {
    await workflow();
    const tasks = await http<Task[]>("GET", `/api/projects/${project.id}/agent-tasks`);
    const task = tasks.find((item) => item.actionCode === actionCode && item.available && (!planId || item.planItemId === planId));
    expect(task, `Missing ${actionCode}; available: ${tasks.map((item) => `${item.actionCode}:${item.available}`).join(",")}`).toBeTruthy();
    const actor = await enroll(task!.assignee.agentId, task!.requiredRole);
    const packet = await http<AgentTaskPackage>("POST", `/api/projects/${project.id}/agent-task-package`, { taskKey: task!.taskKey, role: actor.role, agentId: actor.agentId, workerId: actor.workerId, authSessionToken: actor.authSessionToken, sessionId: `${actor.agentId}-session`, idempotencyKey: `synthetic-claim-${++sequence}` });
    const worker = { ...actor, packet };
    await write(worker, "POST", "/api/agent-task-leases/start", {}, "rest.start_agent_task");
    return worker;
  };
  const complete = (worker: Worker, fields: object = {}) => write(worker, "POST", "/api/agent-task-leases/complete", { resultDigest: "脚本复核了当前固定修订与边界；不是模型生成验收", ...fields }, "rest.complete_agent_task");
  const evidence = (worker: Worker, document: DesignDoc, scope: "design" | "implementation", plan?: PlanItem, revision = "", output = "Reviewed current synthetic design document and acceptance boundary") => write<Evidence>(worker, "POST", "/api/evidence", {
    projectId: project.id, nodeId: plan?.diagramNodeId ?? null, planItemId: plan?.id ?? null, sourceType: "manual", sourcePath: "synthetic-browser-fixture",
    command: scope === "implementation" ? "node --test --test-reporter=tap arithmetic.test.mjs" : "scripted fixed-revision design review", resultStatus: "pass",
    summary: scope === "implementation" ? "隔离脚本进程测试证据（非真实模型）" : "旧设计浏览器证据", actorRole: worker.role,
    documentRevisionId: document.currentRevisionId, commitSha: revision, acceptanceCriterionKey: "sum-fixture",
    details: { auditScope: scope, fixtureOnly: true, output, ...(revision ? { implementationRevision: revision } : {}) },
  }, "rest.create_evidence");
  const transition = async (worker: Worker, plan: PlanItem, action: string, fields: object = {}, failure = false) => {
    await workflow(); const body = await sign(worker, { ...context(worker), action, clientId: "playwright-synthetic-protocol", ...fields }, `plan.${action}`, `plan:${plan.id}`);
    const result = await raw("POST", `/api/plans/${plan.id}/transition`, body);
    if (failure) expect(result.status).toBe(409); else expect(result.ok, result.ok ? "ok" : JSON.stringify(result.body)).toBe(true);
    if (!failure) {
      const expectedStatus: Record<string, string> = { submit_plan: "pending_approval", pass_design_audit: "pending_approval", approve_plan: "approved", start_development: "in_progress", complete_development: "pending_audit", pass_audit: "pending_manager", approve_acceptance: "accepted" };
      expect((result.body as PlanItem).lifecycleStatus, `transition ${action}`).toBe(expectedStatus[action]);
      expect((await http<PlanItem>("GET", `/api/plans/${plan.id}`)).lifecycleStatus, `persisted ${action}`).toBe(expectedStatus[action]);
    }
    await workflow(); return result.body as PlanItem;
  };
  const setupDesign = async (withDependentPlan = false) => {
    const designer = await claim("prepare_project_brief");
    const brief = await write<DesignDoc>(designer, "POST", "/api/design-docs", { projectId: project.id, category: "需求文档", title: "项目简报", summary: "目标、范围、约束与成功标准", status: "评审中", version: "1.0", author: designer.agentId, content: "目标：验证工单流程。范围：隔离加法示例。非目标：真实模型或用户源码。标准：正数、负数、零相加正确；独立复测并明确批准。", references: [{ targetType: "project", targetId: project.id, relationType: "defines" }] }, "rest.create_design_doc");
    await complete(designer, { documentRevisionId: brief.currentRevisionId });
    const briefAuditor = await claim("audit_project_brief"); const briefEvidence = await evidence(briefAuditor, brief, "design");
    await complete(briefAuditor, { evidenceId: briefEvidence.id, verdict: "pass" });
    await complete(await claim("approve_project_brief"), { verdict: "pass" });
    const diagrams = await http<Diagram[]>("GET", `/api/diagrams?projectId=${project.id}`); let diagram = diagrams.find((item) => item.type === "main")!;
    const split = await claim("add_function_node");
    await call(split, "mutate_diagram", { diagramId: diagram.id, expectedUpdatedAt: diagram.updatedAt, operations: [{ op: "add_node", node: { kind: "feature", label: "设计变更测试节点", x: 620, y: 180 } }] });
    await complete(split);
    diagram = await http<Diagram>("GET", `/api/diagrams/${diagram.id}`); const node = diagram.nodes.find((item) => item.kind === "feature")!;
    const definition = await claim("complete_node_definition");
    const document = await write<DesignDoc>(definition, "POST", "/api/design-docs", { projectId: project.id, category: "功能说明", title: "浏览器测试详细设计", summary: "隔离加法设计", status: "评审中", version: "1.0", author: definition.agentId, content: "sum(a,b)返回数字相加，覆盖正数、负数与零；所有实现工作仅在一次性合成目录。", references: [{ targetType: "diagramNode", targetId: node.id, relationType: "defines" }] }, "rest.create_design_doc");
    const plan = await write<PlanItem>(definition, "POST", "/api/plans", { projectId: project.id, diagramId: diagram.id, diagramNodeId: node.id, kind: "task", title: "浏览器测试开发计划", description: "编写隔离加法并执行Node测试，由不同角色重新执行。", roleAssignments: { designer: { agentId: "synthetic-designer", displayName: "Designer fixture" }, builder: { agentId: "synthetic-builder", displayName: "Builder fixture" }, auditor: { agentId: "synthetic-auditor", displayName: "Auditor fixture" } }, priority: "P1" }, "rest.create_plan_item");
    const dependentPlan = withDependentPlan ? await write<PlanItem>(definition, "POST", "/api/plans", {
      projectId: project.id, diagramId: diagram.id, diagramNodeId: node.id, kind: "task", title: "Governed dependent layer",
      dependencyIds: [plan.id], roleAssignments: plan.roleAssignments, priority: "P1",
    }, "rest.create_plan_item") : undefined;
    diagram = await http<Diagram>("GET", `/api/diagrams/${diagram.id}`);
    await call(definition, "mutate_diagram", { diagramId: diagram.id, expectedUpdatedAt: diagram.updatedAt, operations: [{ op: "update_node", nodeId: node.id, patch: { description: "隔离加法测试，处理正数、负数和零", owner: "Synthetic team", acceptanceCriteria: "sum-fixture：正数、负数、零相加正确", requirementStatus: "待评审" } }] });
    await complete(definition, { documentRevisionId: document.currentRevisionId });
    await complete(await claim("approve_node_requirement"));
    await complete(await claim("approve_node_document"));
    const approvedDocument = await http<DesignDoc>("GET", `/api/design-docs/${document.id}?projectId=${project.id}`);
    const planDesigner = await claim("submit_plan", plan.id); await transition(planDesigner, plan, "submit_plan", { documentRevisionId: approvedDocument.currentRevisionId });
    const designAuditor = await claim("audit_design", plan.id); const designEvidence = await evidence(designAuditor, approvedDocument, "design", plan);
    await transition(designAuditor, plan, "pass_design_audit", { evidenceId: designEvidence.id, verdict: "pass", reworkConditions: "设计修订后重新审计" });
    await transition(await claim("approve_plan", plan.id), plan, "approve_plan");
    return { diagramId: diagram.id, nodeId: node.id, document: approvedDocument, plan, designEvidence, dependentPlan };
  };
  const deliver = async (design: Awaited<ReturnType<typeof setupDesign>>, version = 1) => {
    // Local scripted implementation is real executable evidence, not a model or browser claim.
    if (version === 1) {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Disposable arithmetic fixture\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("add", "."); git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture baseline");
    await http("PATCH", `/api/projects/${project.id}`, { repositoryPath: repo }); await workflow();
    }
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    const builder = await claim("start_development", design.plan.id);
    await transition(builder, design.plan, "complete_development", { implementationRevision: git("rev-parse", "HEAD") }, true);
    await transition(builder, design.plan, "start_development");
    writeFileSync(join(repo, "arithmetic.mjs"), version === 1 ? "export const sum = (a, b) => a + b;\n" : "export const sum = (a, b) => [a, b].reduce((total, value) => total + value, 0);\n");
    writeFileSync(join(repo, "arithmetic.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './arithmetic.mjs'; test('positive negative zero',()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,3),1);assert.equal(sum(0,0),0);});\n");
    if (version === 2) writeFileSync(join(repo, "arithmetic.test.mjs"), readFileSync(join(repo, "arithmetic.test.mjs"), "utf8") + "test('fractional and safe-integer boundaries',()=>{assert.equal(sum(0.25,0.5),0.75);assert.equal(sum(-0.5,0.25),-0.25);assert.equal(sum(Number.MAX_SAFE_INTEGER-1,1),Number.MAX_SAFE_INTEGER);});\n");
    const builderOutput = execFileSync(process.execPath, ["--test", "--test-reporter=tap", "arithmetic.test.mjs"], { cwd: repo, encoding: "utf8" });
    git("add", "."); git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture implementation"); const revision = git("rev-parse", "HEAD");
    const built = await evidence(builder, design.document, "implementation", design.plan, revision, builderOutput);
    await transition(builder, design.plan, "complete_development", { implementationRevision: revision, evidenceId: built.id, testCommand: built.command });
    const auditor = await claim("audit_completed_plan", design.plan.id);
    expect(readFileSync(join(repo, "arithmetic.mjs"), "utf8")).toContain(version === 1 ? "a + b" : "reduce");
    const auditOutput = execFileSync(process.execPath, ["--test", "--test-reporter=tap", "arithmetic.test.mjs"], { cwd: repo, encoding: "utf8" });
    const reviewed = await evidence(auditor, design.document, "implementation", design.plan, revision, auditOutput);
    await transition(auditor, design.plan, "pass_audit", { evidenceId: reviewed.id, verdict: "pass", reworkConditions: "实现修订后重新执行独立测试" });
    return transition(await claim("approve_acceptance", design.plan.id), design.plan, "approve_acceptance");
  };
  const assertDependentLayerLocked = async (design: Awaited<ReturnType<typeof setupDesign>>) => {
    expect(design.dependentPlan).toBeTruthy(); await workflow();
    expect((await http<PlanItem>("GET", `/api/plans/${design.plan.id}`)).lifecycleStatus).toBe("approved");
    const before = await http("GET", `/api/projects/${project.id}/agent-task-leases`);
    const builder = await enroll("synthetic-builder", "builder");
    const response = await raw("POST", `/api/projects/${project.id}/agent-task-package`, {
      taskId: `development:${design.dependentPlan!.id}`, role: builder.role, agentId: builder.agentId,
      workerId: builder.workerId, authSessionToken: builder.authSessionToken, idempotencyKey: `locked-layer-${++sequence}`,
    });
    expect(response.status).toBe(409); expect(response.body).toMatchObject({ code: "PLAN_LAYER_LOCKED" });
    expect(await http("GET", `/api/projects/${project.id}/agent-task-leases`)).toEqual(before);
    expect((await http<PlanItem>("GET", `/api/plans/${design.dependentPlan!.id}`)).lifecycleStatus).toBe("draft");
    await workflow();
  };
  const reworkAccepted = async (design: Awaited<ReturnType<typeof setupDesign>>) => {
    await workflow();
    const before = await http<Diagram>("GET", `/api/diagrams/${design.diagramId}`);
    const intent = await http("POST", `/api/projects/${project.id}/design-change-intents`, {
      diagramId: design.diagramId, nodeId: design.nodeId, rootPlanId: design.plan.id,
      reason: "Refine numeric addition implementation and independently test boundary coverage",
      changeSummary: "v2 retains numeric addition contract; explicitly verify fractional and safe-integer boundaries",
      expectedUpdatedAt: before.updatedAt, idempotencyKey: `v2-intent-${++sequence}`,
    }); await workflow();
    const approver = await claim("request_design_change");
    const change = { projectId: project.id, intentId: intent.intentId, diagramId: design.diagramId, nodeId: design.nodeId,
      actor: approver.agentId, reason: "Refine numeric addition implementation and independently test boundary coverage",
      changeSummary: "v2 retains numeric addition contract; explicitly verify fractional and safe-integer boundaries",
      requirementImpact: false, impactedDocumentIds: [design.document.id], impactedPlanIds: [design.plan.id],
      reusableWorkSummary: "Preserve accepted v1 and its historical evidence", reworkScope: "New implementation revision, expanded executable tests and independent review",
      apiImpact: "No signature change", databaseImpact: "None", deploymentImpact: "Disposable local fixture only",
      expectedUpdatedAt: (await http<Diagram>("GET", `/api/diagrams/${design.diagramId}`)).updatedAt,
      idempotencyKey: `v2-change-${++sequence}` };
    const proof = context(approver);
    const bodyDigest = designChangeBodyDigest({ ...change, sessionId: proof.sessionId }, { source: "web", agent: proof });
    const nonce = await http("POST", "/api/agent-security/nonces", { policyAckToken: approver.policyAckToken,
      workOrderId: proof.workOrderId, action: "rest.request_design_change", target: "rest:/api/projects/:id/design-changes", bodyDigest });
    const changed = await http("POST", `/api/projects/${project.id}/design-changes`, { ...proof, ...change, bodyDigest, nonceId: nonce.nonceId });
    await workflow();
    expect(changed.reworkPlanIds).toHaveLength(1);
    const plan = await http<PlanItem>("GET", `/api/plans/${changed.reworkPlanIds[0]}`);
    expect(plan.reworkOfPlanId).toBe(design.plan.id);
    expect((await http<PlanItem>("GET", `/api/plans/${design.plan.id}`)).lifecycleStatus).toBe("accepted");
    await complete(await claim("approve_node_document"));
    const document = await http<DesignDoc>("GET", `/api/design-docs/${design.document.id}?projectId=${project.id}`);
    expect(document.currentRevisionId).not.toBe(design.document.currentRevisionId);
    const designer = await claim("submit_plan", plan.id);
    const references = await http<Array<{id: string; documentId: string; targetId: string; targetType: string}>>("GET", `/api/document-references?projectId=${project.id}`);
    for (const reference of references.filter((item) => item.documentId === document.id && (item.targetId === plan.id || item.targetId === design.nodeId))) {
      await call(designer, "refresh_document_reference", { referenceId: reference.id });
    }
    await transition(designer, plan, "submit_plan", { documentRevisionId: document.currentRevisionId });
    const auditor = await claim("audit_design", plan.id);
    // Historical v1 report cannot be reused for this new frozen revision.
    const rejectedHistoricalEvidence = await transition(auditor, plan, "pass_design_audit", { evidenceId: design.designEvidence.id, verdict: "pass", reworkConditions: "recheck on revision" }, true);
    expect(rejectedHistoricalEvidence).toMatchObject({ message: "设计审计通过前必须存在由受派审计者创建、auditScope=design 且绑定当前固定文档修订的有效通过证据" });
    const designEvidence = await evidence(auditor, document, "design", plan);
    await transition(auditor, plan, "pass_design_audit", { evidenceId: designEvidence.id, verdict: "pass", reworkConditions: "recheck on revision" });
    await transition(await claim("approve_plan", plan.id), plan, "approve_plan");
    return { ...design, plan, document, designEvidence, changeId: changed.changeId };
  };
  return { origin, project, http, raw, workflow, setupDesign, deliver, reworkAccepted, assertDependentLayerLocked, correlationId, close };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
