import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../mcp/index.js";
import type { AgentBlueprintKey, AgentTaskPackage, Evidence, Project } from "../shared/types.js";
import { expectedChallengeResponse } from "./agentSecurity.js";
import { Store } from "./db.js";
import { buildApp } from "./index.js";
import { LocalMcpClient, mcpResultText } from "./localMcpClient.js";

type Transport = "REST" | "MCP";
type Actor = { agentId: string; workerId: string; role: AgentBlueprintKey; authSessionToken: string;
  connectionId: string; policyAckToken: string };
type Worker = Actor & { packet: AgentTaskPackage };
const resources: Array<{ app: ReturnType<typeof buildApp>; store: Store; dir: string; client: LocalMcpClient }> = [];
afterEach(async () => {
  for (const { app, store, dir, client } of resources.splice(0)) {
    await client.close(); await app.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

async function fixture(transport: Transport) {
  const dir = mkdtempSync(join(tmpdir(), "pcs-plan-submission-"));
  const dbPath = join(dir, "fixture.db");
  vi.stubEnv("PCS_AGENT_ADMIN_TOKEN", "synthetic-plan-submission-admin");
  const app = buildApp({ dbPath, dataDir: dir });
  const store = new Store(dbPath, dir);
  const client = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir: dir }));
  resources.push({ app, store, dir, client });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const rawHttp = async (method: string, path: string, payload?: object, admin = false) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json",
      ...(admin ? { authorization: "Bearer synthetic-plan-submission-admin" } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}) });
    return { ok: response.ok, body: await response.json() };
  };
  const http = async <T = unknown>(method: string, path: string, payload?: object, admin = false): Promise<T> => {
    const response = await rawHttp(method, path, payload, admin);
    expect(response.ok, JSON.stringify(response.body)).toBe(true);
    return response.body as T;
  };
  const project = await http<Project>("POST", "/api/projects", { code: "SUBMISSION-FIXTURE", name: "Plan submission fixture" });
  await http("PATCH", `/api/projects/${project.id}`, { repositoryPath: dir });
  // Historical approved design is test setup only. All delivery actions below use
  // the public transports with real, disposable registered credentials and leases.
  const document = store.insertDesignDoc({ projectId: project.id, category: "需求文档", title: "项目简报", summary: "Synthetic fixture",
    content: "Synthetic transport regression; no production implementation claimed", status: "已批准", version: "1", author: "fixture" });
  store.insertDocumentReference({ projectId: project.id, documentId: document.id, targetType: "project", targetId: project.id, relationType: "defines" });
  const main = store.listDiagrams(project.id).find((item) => item.type === "main")!;
  const nodeId = "submission-fixture";
  store.updateDiagram(main.id, { nodes: [...main.nodes, { id: nodeId, kind: "feature", label: "Transport regression", description: "Synthetic fixture",
    owner: "team", acceptanceCriteria: "Preserve submitted completion fields", requirementStatus: "已批准", designStatus: "已批准",
    developmentStatus: "未开发", acceptanceStatus: "未验收", x: 600, y: 160 }] });
  store.insertDocumentReference({ projectId: project.id, documentId: document.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines" });
  const plan = store.insertPlan({ projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId: null, kind: "task",
    title: "Transport completion", description: "Synthetic fixture", status: "未开始", priority: "P2", progress: 0, owner: "builder",
    versionTag: "1", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "", lifecycleStatus: "draft",
    roleAssignments: { designer: { agentId: "designer", displayName: "Designer" }, builder: { agentId: "builder", displayName: "Builder" }, auditor: { agentId: "auditor", displayName: "Auditor" } } });
  let sequence = 0;
  const actors = new Map<string, Actor>();
  const enroll = async (role: AgentBlueprintKey): Promise<Actor> => {
    if (actors.has(role)) return actors.get(role)!;
    const agentId = role === "approver" ? "Main Agent" : role;
    const workerId = `fixture-${role}`, connectionId = `plan-submission-connection-${role}`;
    const credential = await http<{ credentialId: string; credentialSecret: string }>("POST", "/api/agent-security/credentials", {
      principalId: `fixture/${role}`, agentId, workerId, allowedRoles: [role], allowedProjects: [project.id],
    }, true);
    const challenge = await http<{ challengeId: string; challenge: string }>("POST", "/api/agent-security/auth/challenge", { credentialId: credential.credentialId, connectionId });
    const timestamp = new Date().toISOString(), protocolVersion = "2025-06-18";
    const principal = await http<{ authSessionToken: string }>("POST", "/api/agent-security/auth/complete", { challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion,
      response: expectedChallengeResponse(credential.credentialSecret, challenge.challenge, connectionId, credential.credentialId, timestamp, protocolVersion) });
    const policy = await http<{ policyVersion: string }>("GET", "/api/agent-security/policy");
    const ack = await http<{ policyAckToken: string }>("POST", "/api/agent-security/policy/ack", { authSessionToken: principal.authSessionToken, role, projectId: project.id, policyVersion: policy.policyVersion });
    const actor = { agentId, workerId, role, connectionId, authSessionToken: principal.authSessionToken, policyAckToken: ack.policyAckToken };
    actors.set(role, actor);
    return actor;
  };
  const context = (worker: Worker) => {
    const lease = worker.packet.lease!;
    return { workOrderId: lease.workOrderId, leaseToken: lease.leaseToken, taskKey: lease.taskKey, taskRevision: lease.taskRevision,
      workerId: worker.workerId, agentId: worker.agentId, role: worker.role, authSessionToken: worker.authSessionToken,
      connectionId: worker.connectionId, policyAckToken: worker.policyAckToken, idempotencyKey: `fixture-operation-${++sequence}` };
  };
  const sign = async (worker: Worker, body: Record<string, unknown>, action: string, target: string) => {
    const bodyDigest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const nonce = await http<{ nonceId: string }>("POST", "/api/agent-security/nonces", {
      policyAckToken: worker.policyAckToken, workOrderId: worker.packet.lease!.workOrderId, action, target, bodyDigest,
    });
    return { ...body, bodyDigest, nonceId: nonce.nonceId };
  };
  const workflow = () => http("GET", `/api/projects/${project.id}/workflow`);
  const claim = async (role: AgentBlueprintKey, actionCode: string): Promise<Worker> => {
    await workflow();
    const actor = await enroll(role);
    const tasks = await http<Array<{ taskKey: string; actionCode: string; planItemId: string; available: boolean }>>("GET", `/api/projects/${project.id}/agent-tasks`);
    const task = tasks.find((item) => item.planItemId === plan.id && item.actionCode === actionCode && item.available);
    expect(task, JSON.stringify(tasks)).toBeTruthy();
    const packet = await http<AgentTaskPackage>("POST", `/api/projects/${project.id}/agent-task-package`, {
      taskKey: task!.taskKey, role, agentId: actor.agentId, workerId: actor.workerId, authSessionToken: actor.authSessionToken, idempotencyKey: `fixture-claim-${++sequence}`,
    });
    const worker = { ...actor, packet };
    const path = "/api/agent-task-leases/start";
    await http("POST", path, await sign(worker, context(worker), "rest.start_agent_task", `rest:${path}`));
    await workflow();
    return worker;
  };
  const transition = async (worker: Worker, action: string, fields: Record<string, unknown> = {}, expectedError?: string) => {
    const body = await sign(worker, { ...context(worker), ...(transport === "MCP" ? { planId: plan.id } : {}), action, actor: worker.agentId, ...fields }, `plan.${action}`, `plan:${plan.id}`);
    if (transport === "REST") {
      const response = await rawHttp("POST", `/api/plans/${plan.id}/transition`, body);
      if (expectedError) { expect(response.ok).toBe(false); expect(response.body.code).toBe(expectedError); }
      else expect(response.ok, JSON.stringify(response.body)).toBe(true);
    } else {
      const response = await client.callTool("transition_plan_delivery", body);
      if (expectedError) { expect(response.isError).toBe(true); expect(mcpResultText(response)).toContain(expectedError); }
      else expect(response.isError, mcpResultText(response)).not.toBe(true);
    }
    await workflow();
    return store.getPlan(plan.id)!;
  };
  const evidence = async (worker: Worker, scope: "design" | "implementation", resultStatus: "pass" | "fail" = "pass") => {
    const path = "/api/evidence";
    return http<Evidence>("POST", path, await sign(worker, { ...context(worker), projectId: project.id, nodeId, planItemId: plan.id,
      actorRole: worker.role, sourceType: "manual", sourcePath: "synthetic-fixture.json", command: "synthetic fixture check", resultStatus,
      summary: "Synthetic transport regression evidence", documentRevisionId: document.currentRevisionId,
      commitSha: scope === "implementation" ? "fixture-implementation" : "", details: { auditScope: scope,
        ...(scope === "implementation" ? { implementationRevision: "fixture-implementation" } : {}) },
    }, "rest.create_evidence", `rest:${path}`));
  };
  const assertLeaseStatus = (worker: Worker, status: string) => expect(store.db.prepare("SELECT status FROM agent_task_leases WHERE id=?")
    .get(worker.packet.lease!.workOrderId)).toEqual({ status });
  const copyEvidence = (source: Evidence, patch: Partial<Evidence>) => {
    const { id: _, ...fields } = source;
    return store.insertEvidence({ ...fields, ...patch });
  };
  return { store, project, plan, document, claim, transition, evidence, assertLeaseStatus, copyEvidence };
}

describe.each<Transport>(["REST", "MCP"])("authenticated %s plan completion contract", (transport) => {
  it.each(["pass", "fail"] as const)("preserves exact submissions through a %s implementation audit", async (verdict) => {
    const f = await fixture(transport);
    const designer = await f.claim("designer", "submit_plan");
    await f.transition(designer, "submit_plan", {}, "WORK_ORDER_SUBMISSION_INCOMPLETE");
    expect(f.store.getPlan(f.plan.id)?.lifecycleStatus).toBe("draft");
    f.assertLeaseStatus(designer, "running");
    await f.transition(designer, "submit_plan", { documentRevisionId: f.document.currentRevisionId, taskRevision: "wrong-revision" }, "WORK_ORDER_CONTEXT_INVALID");
    const unrelatedDesign = f.store.insertDesignDoc({ projectId: f.project.id, category: "功能说明", title: "Unrelated fixture design",
      summary: "Fixture only", content: "Not in this plan baseline", status: "已批准", version: "1", author: "fixture" });
    for (const documentRevisionId of ["nonexistent-fixture-revision", unrelatedDesign.currentRevisionId]) {
      await f.transition(designer, "submit_plan", { documentRevisionId }, "WORK_ORDER_SUBMISSION_MISMATCH");
      expect(f.store.getPlan(f.plan.id)?.lifecycleStatus).toBe("draft");
      f.assertLeaseStatus(designer, "running");
    }
    const submitted = await f.transition(designer, "submit_plan", { documentRevisionId: f.document.currentRevisionId });
    expect(submitted).toMatchObject({ lifecycleStatus: "pending_approval", designRevisionIds: [f.document.currentRevisionId] });
    f.assertLeaseStatus(designer, "completed");
    const designAuditor = await f.claim("auditor", "audit_design");
    const designEvidence = await f.evidence(designAuditor, "design");
    await f.transition(designAuditor, "pass_design_audit", { evidenceId: designEvidence.id, reworkConditions: "Recheck if the fixed design changes" }, "WORK_ORDER_SUBMISSION_INCOMPLETE");
    await f.transition(designAuditor, "pass_design_audit", { evidenceId: designEvidence.id, verdict: "pass" }, "WORK_ORDER_SUBMISSION_INCOMPLETE");
    // These inconsistent records exist only in this disposable test fixture.
    // A separate qualifying record must never authorize the selected record.
    const foreignProject = f.store.insertProject({ ...f.project, id: undefined, code: "OTHER-FIXTURE", name: "Other fixture" });
    const invalidDesignEvidence: Partial<Evidence>[] = [
      { status: "revoked" }, { projectId: foreignProject.id }, { planItemId: null }, { nodeId: null },
      { agentId: "other-fixture-auditor" }, { actorRole: "builder" }, { resultStatus: "fail" },
      { details: { auditScope: "implementation" } }, { documentRevisionId: unrelatedDesign.currentRevisionId },
    ];
    for (const patch of invalidDesignEvidence) {
      const selected = f.copyEvidence(designEvidence, patch);
      await f.transition(designAuditor, "pass_design_audit", { evidenceId: selected.id, verdict: "pass",
        reworkConditions: "Fixture rework conditions" }, "WORK_ORDER_SUBMISSION_MISMATCH");
      expect(f.store.getPlan(f.plan.id)?.auditStatus).toBe("pending");
      f.assertLeaseStatus(designAuditor, "running");
    }
    await f.transition(designAuditor, "pass_design_audit", { evidenceId: designEvidence.id, verdict: "fail",
      reworkConditions: "Fixture rework conditions" }, "WORK_ORDER_SUBMISSION_MISMATCH");
    await f.transition(designAuditor, "pass_design_audit", { evidenceId: designEvidence.id, verdict: "pass",
      documentRevisionId: unrelatedDesign.currentRevisionId, reworkConditions: "Fixture rework conditions" }, "WORK_ORDER_SUBMISSION_MISMATCH");
    expect(f.store.getPlan(f.plan.id)?.auditStatus).toBe("pending");
    f.assertLeaseStatus(designAuditor, "running");
    expect(await f.transition(designAuditor, "pass_design_audit", { evidenceId: designEvidence.id, verdict: "pass", reworkConditions: "Recheck if the fixed design changes" }))
      .toMatchObject({ auditStatus: "passed" });
    f.assertLeaseStatus(designAuditor, "completed");
    const approver = await f.claim("approver", "approve_plan");
    await f.transition(approver, "approve_plan");
    const builder = await f.claim("builder", "start_development");
    expect(await f.transition(builder, "start_development")).toMatchObject({ lifecycleStatus: "in_progress" });
    const builderEvidence = await f.evidence(builder, "implementation");
    await f.transition(builder, "complete_development", { implementationRevision: "fixture-implementation", evidenceId: builderEvidence.id }, "WORK_ORDER_SUBMISSION_INCOMPLETE");
    for (const fields of [
      { evidenceId: builderEvidence.id, testCommand: "different fixture command", implementationRevision: "fixture-implementation" },
      { evidenceId: builderEvidence.id, testCommand: builderEvidence.command, implementationRevision: "different-fixture-revision" },
      { evidenceId: f.copyEvidence(builderEvidence, { resultStatus: "fail" }).id, testCommand: builderEvidence.command, implementationRevision: "fixture-implementation" },
    ]) {
      await f.transition(builder, "complete_development", fields, "WORK_ORDER_SUBMISSION_MISMATCH");
      expect(f.store.getPlan(f.plan.id)?.lifecycleStatus).toBe("in_progress");
      f.assertLeaseStatus(builder, "running");
    }
    expect(f.store.getPlan(f.plan.id)?.lifecycleStatus).toBe("in_progress");
    f.assertLeaseStatus(builder, "running");
    expect(await f.transition(builder, "complete_development", { implementationRevision: "fixture-implementation", evidenceId: builderEvidence.id, testCommand: builderEvidence.command }))
      .toMatchObject({ lifecycleStatus: "pending_audit" });
    f.assertLeaseStatus(builder, "completed");
    const auditor = await f.claim("auditor", "audit_completed_plan");
    const implementationEvidence = await f.evidence(auditor, "implementation");
    for (const patch of [
      { commitSha: "different-fixture-revision" },
      { details: { auditScope: "implementation", implementationRevision: "different-fixture-revision" } },
      { details: { auditScope: "design", implementationRevision: "fixture-implementation" } },
      { nodeId: null }, { resultStatus: "fail" },
    ] satisfies Partial<Evidence>[]) {
      const selected = f.copyEvidence(implementationEvidence, patch);
      await f.transition(auditor, "pass_audit", { evidenceId: selected.id, verdict: "pass",
        reworkConditions: "Fixture rework conditions" }, "WORK_ORDER_SUBMISSION_MISMATCH");
      expect(f.store.getPlan(f.plan.id)?.lifecycleStatus).toBe("pending_audit");
      f.assertLeaseStatus(auditor, "running");
    }
    await f.transition(auditor, "pass_audit", { evidenceId: implementationEvidence.id, verdict: "fail",
      reworkConditions: "Fixture rework conditions" }, "WORK_ORDER_SUBMISSION_MISMATCH");
    await f.transition(auditor, "pass_audit", { evidenceId: implementationEvidence.id, verdict: "pass",
      implementationRevision: "different-fixture-revision", reworkConditions: "Fixture rework conditions" }, "WORK_ORDER_SUBMISSION_MISMATCH");
    const finalEvidence = verdict === "pass" ? implementationEvidence : await f.evidence(auditor, "implementation", "fail");
    if (verdict === "fail") {
      await f.transition(auditor, "fail_audit", { evidenceId: finalEvidence.id, verdict: "pass", reason: "Fixture implementation failed review",
        reworkConditions: "Fix the documented fixture issue" }, "WORK_ORDER_SUBMISSION_MISMATCH");
      expect(f.store.getPlan(f.plan.id)?.lifecycleStatus).toBe("pending_audit");
      f.assertLeaseStatus(auditor, "running");
    }
    expect(await f.transition(auditor, verdict === "pass" ? "pass_audit" : "fail_audit", { evidenceId: finalEvidence.id, verdict,
      reason: verdict === "fail" ? "Fixture implementation failed review" : undefined,
      reworkConditions: "Rerun review when implementation changes" }))
      .toMatchObject({ lifecycleStatus: verdict === "pass" ? "pending_manager" : "audit_failed", auditStatus: verdict === "pass" ? "passed" : "failed" });
    f.assertLeaseStatus(auditor, "completed");
  });

  it("keeps multi-document baselines and explicit review revisions authoritative", async () => {
    const f = await fixture(transport);
    const review = f.store.insertDesignDoc({ projectId: f.project.id, category: "功能说明", title: "Explicit review baseline",
      summary: "Fixture only", content: "Review revision explicitly bound to this plan", status: "评审中", version: "1", author: "designer" });
    f.store.insertDocumentReference({ projectId: f.project.id, documentId: review.id, targetType: "plan", targetId: f.plan.id, relationType: "defines" });
    const designer = await f.claim("designer", "submit_plan");
    const submitted = await f.transition(designer, "submit_plan", { documentRevisionId: review.currentRevisionId });
    expect(submitted.designRevisionIds).toEqual([f.document.currentRevisionId, review.currentRevisionId].sort());
    f.assertLeaseStatus(designer, "completed");
  });

  it("preserves an independent Auditor's explicit failure and rework conditions", async () => {
    const f = await fixture(transport);
    const designer = await f.claim("designer", "submit_plan");
    await f.transition(designer, "submit_plan", { documentRevisionId: f.document.currentRevisionId });
    const auditor = await f.claim("auditor", "audit_design");
    const evidence = await f.evidence(auditor, "design", "fail");
    await f.transition(auditor, "fail_design_audit", { evidenceId: evidence.id, verdict: "pass",
      reason: "Synthetic design omits a boundary case", reworkConditions: "Fixture rework conditions" }, "WORK_ORDER_SUBMISSION_MISMATCH");
    expect(f.store.getPlan(f.plan.id)?.auditStatus).toBe("pending");
    f.assertLeaseStatus(auditor, "running");
    const failed = await f.transition(auditor, "fail_design_audit", { evidenceId: evidence.id, verdict: "fail",
      reason: "Synthetic design omits a boundary case", reworkConditions: "Add the missing boundary case and submit a new revision" });
    expect(failed).toMatchObject({ lifecycleStatus: "rework", auditStatus: "failed" });
    f.assertLeaseStatus(auditor, "completed");
  });
});
