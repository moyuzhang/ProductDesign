import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "./db.js";
import { syncManagedProject } from "./projectFiles.js";
import { buildProjectWorkflow } from "./workflow.js";
import { claimTaskPackage } from "./claimTaskPackage.js";
import { completeAgentTask, listClaimableAgentTasks, startAgentTask } from "./agentTaskLeases.js";
import { beginAgentAuth, completeAgentAuth, expectedChallengeResponse, registerAgentCredential } from "./agentSecurity.js";
import { claimCoordinationLease, claimDispatchedChildTask, dispatchChildTask, releaseCoordinationLease } from "./coordinationLeases.js";

const resources: Array<{ store: Store; dir: string }> = [];
afterEach(() => {
  for (const { store, dir } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("bootstraps a new project through Designer, independent Auditor, and Main Agent without a code directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcs-project-brief-"));
  const store = new Store(join(dir, "test.db"));
  resources.push({ store, dir });
  const project = store.insertProject({ code: "BRIEF-BOOTSTRAP", name: "简报自举", summary: "目标与范围", stage: "探索",
    health: "正常", progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "",
    repositoryPath: "", startAt: "", dueAt: "" });
  syncManagedProject(store, dir, project);

  const claim = (role: "designer" | "auditor" | "approver", workerId: string) => {
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.requiredRole === role
      && item.actionCode.endsWith("project_brief"))!;
    expect(task.available).toBe(true);
    const packet = JSON.parse(claimTaskPackage(store, { projectId: project.id, taskKey: task.taskKey,
      role, agentId: task.assignee!.agentId, workerId, idempotencyKey: `claim-${workerId}` })) as {
      workingDirectory: { ready: boolean; repositoryPath: string };
      documents: Array<{ documentRevisionId: string }>;
      lease: { leaseToken: string; workOrderId: string; taskKey: string; taskRevision: string; workerId: string; agentId: string };
    };
    expect(packet.workingDirectory.ready).toBe(true);
    startAgentTask(store, { leaseToken: packet.lease.leaseToken, agentId: packet.lease.agentId,
      idempotencyKey: `start-${workerId}` });
    return packet;
  };
  const complete = (packet: ReturnType<typeof claim>, extra: Record<string, string>) =>
    completeAgentTask(store, { leaseToken: packet.lease.leaseToken, agentId: packet.lease.agentId,
      workerId: packet.lease.workerId, workOrderId: packet.lease.workOrderId, taskKey: packet.lease.taskKey,
      taskRevision: packet.lease.taskRevision, role: packet.lease.agentId === "Main Agent" ? "approver"
        : packet.lease.agentId.includes("auditor") ? "auditor" : "designer",
      idempotencyKey: `complete-${packet.lease.workerId}`, ...extra } as never);

  expect(buildProjectWorkflow(store, project.id)?.nextAction?.code).toBe("approve_project_brief");
  const designer = claim("designer", "brief-designer-worker");
  const document = store.insertDesignDoc({ projectId: project.id, category: "需求文档", title: "项目简报",
    summary: "目标、范围、约束与成功标准", status: "评审中", version: "v1", author: "designer",
    content: "目标：完成项目。范围：设计流程。约束：独立审计。成功标准：通过审批。" });
  store.insertDocumentReference({ projectId: project.id, documentId: document.id, targetType: "project",
    targetId: project.id, relationType: "defines" });
  complete(designer, { documentRevisionId: document.currentRevisionId });

  const firstAuditTask = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "audit_project_brief")!;
  expect(() => claimTaskPackage(store, { projectId: project.id, taskKey: firstAuditTask.taskKey,
    role: "auditor", agentId: firstAuditTask.assignee!.agentId,
    workerId: "brief-designer-worker", idempotencyKey: "self-audit" })).toThrow(/SELF_AUDIT_FORBIDDEN|producerWorkerId/);
  const auditor = claim("auditor", "brief-auditor-worker");
  expect(auditor.documents.some((item) => item.documentRevisionId === document.currentRevisionId)).toBe(true);
  const failed = store.insertEvidence({ projectId: project.id, nodeId: null, planItemId: null,
    sourceType: "manual", sourcePath: "", command: "review", resultStatus: "fail", summary: "简报缺少异常边界",
    details: { auditScope: "design" }, commitSha: "", digest: "", documentRevisionId: document.currentRevisionId,
    actorRole: "auditor", agentId: auditor.lease.agentId, collectedAt: new Date().toISOString() });
  complete(auditor, { evidenceId: failed.id, verdict: "fail", reworkConditions: "补充异常边界" });
  expect(listClaimableAgentTasks(store, project.id).some((item) => item.actionCode === "prepare_project_brief")).toBe(true);

  const rework = claim("designer", "brief-designer-rework-worker");
  const revised = store.updateDesignDoc(document.id, { content: `${document.content}\n异常边界：证据不足时不得批准。`, version: "v2" })!;
  complete(rework, { documentRevisionId: revised.currentRevisionId });
  const secondAuditor = claim("auditor", "brief-auditor-recheck-worker");
  const evidence = store.insertEvidence({ projectId: project.id, nodeId: null, planItemId: null,
    sourceType: "manual", sourcePath: "", command: "review", resultStatus: "pass", summary: "独立简报审计通过",
    details: { auditScope: "design" }, commitSha: "", digest: "", documentRevisionId: revised.currentRevisionId,
    actorRole: "auditor", agentId: secondAuditor.lease.agentId, collectedAt: new Date().toISOString() });
  complete(secondAuditor, { evidenceId: evidence.id, verdict: "pass" });

  const approvalTask = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "approve_project_brief")!;
  expect(() => claimTaskPackage(store, { projectId: project.id, taskKey: approvalTask.taskKey,
    role: "approver", agentId: "Main Agent", workerId: "brief-auditor-recheck-worker",
    idempotencyKey: "self-approval" })).toThrow(/Approver 身份必须不同/);
  const approver = claim("approver", "brief-main-worker");
  complete(approver, { verdict: "pass", resultDigest: "已复核独立审计和简报范围" });
  expect(store.getDesignDoc(document.id)?.status).toBe("已批准");
  expect(buildProjectWorkflow(store, project.id)?.nextAction?.code).toBe("add_function_node");
  expect(listClaimableAgentTasks(store, project.id).some((item) => item.actionCode.endsWith("project_brief"))).toBe(false);
});

