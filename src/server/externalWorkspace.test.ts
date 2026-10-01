import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { ensureAgentTaskLeaseSchema, claimAgentTask, listClaimableAgentTasks, startAgentTask, heartbeatAgentTask } from "./agentTaskLeases.js";
import { claimTaskPackage } from "./claimTaskPackage.js";
import * as orchestration from "./orchestration.js";
import { beginAgentAuth, completeAgentAuth, expectedChallengeResponse, registerAgentCredential, revokeAgentCredential } from "./agentSecurity.js";
import { claimCoordinationLease, dispatchChildTask, claimDispatchedChildTask } from "./coordinationLeases.js";
const resources: Array<{ store: Store; dir: string }> = [];
const assignments = {
  designer: { agentId: "designer-id", displayName: "Designer" },
  builder: { agentId: "builder-id", displayName: "Builder" },
  auditor: { agentId: "auditor-id", displayName: "Auditor" },
};
afterEach(() => { vi.restoreAllMocks(); for (const {store,dir} of resources.splice(0)) { store.close(); rmSync(dir,{recursive:true,force:true}); } });
function fixture(): { store: Store; projectId: string; planIds: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "pcs-agent-lease-"));
  const store = new Store(join(dir, "test.db"));
  resources.push({ store, dir });
  const project = store.insertProject({
    code: "LEASE", name: "租约测试", summary: "防止重复施工", stage: "开发", health: "正常",
    progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", externalRepositoryId: "example/repo",
    startAt: "", dueAt: "",
  });
  const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
  const nodes = ["lease-a", "lease-b"].map((id, index) => ({
    id, kind: "feature" as const, label: `施工任务 ${index + 1}`, description: "租约测试", owner: "team",
    acceptanceCriteria: "同一任务只有一个活跃租约", requirementStatus: "已批准" as const,
    designStatus: "已批准" as const, developmentStatus: "未开发" as const,
    acceptanceStatus: "未验收" as const, x: 600 + index * 260, y: 160,
  }));
  store.updateDiagram(main.id, { nodes: [...main.nodes, ...nodes] });
  const planIds = nodes.map((node, index) => store.insertPlan({
    projectId: project.id, diagramId: main.id, diagramNodeId: node.id, parentId: null,
    kind: "task", title: `实现租约 ${index + 1}`, description: "", status: "未开始",
    priority: index === 0 ? "P0" : "P1", progress: 0, owner: "Builder", versionTag: "v1",
    startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "",
    lifecycleStatus: "approved", proposedBy: "Designer", submittedAt: "2026-08-30T01:00:00.000Z",
    approvedBy: "Manager", approvedAt: "2026-08-30T01:05:00.000Z", roleAssignments: {
      ...assignments,
      builder: { agentId: "builder-id", displayName: "Builder Pool", poolId: "pool-builders" },
    },
  }).id);
  return { store, projectId: project.id, planIds };
}


function auth(store: Store, projectId: string, workerId = "remote-worker", agentId = "builder-id", role: "builder" | "approver" = "builder") {
  const credential = registerAgentCredential(store, { principalId: `test/${workerId}`, agentId, workerId,
    allowedRoles: [role], allowedProjects: [projectId] });
  const login = () => {
    const connectionId = `test/${workerId}`;
    const challenge = beginAgentAuth(store, credential.credentialId, connectionId);
    const timestamp = new Date().toISOString(), protocolVersion = "2025-06-18";
    return completeAgentAuth(store, { challengeId: challenge.challengeId, challenge: challenge.challenge,
      connectionId, timestamp, protocolVersion, response: expectedChallengeResponse(credential.credentialSecret,
        challenge.challenge, connectionId, credential.credentialId, timestamp, protocolVersion) }).authSessionToken;
  };
  return { token: login(), login, credentialId: credential.credentialId };
}
const binding = { repositoryId: "example/repo", workspaceId: "machine/worktree-1",
  workspacePath: "/external-only/not-on-service/worktree", workspaceBranch: "feature/work", baselineRevision: "a".repeat(40) };
