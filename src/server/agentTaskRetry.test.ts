import { LocalMcpClient } from "./localMcpClient.js";
import { createMcpServer } from "../mcp/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { buildApp } from "./index.js";
import { claimAgentTask, completeAgentTask, failAgentTask, getAgentTaskCapacity, listClaimableAgentTasks, updateAgentTaskCapacity } from "./agentTaskLeases.js";
import { agentTaskRetryApprovalDigest, listAgentTaskRetryCandidates, requestAgentTaskRetry } from "./agentTaskRetry.js";
import { AGENT_POLICY_VERSION, acknowledgeAgentPolicy, beginAgentAuth, completeAgentAuth, expectedChallengeResponse, issueOneTimeNonce, registerAgentCredential, resolveAuthPrincipal } from "./agentSecurity.js";
const resources: Array<{ store: Store; dir: string }> = [];
afterEach(() => { vi.useRealTimers(); for (const {store,dir} of resources.splice(0)) { store.close(); rmSync(dir,{recursive:true,force:true}); } });
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"pcs-retry-")); const dbPath=join(dir,"test.db"); const store=new Store(dbPath,dir); resources.push({store,dir});
  const project=store.insertProject({code:"RETRY",name:"Recovery fixture",summary:"Retry one exhausted task",stage:"设计",health:"正常",progress:0,riskLevel:"P1",riskSummary:"",blockerSummary:"",nextStep:"",repositoryPath:dir,startAt:"",dueAt:""});
  const doc=store.insertDesignDoc({projectId:project.id,category:"需求文档",title:"项目简报",summary:"",status:"已批准",version:"1",author:"manager",content:"Governed recovery"});
  store.insertDocumentReference({projectId:project.id,documentId:doc.id,targetType:"project",targetId:project.id,relationType:"defines"});
  const main=store.listDiagrams(project.id).find(d=>d.type==="main")!;
  store.updateDiagram(main.id,{nodes:[...main.nodes,...["retry-a","retry-b"].map((id,index)=>({id,kind:"feature" as const,label:id,description:"detail",owner:"designer",acceptanceCriteria:"approved plan",requirementStatus:"已批准" as const,designStatus:"进行中" as const,developmentStatus:"未开发" as const,acceptanceStatus:"未验收" as const,x:600+index*220,y:160}))]});
  updateAgentTaskCapacity(store,project.id,{maxAttempts:1,retryBackoffSeconds:1});
  const task=listClaimableAgentTasks(store,project.id).find(t=>t.nodeId==="retry-a")!;
  let counter=0;
  const claim=(key=task.taskKey, worker="design-worker")=>{const t=listClaimableAgentTasks(store,project.id).find(t=>t.taskKey===key)!;return claimAgentTask(store,{projectId:project.id,taskKey:key,role:t.requiredRole,agentId:t.assignee!.agentId,workerId:worker,idempotencyKey:`claim-${++counter}`});};
  const lease=claim(); failAgentTask(store,{leaseToken:lease.leaseToken,agentId:lease.agentId,error:"known failure",idempotencyKey:"fail-initial"});
  const request={projectId:project.id,taskKey:task.taskKey,taskRevision:task.taskRevision,failedWorkOrderId:lease.workOrderId,expectedAttempt:1,reason:"transient issue",remediation:"dependency restored",idempotencyKey:"retry-request"};
  const approve=()=>{const approval=listClaimableAgentTasks(store,project.id).find(t=>t.actionCode==="approve_agent_task_retry")!; const a=claim(approval.taskKey,"independent-main-worker");return completeAgentTask(store,{...a,idempotencyKey:`approve-${a.workOrderId}`,resultDigest:"Verified remediation and exact failed attempt"});};
  return {store,dir,dbPath,projectId:project.id,diagramId:main.id,task,lease,request,claim,approve};
}
function advanceBackoff() { vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(Date.now()+2000); }
describe("scoped exhausted retry recovery",()=>{
 it("requires independent approval and consumes one allowance atomically without resetting attempts or global caps",()=>{
  const f=fixture(); const before=getAgentTaskCapacity(f.store,f.projectId);
  expect(listAgentTaskRetryCandidates(f.store,f.projectId)).toHaveLength(1);
  const requested=requestAgentTaskRetry(f.store,f.request); expect(requested.authorizesRetry).toBe(false);
  expect(requestAgentTaskRetry(f.store,f.request)).toEqual(requested);
  expect(()=>f.claim()).toThrow("最大尝试次数");
  const approval=f.approve(); expect(approval.status).toBe("completed");
  expect(completeAgentTask(f.store,{...approval,status:"claimed",completedAt:"",updatedAt:approval.claimedAt,idempotencyKey:`approve-${approval.workOrderId}`,resultDigest:"Verified remediation and exact failed attempt"}).workOrderId).toBe(approval.workOrderId);
  expect(()=>f.claim()).toThrow("退避"); advanceBackoff();
  const retried=f.claim(); expect(retried.attempt).toBe(2); expect(retried.workOrderId).not.toBe(f.lease.workOrderId);
  expect(()=>f.claim()).toThrow("领取");
  failAgentTask(f.store,{...retried,error:"still failed",idempotencyKey:"fail-retry"}); advanceBackoff();
  expect(()=>f.claim()).toThrow("最大尝试次数"); expect(getAgentTaskCapacity(f.store,f.projectId)).toEqual(before);
  expect(requestAgentTaskRetry(f.store,f.request).authorizesRetry).toBe(false);
  const record=f.store.db.prepare("SELECT * FROM agent_task_retry_requests").get() as Record<string,unknown>;
  expect(record.consumed_work_order_id).toBe(retried.workOrderId); expect(String(record.failed_lease_json)).toContain("known failure"); expect(String(record.failed_lease_json)).not.toContain(f.lease.leaseToken);
 });
 it("rejects conflicts, cross-project, stale and nonfailed references",()=>{
  const f=fixture();
  for(const changed of [{projectId:"other"},{taskRevision:"stale"},{failedWorkOrderId:"old"},{expectedAttempt:2}]) expect(()=>requestAgentTaskRetry(f.store,{...f.request,...changed})).toThrow();
  requestAgentTaskRetry(f.store,f.request);
  expect(()=>requestAgentTaskRetry(f.store,{...f.request,remediation:"different"})).toThrow("幂等键");
  expect(()=>requestAgentTaskRetry(f.store,{...f.request,idempotencyKey:"duplicate"})).toThrow("待批准");
  const main=f.store.getDiagram(f.diagramId)!; f.store.updateDiagram(main.id,{nodes:main.nodes.map(n=>n.id==="retry-a"?{...n,description:"new task revision"}:n)});
  expect(listClaimableAgentTasks(f.store,f.projectId).some(t=>t.actionCode==="approve_agent_task_retry")).toBe(false);
  expect(()=>requestAgentTaskRetry(f.store,{...f.request,idempotencyKey:"stale"})).toThrow("当前修订");
 });
 it("rejects failed worker self-approval and exact-context mismatch",()=>{
  const f=fixture(); requestAgentTaskRetry(f.store,f.request);
  const approval=listClaimableAgentTasks(f.store,f.projectId).find(t=>t.actionCode==="approve_agent_task_retry")!;
  const a=f.claim(approval.taskKey,"design-worker");
  expect(()=>completeAgentTask(f.store,{...a,idempotencyKey:"self",resultDigest:"approve"})).toThrow("不得批准");
  expect(()=>completeAgentTask(f.store,{...a,workOrderId:f.lease.workOrderId,idempotencyKey:"bad-context",resultDigest:"approve"})).toThrow("精确匹配");
  expect(f.store.db.prepare("SELECT status FROM agent_task_retry_requests").get()).toEqual({status:"pending"});
 });
 it("preserves project and role capacity and allows a fresh request only for the next failed attempt",()=>{
  const f=fixture(); requestAgentTaskRetry(f.store,f.request); f.approve(); advanceBackoff();
  const b=listClaimableAgentTasks(f.store,f.projectId).find(t=>t.nodeId==="retry-b")!; const bLease=f.claim(b.taskKey,"other-worker");
  expect(()=>f.claim()).toThrow("并发已满");
  failAgentTask(f.store,{...bLease,idempotencyKey:"fail-b",error:"b failed"});
  const a=f.claim(); failAgentTask(f.store,{...a,idempotencyKey:"fail-a",error:"a failed again"});
  const fresh=requestAgentTaskRetry(f.store,{...f.request,failedWorkOrderId:a.workOrderId,expectedAttempt:2,idempotencyKey:"new-allowance"});
  expect(fresh.status).toBe("pending"); expect(f.store.db.prepare("SELECT COUNT(*) n FROM agent_task_retry_requests").get()).toEqual({n:2});
 });
 it("rejects active/completed targets and obsolete failed IDs after a new attempt",()=>{
  const f=fixture();
  for (const status of ["claimed","running","completed","released"]) {
    f.store.db.prepare("UPDATE agent_task_leases SET status=? WHERE id=?").run(status,f.lease.workOrderId);
    expect(listAgentTaskRetryCandidates(f.store,f.projectId)).toEqual([]);
    expect(()=>requestAgentTaskRetry(f.store,f.request)).toThrow();
  }
  f.store.db.prepare("UPDATE agent_task_leases SET status='failed' WHERE id=?").run(f.lease.workOrderId);
  requestAgentTaskRetry(f.store,f.request); f.approve(); advanceBackoff(); const retried=f.claim();
  failAgentTask(f.store,{...retried,idempotencyKey:"new-fail",error:"again"});
  expect(()=>requestAgentTaskRetry(f.store,{...f.request,idempotencyKey:"old-failure"})).toThrow("当前修订");
 });
 it("rejects expired approvals and stale target revisions without granting an allowance",()=>{
  const f=fixture();requestAgentTaskRetry(f.store,f.request);
  const t=listClaimableAgentTasks(f.store,f.projectId).find(t=>t.actionCode==="approve_agent_task_retry")!;
  const a=f.claim(t.taskKey,"main-worker");
  const main=f.store.getDiagram(f.diagramId)!;
  f.store.updateDiagram(main.id,{nodes:main.nodes.map(n=>n.id==="retry-a"?{...n,description:"changed"}:n)});
  expect(()=>completeAgentTask(f.store,{...a,idempotencyKey:"stale-complete",resultDigest:"approve"})).toThrow("修订已变化");
  f.store.db.prepare("UPDATE agent_task_leases SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(a.workOrderId);
  expect(()=>completeAgentTask(f.store,{...a,idempotencyKey:"expired-complete",resultDigest:"approve"})).toThrow();
  expect(f.store.db.prepare("SELECT status,consumed_work_order_id FROM agent_task_retry_requests").get()).toEqual({status:"pending",consumed_work_order_id:""});
 });
 it("persists approved allowance across restart and never transfers it to a newer revision",()=>{
  const f=fixture();requestAgentTaskRetry(f.store,f.request);f.approve();advanceBackoff();
  const reopened=new Store(f.dbPath,f.dir);
  try { expect(listClaimableAgentTasks(reopened,f.projectId).find(t=>t.taskKey===f.task.taskKey)?.available).toBe(true); }
  finally { reopened.close(); }
  const main=f.store.getDiagram(f.diagramId)!;f.store.updateDiagram(main.id,{nodes:main.nodes.map(n=>n.id==="retry-a"?{...n,description:"new revision"}:n)});
  expect(requestAgentTaskRetry(f.store,f.request).authorizesRetry).toBe(false);
  const current=listClaimableAgentTasks(f.store,f.projectId).find(t=>t.nodeId==="retry-a")!;
  expect(current.taskKey).not.toBe(f.task.taskKey);expect(current.attempt).toBe(0);
 });
 it("requires registered approval identity, matching canonical nonce and policy through real REST",async()=>{
  const f=fixture();requestAgentTaskRetry(f.store,f.request);
  const task=listClaimableAgentTasks(f.store,f.projectId).find(t=>t.actionCode==="approve_agent_task_retry")!;
  const a=f.claim(task.taskKey,"authenticated-main");
  const credential=registerAgentCredential(f.store,{principalId:"test/main",agentId:a.agentId,workerId:a.workerId,allowedRoles:["approver"],allowedProjects:[f.projectId]});
  const connectionId="test/retry-main-connection";
  const challenge=beginAgentAuth(f.store,credential.credentialId,connectionId);const timestamp=new Date().toISOString();const protocolVersion="2025-06-18";
  const authSessionToken=completeAgentAuth(f.store,{challengeId:challenge.challengeId,challenge:challenge.challenge,connectionId,timestamp,protocolVersion,
    response:expectedChallengeResponse(credential.credentialSecret,challenge.challenge,connectionId,credential.credentialId,timestamp,protocolVersion)}).authSessionToken;
  const policyAckToken=acknowledgeAgentPolicy(f.store,resolveAuthPrincipal(f.store,authSessionToken),{role:"approver",projectId:f.projectId,policyVersion:AGENT_POLICY_VERSION}).policyAckToken;
  const payload={workOrderId:a.workOrderId,leaseToken:a.leaseToken,taskKey:a.taskKey,taskRevision:a.taskRevision,workerId:a.workerId,agentId:a.agentId,role:a.role,
    idempotencyKey:"secure-complete",resultDigest:"independently verified",authSessionToken,policyAckToken};
  const nonce=issueOneTimeNonce(f.store,{policyAckToken,workOrderId:a.workOrderId,action:"rest.complete_agent_task",target:"rest:/api/agent-task-leases/complete",bodyDigest:agentTaskRetryApprovalDigest(payload)});
  const app=buildApp({dbPath:f.dbPath,dataDir:f.dir});await app.ready();
  try {
    expect((await app.inject({method:"POST",url:"/api/agent-task-leases/complete",payload})).statusCode).toBe(409);
    const changed=await app.inject({method:"POST",url:"/api/agent-task-leases/complete",payload:{...payload,nonceId:nonce.nonceId,resultDigest:"changed"}});
    expect(changed.statusCode,changed.body).toBe(409);expect(changed.json().code).toBe("TOKEN_REPLAYED");
    const approved=await app.inject({method:"POST",url:"/api/agent-task-leases/complete",payload:{...payload,nonceId:nonce.nonceId}});
    expect(approved.statusCode,approved.body).toBe(200);expect(approved.json().status).toBe("completed");
    expect((f.store.db.prepare("SELECT consumed_at FROM one_time_nonces WHERE nonce_id=?").get(nonce.nonceId) as {consumed_at:string}).consumed_at).not.toBe("");
  } finally {await app.close();}
 });
 it("uses the external MCP completion tool and prevents repurposing the recovery lease",async()=>{
  const f=fixture();requestAgentTaskRetry(f.store,f.request);
  const task=listClaimableAgentTasks(f.store,f.projectId).find(t=>t.actionCode==="approve_agent_task_retry")!;
  const a=f.claim(task.taskKey,"mcp-main");
  const client=await LocalMcpClient.connect(()=>createMcpServer({store:f.store,dbPath:f.dbPath,dataDir:f.dir}));
  const context={workOrderId:a.workOrderId,leaseToken:a.leaseToken,taskKey:a.taskKey,taskRevision:a.taskRevision,workerId:a.workerId,agentId:a.agentId,role:a.role,idempotencyKey:"mcp-approval"};
  try {
    const blocked=await client.callTool("update_agent_task_capacity",{...context,projectRef:f.projectId,maxAttempts:100});
    expect(blocked.isError).toBe(true);expect(blocked.content?.[0].text).toContain("ACTION_MISMATCH");
    const approved=await client.callTool("complete_agent_task",{...context,resultDigest:"verified exact recovery"});
    expect(approved.isError,JSON.stringify(approved)).not.toBe(true);
    expect(requestAgentTaskRetry(f.store,f.request).authorizesRetry).toBe(true);
    expect(getAgentTaskCapacity(f.store,f.projectId).maxAttempts).toBe(1);
  } finally {await client.close();}
 });
 it("injects canonical retry approval proof for the host-authorized local Main Agent",async()=>{
  const f=fixture();requestAgentTaskRetry(f.store,f.request);
  const task=listClaimableAgentTasks(f.store,f.projectId).find(t=>t.actionCode==="approve_agent_task_retry")!;
  const a=f.claim(task.taskKey,"local-main");
  const client=await LocalMcpClient.connect(()=>createMcpServer({store:f.store,dbPath:f.dbPath,dataDir:f.dir,
    localAuthorization:{projectRef:f.projectId,workerId:"local-main"}}));
  try {
    const approved=await client.callTool("complete_agent_task",{workOrderId:a.workOrderId,leaseToken:a.leaseToken,
      taskKey:a.taskKey,taskRevision:a.taskRevision,workerId:a.workerId,agentId:a.agentId,role:a.role,
      idempotencyKey:"local-complete",resultDigest:"verified with local host identity"});
    expect(approved.isError,JSON.stringify(approved)).not.toBe(true);
    expect(requestAgentTaskRetry(f.store,f.request).authorizesRetry).toBe(true);
  } finally {await client.close();}
 });
 it("serves real REST candidate/request routes and approves only through an exact approval work order",async()=>{
  const f=fixture(); const app=buildApp({dbPath:f.dbPath,dataDir:f.dir,trustedInternalApi:true}); await app.ready();
  try {
   const url=`/api/projects/${f.projectId}`;
   const candidates=await app.inject({method:"GET",url:`${url}/agent-task-retry-candidates`}); expect(candidates.statusCode).toBe(200); expect(candidates.json()[0].failedWorkOrderId).toBe(f.lease.workOrderId);
   const {projectId:_project,...payload}=f.request;
   const post=await app.inject({method:"POST",url:`${url}/agent-task-retry-requests`,payload}); expect(post.statusCode,post.body).toBe(200); expect(post.json().authorizesRetry).toBe(false);
   expect((await app.inject({method:"POST",url:`${url}/agent-task-retry-requests`,payload})).json()).toEqual(post.json());
   expect((await app.inject({method:"POST",url:`${url}/agent-task-retry-requests`,payload:{...payload,reason:"changed"}})).statusCode).toBe(409);
   const approval=listClaimableAgentTasks(f.store,f.projectId).find(t=>t.actionCode==="approve_agent_task_retry")!; const a=f.claim(approval.taskKey,"rest-main");
   const completed=await app.inject({method:"POST",url:"/api/agent-task-leases/complete",payload:{...a,idempotencyKey:"rest-approve",resultDigest:"verified"}}); expect(completed.statusCode,completed.body).toBe(200);
   expect((await app.inject({method:"GET",url:`${url}/agent-task-retry-candidates`})).json()).toEqual([]);
  } finally { await app.close(); }
 });
});