it("lets an authenticated Main Agent dispatch the project-level design audit", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcs-project-brief-dispatch-"));
  const store = new Store(join(dir, "test.db"));
  resources.push({ store, dir });
  const project = store.insertProject({ code: "BRIEF-DISPATCH", name: "简报派发", summary: "目标与范围", stage: "探索",
    health: "正常", progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "",
    repositoryPath: "", startAt: "", dueAt: "" });
  syncManagedProject(store, dir, project);
  const designTask = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "prepare_project_brief")!;
  const design = JSON.parse(claimTaskPackage(store, { projectId: project.id, taskKey: designTask.taskKey,
    role: "designer", agentId: designTask.assignee!.agentId, workerId: "designer-process",
    idempotencyKey: "brief-dispatch-design" })) as { lease: { leaseToken: string; agentId: string; workerId: string;
      workOrderId: string; taskKey: string; taskRevision: string } };
  startAgentTask(store, { leaseToken: design.lease.leaseToken, agentId: design.lease.agentId, idempotencyKey: "brief-dispatch-start" });
  const document = store.insertDesignDoc({ projectId: project.id, category: "需求文档", title: "项目简报",
    summary: "范围", status: "评审中", version: "v1", author: "Designer", content: "目标、范围、约束、成功标准" });
  store.insertDocumentReference({ projectId: project.id, documentId: document.id, targetType: "project",
    targetId: project.id, relationType: "defines" });
  completeAgentTask(store, { leaseToken: design.lease.leaseToken, agentId: design.lease.agentId,
    workerId: design.lease.workerId, workOrderId: design.lease.workOrderId, taskKey: design.lease.taskKey,
    taskRevision: design.lease.taskRevision, role: "designer", documentRevisionId: document.currentRevisionId,
    idempotencyKey: "brief-dispatch-submit" });

  const credential = registerAgentCredential(store, { principalId: "test/main", agentId: "Main Agent",
    workerId: "brief-main-coordinator", allowedRoles: ["approver"], allowedProjects: [project.id] });
  const connectionId = "test/brief-main-coordinator";
  const challenge = beginAgentAuth(store, credential.credentialId, connectionId);
  const timestamp = new Date().toISOString();
  const protocolVersion = "2025-06-18";
  const authSessionToken = completeAgentAuth(store, { challengeId: challenge.challengeId,
    challenge: challenge.challenge, connectionId, timestamp, protocolVersion,
    response: expectedChallengeResponse(credential.credentialSecret, challenge.challenge, connectionId,
      credential.credentialId, timestamp, protocolVersion) }).authSessionToken;
  const auditTask = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "audit_project_brief")!;
  const parent = claimCoordinationLease(store, { projectId: project.id, taskKey: auditTask.taskKey,
    taskRevision: auditTask.taskRevision, mainAgentId: "Main Agent", workerId: "brief-main-coordinator",
    authSessionToken, idempotencyKey: "brief-audit-parent" });
  expect(parent.stage).toBe("design_audit");
  const dispatch = dispatchChildTask(store, { projectId: project.id, coordinationLeaseId: parent.id,
    leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: auditTask.id,
    taskKey: auditTask.taskKey, role: "auditor", workerId: "brief-audit-child" });
  const child = JSON.parse(claimDispatchedChildTask(store, { projectId: project.id, dispatchId: dispatch.dispatchId,
    agentId: dispatch.agentId, workerId: dispatch.workerId, idempotencyKey: "brief-audit-child-claim" })) as {
    task: { actionCode: string }; lease: { workerId: string } };
  expect(child.task.actionCode).toBe("audit_project_brief");
  expect(child.lease.workerId).toBe("brief-audit-child");
  releaseCoordinationLease(store, { projectId: project.id, coordinationLeaseId: parent.id,
    leaseToken: parent.leaseToken, mainAgentId: "Main Agent" });
});