function setup() {
  const f = fixture(); ensureAgentTaskLeaseSchema(f.store); const identity = auth(f.store, f.projectId);
  const input = { projectId: f.projectId, role: "builder" as const, agentId: "builder-id", workerId: "remote-worker",
    taskId: `development:${f.planIds[0]}`, externalWorkspace: binding, authSessionToken: identity.token, idempotencyKey: "remote-claim" };
  return { ...f, identity, input };
}
function state(store: Store) { return ["agent_task_leases","agent_task_workspace_reservations","agent_task_resource_locks","agent_runner_registrations"]
  .map(table => store.db.prepare(`SELECT count(*) n FROM ${table}`).get()); }
describe("external harness workspace binding", () => {
  it("claims without service source/Git and freezes runner-attested workspace in package", () => {
    const f=setup(); expect(existsSync(binding.workspacePath)).toBe(false);
    const pkg=JSON.parse(claimTaskPackage(f.store,f.input));
    expect(pkg.project.id).toBe(f.projectId); expect(pkg.project.repositoryPath).toBe("");
    expect(pkg.lease.externalWorkspace).toEqual(binding);
    expect(pkg.workingDirectory).toMatchObject({ready:true,exists:false,directory:false,location:"external",verification:"runner-attestation"});
    expect(pkg.launch).toMatchObject({executionOwner:"external-harness",sourceVerification:"runner-attestation"});
    const running=startAgentTask(f.store,{leaseToken:pkg.lease.leaseToken,agentId:f.input.agentId,idempotencyKey:"start"});
    expect(running).toMatchObject({status:"running",baselineRevision:binding.baselineRevision,workspacePath:binding.workspacePath});
    expect(JSON.parse(claimTaskPackage(f.store,{...f.input,authSessionToken:f.identity.login()})).lease.status).toBe("running");
    const cached=JSON.stringify(f.store.db.prepare("SELECT * FROM agent_task_lease_idempotency").all());
    expect(cached).not.toContain(f.identity.token);
  });
  it("rejects unauthenticated, spoofed and wrong-role/project claims without mutations", () => {
    const f=setup(); const before=state(f.store);
    for (const patch of [{authSessionToken:undefined},{workerId:"imposter"},{agentId:"imposter"},{role:"auditor" as const}])
      expect(()=>claimTaskPackage(f.store,{...f.input,...patch})).toThrow();
    expect(()=>claimTaskPackage(f.store,{...f.input,projectId:"not-created"})).toThrow();
    expect(state(f.store)).toEqual(before);
  });
  it("requires valid external binding and rejects wrong repository with no orphaned lease", () => {
    const f=setup(); const before=state(f.store);
    for (const externalWorkspace of [undefined,{...binding,repositoryId:"other"},{...binding,baselineRevision:"HEAD"},{...binding,workspacePath:"relative"}])
      expect(()=>claimTaskPackage(f.store,{...f.input,externalWorkspace})).toThrow();
    expect(state(f.store)).toEqual(before);
  });
  it("cannot change frozen binding on claim replay, start, repeated start or heartbeat", () => {
    const f=setup(); const lease=claimAgentTask(f.store,f.input);
    expect(()=>claimAgentTask(f.store,{...f.input,externalWorkspace:{...binding,workspaceId:"other"}})).toThrow();
    for (const patch of [{workspacePath:"/elsewhere"},{workspaceBranch:"other"},{baselineRevision:"b".repeat(40)}])
      expect(()=>startAgentTask(f.store,{leaseToken:lease.leaseToken,agentId:lease.agentId,idempotencyKey:JSON.stringify(patch),...patch})).toThrow(expect.objectContaining({code:"EXTERNAL_WORKSPACE_IMMUTABLE"}));
    startAgentTask(f.store,{leaseToken:lease.leaseToken,agentId:lease.agentId,idempotencyKey:"start"});
    expect(()=>startAgentTask(f.store,{leaseToken:lease.leaseToken,agentId:lease.agentId,idempotencyKey:"start-again",baselineRevision:"b".repeat(40)})).toThrow();
    expect(()=>heartbeatAgentTask(f.store,{leaseToken:lease.leaseToken,agentId:lease.agentId,idempotencyKey:"heartbeat",...{workspacePath:"/elsewhere"}})).toThrow();
  });
  it("authenticates replays after credential revocation", () => {
    const f=setup(); claimTaskPackage(f.store,f.input); revokeAgentCredential(f.store,f.identity.credentialId);
    expect(()=>claimTaskPackage(f.store,f.input)).toThrow();
  });
  it("prevents concurrent workspace reuse, while distinct isolated workspaces can claim", () => {
    const f=setup(); claimTaskPackage(f.store,f.input);
    const second=auth(f.store,f.projectId,"other-worker");
    const input={...f.input,taskId:`development:${f.planIds[1]}`,workerId:"other-worker",authSessionToken:second.token,idempotencyKey:"second"};
    const before=state(f.store);
    expect(()=>claimTaskPackage(f.store,input)).toThrow(expect.objectContaining({code:"WORKSPACE_ALREADY_RESERVED"}));
    expect(state(f.store)).toEqual(before);
    const secondPackage=JSON.parse(claimTaskPackage(f.store,{...input,externalWorkspace:{...binding,workspaceId:"other-machine/worktree-2"}}));
    expect(secondPackage.lease.workerId).toBe("other-worker");
    expect(startAgentTask(f.store,{leaseToken:secondPackage.lease.leaseToken,agentId:input.agentId,idempotencyKey:"second-start"}).status).toBe("running");
  });
  it("rolls back lease/binding/reservations if package serialization fails", () => {
    const f=setup();const before=state(f.store);const build=orchestration.buildAgentTaskPackage;
    vi.spyOn(orchestration,"buildAgentTaskPackage").mockImplementationOnce((...args)=> { const p=build(...args);Object.defineProperty(p,"toJSON",{value:()=>{throw Error("serialize");}});return p; });
    expect(()=>claimTaskPackage(f.store,f.input)).toThrow("serialize");expect(state(f.store)).toEqual(before);
    expect(JSON.parse(claimTaskPackage(f.store,f.input)).lease.externalWorkspace).toEqual(binding);
  });
  it("keeps local mode filesystem validation", () => {
    const f=fixture();f.store.updateProject(f.projectId,{externalRepositoryId:"",repositoryPath:"/missing-service-source"});
    expect(()=>claimTaskPackage(f.store,{projectId:f.projectId,role:"builder",agentId:"builder-id",workerId:"local",taskId:`development:${f.planIds[0]}`,idempotencyKey:"local"})).toThrow(expect.objectContaining({code:"WORKING_DIRECTORY_NOT_READY"}));
  });
  it("external repair stays fail-closed instead of trusting a declared HEAD", () => {
    const f=setup(); const snapshot=orchestration.buildAgentOrchestration(f.store,f.projectId)!;
    const task=snapshot.queues.development.find(t=>t.id===f.input.taskId)!;
    task.actionCode="submit_evidence_repair";
    expect(()=>claimAgentTask(f.store,f.input,{},snapshot)).toThrow(expect.objectContaining({code:"EXTERNAL_REPAIR_VERIFIER_REQUIRED"}));
    expect(f.store.db.prepare("SELECT count(*) n FROM agent_task_leases").get()).toEqual({n:0});
  });
  it("dispatched external children authenticate, freeze replay, and roll back package failure", () => {
    const f=setup(); const parentIdentity=auth(f.store,f.projectId,"main-worker","Main Agent","approver");
    const parent=claimCoordinationLease(f.store,{projectId:f.projectId,planId:f.planIds[0],mainAgentId:"Main Agent",workerId:"main-worker",authSessionToken:parentIdentity.token,idempotencyKey:"parent"});
    const task=listClaimableAgentTasks(f.store,f.projectId).find(t=>t.id===f.input.taskId)!;
    const dispatch=dispatchChildTask(f.store,{projectId:f.projectId,coordinationLeaseId:parent.id,leaseToken:parent.leaseToken,mainAgentId:"Main Agent",taskId:task.id,taskKey:task.taskKey,role:"builder",agentId:"builder-id",workerId:"remote-worker"});
    const input={...f.input,dispatchId:dispatch.dispatchId,idempotencyKey:"child"};
    expect(()=>claimDispatchedChildTask(f.store,{...input,authSessionToken:undefined})).toThrow(expect.objectContaining({code:"AUTH_REQUIRED"}));
    const before=state(f.store);const build=orchestration.buildAgentTaskPackage;
    vi.spyOn(orchestration,"buildAgentTaskPackage").mockImplementationOnce((...args)=>{ const p=build(...args);Object.defineProperty(p,"toJSON",{value:()=>{throw Error("serialize child");}});return p; });
    expect(()=>claimDispatchedChildTask(f.store,input)).toThrow("serialize child");expect(state(f.store)).toEqual(before);
    expect(f.store.db.prepare("SELECT status FROM agent_child_task_dispatches WHERE dispatch_id=?").get(dispatch.dispatchId)).toEqual({status:"dispatched"});
    const pkg=JSON.parse(claimDispatchedChildTask(f.store,input));expect(pkg.lease.externalWorkspace).toEqual(binding);
    expect(JSON.parse(claimDispatchedChildTask(f.store,{...input,authSessionToken:f.identity.login()})).lease.workOrderId).toBe(pkg.lease.workOrderId);
    expect(()=>claimDispatchedChildTask(f.store,{...input,externalWorkspace:{...binding,workspaceId:"other"}})).toThrow(expect.objectContaining({code:"EXTERNAL_WORKSPACE_IMMUTABLE"}));
    revokeAgentCredential(f.store,f.identity.credentialId);expect(()=>claimDispatchedChildTask(f.store,input)).toThrow();
  });

  it("persists the frozen workspace across a new service connection", () => {
    const f=setup();const first=JSON.parse(claimTaskPackage(f.store,f.input));
    const resource=resources.find(item=>item.store===f.store)!;
    const reopened=new Store(join(resource.dir,"test.db"));
    try {const replay=JSON.parse(claimTaskPackage(reopened,{...f.input,authSessionToken:f.identity.login()}));
      expect(replay.lease.workOrderId).toBe(first.lease.workOrderId);expect(replay.lease.externalWorkspace).toEqual(binding);
    } finally { reopened.close(); }
  });

  it("rejects expired authentication on claim replay before returning lease context", () => {
    const f=setup();claimTaskPackage(f.store,f.input);
    f.store.db.prepare("UPDATE agent_auth_sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();
    expect(()=>claimTaskPackage(f.store,f.input)).toThrow(expect.objectContaining({code:"AUTH_REQUIRED"}));
  });

  it("shares a workspace within one atomic approval group", () => {
    const f=setup();const identity=auth(f.store,f.projectId,"main-worker","Main Agent","approver");
    const snapshot=orchestration.buildAgentOrchestration(f.store,f.projectId)!;
    snapshot.queues.approval=snapshot.queues.development.map(t=>({...t,queue:"approval",id:`approval:${t.planItemId}`,actionCode:"request_design_change",correlationId:"design-gap:group",assignee:{agentId:"Main Agent",displayName:"Main Agent"}}));
    snapshot.queues.development=[];
    const input={...f.input,taskId:snapshot.queues.approval[0].id,role:"approver" as const,agentId:"Main Agent",workerId:"main-worker",authSessionToken:identity.token,idempotencyKey:"approval-group"};
    const lease=claimAgentTask(f.store,input,{},snapshot);
    expect(lease.approvalGroupId).toBeTruthy();
    expect(f.store.db.prepare("SELECT count(*) n FROM agent_task_leases WHERE approval_group_id=?").get(lease.approvalGroupId)).toEqual({n:2});
  });

});
