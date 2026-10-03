import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {afterEach,describe,expect,it} from 'vitest';
import {Store} from './db.js';
import {beginAgentAuth,completeAgentAuth,expectedChallengeResponse,registerAgentCredential,revokeAgentCredential} from './agentSecurity.js';
import {claimAgentTask,listClaimableAgentTasks,startAgentTask,heartbeatAgentTask,updateAgentTaskCapacity} from './agentTaskLeases.js';
import {claimCoordinationLease,claimDispatchedChildTask,dispatchChildTask,listCoordinationLeases,listChildTaskDispatches,ensureCoordinationLeaseSchema,heartbeatCoordinationLease,pauseCoordinationLease,resumeCoordinationLease,releaseCoordinationLease,assertCoordinationLeaseForPlan} from './coordinationLeases.js';
import type {AgentCoordinationLease} from '../shared/types.js';
const fixtures:Array<{store:Store;dir:string}>=[];
afterEach(()=>{for(const f of fixtures.splice(0)){f.store.close();rmSync(f.dir,{recursive:true,force:true});}});
function fixture(shared=false){
 const dir=mkdtempSync(join(tmpdir(),'parallel-coordination-')),dbPath=join(dir,'test.db'),store=new Store(dbPath);fixtures.push({store,dir});
 // Explicit synthetic regression setup, not evidence of business approval gates.
 const project=store.insertProject({code:'PARALLEL',name:'Plan coordinator fixture',summary:'',stage:'设计',health:'正常',progress:0,riskLevel:'P1',riskSummary:'',blockerSummary:'',nextStep:'',repositoryPath:dir,startAt:'',dueAt:''});
 const diagram=store.listDiagrams(project.id).find(d=>d.type==='main')!;
 store.updateDiagram(diagram.id,{nodes:[...diagram.nodes,...['a','b','unplanned'].map(id=>({id,kind:'feature' as const,label:id,description:'',owner:'team',acceptanceCriteria:'Complete bounded design',requirementStatus:'已批准' as const,designStatus:'进行中' as const,developmentStatus:'未开发' as const,acceptanceStatus:'未验收' as const,x:400,y:200}))]});
 const plans=['a','b'].map((id,i)=>store.insertPlan({projectId:project.id,diagramId:diagram.id,diagramNodeId:shared?'a':id,parentId:null,kind:'task',title:id,description:'',status:'未开始',priority:'P1',progress:0,owner:'designer',versionTag:'',startAt:'',dueAt:'',dependencyIds:[],lifecycleStatus:'draft',roleAssignments:{designer:{agentId:'designer',displayName:'Designer'},builder:{agentId:'builder',displayName:'Builder'},auditor:{agentId:'auditor',displayName:'Auditor'}}}));
 updateAgentTaskCapacity(store,project.id,{maxActive:8,designerMaxActive:5});
 const identity=(worker:string,roles:('approver'|'builder')[]=['approver'],projects=[project.id])=>{
  const credential=registerAgentCredential(store,{principalId:'fixture/'+worker,agentId:'Main Agent',workerId:worker,allowedRoles:roles,allowedProjects:projects});const connectionId='parallel-fixture/'+worker;const ch=beginAgentAuth(store,credential.credentialId,connectionId);const timestamp=new Date().toISOString(),protocolVersion='2025-06-18';const auth=completeAgentAuth(store,{challengeId:ch.challengeId,challenge:ch.challenge,connectionId,timestamp,protocolVersion,response:expectedChallengeResponse(credential.credentialSecret,ch.challenge,connectionId,credential.credentialId,timestamp,protocolVersion)});return {...credential,...auth};
 };
 const auths=[identity('main-a'),identity('main-b')];
 const input=(i:number)=>({projectId:project.id,planId:plans[i].id,mainAgentId:'Main Agent',workerId:auths[i].workerId,authSessionToken:auths[i].authSessionToken,idempotencyKey:'parent-'+i});
 const task=(i:number)=>listClaimableAgentTasks(store,project.id).find(t=>t.planItemId===plans[i].id&&t.queue==='design')!;
 const noPlan=()=>listClaimableAgentTasks(store,project.id).find(t=>t.nodeId==='unplanned'&&!t.planItemId&&t.queue==='design')!;
 const control=(p:AgentCoordinationLease)=>({projectId:project.id,coordinationLeaseId:p.id,leaseToken:p.leaseToken,mainAgentId:'Main Agent'});
 const dispatch=(p:AgentCoordinationLease,i:number)=>dispatchChildTask(store,{...control(p),taskId:task(i).id,taskKey:task(i).taskKey,role:'designer',workerId:'child-'+i,idempotencyKey:'dispatch-'+i});
 const child=(d:ReturnType<typeof dispatch>)=>JSON.parse(claimDispatchedChildTask(store,{projectId:project.id,dispatchId:d.dispatchId,agentId:d.agentId,workerId:d.workerId,idempotencyKey:'child-'+d.dispatchId}));
 return {store,dir,dbPath,project,plans,auths,identity,input,task,noPlan,control,dispatch,child};
}
function context(packet:any){const l=packet.lease;return {workOrderId:l.workOrderId,leaseToken:l.leaseToken,taskKey:l.taskKey,taskRevision:l.taskRevision,workerId:l.workerId,agentId:l.agentId,role:'designer' as const};}
describe('exact-plan concurrent coordination',()=>{
 it('allows two independent parents and children, retaining exact-plan authority and duplicate conflicts',()=>{
  const f=fixture(),a=claimCoordinationLease(f.store,f.input(0)),b=claimCoordinationLease(f.store,f.input(1));expect(a.id).not.toBe(b.id);
  expect(listCoordinationLeases(f.store,f.project.id).filter(p=>p.status==='active')).toHaveLength(2);
  expect(()=>dispatchChildTask(f.store,{...f.control(a),taskId:f.task(1).id,role:'designer'})).toThrow(expect.objectContaining({code:'COORDINATION_PLAN_MISMATCH'}));
  expect(()=>assertCoordinationLeaseForPlan(f.store,{...f.control(a),planId:f.plans[1].id,coordinationLeaseToken:a.leaseToken})).toThrow(expect.objectContaining({code:'COORDINATION_PLAN_MISMATCH'}));
  const third=f.identity('main-third');expect(()=>claimCoordinationLease(f.store,{...f.input(1),planId:f.plans[0].id,workerId:third.workerId,authSessionToken:third.authSessionToken,idempotencyKey:'duplicate-plan'})).toThrow(expect.objectContaining({code:'COORDINATION_LEASE_BUSY'}));
  expect(()=>claimCoordinationLease(f.store,{...f.input(0),planId:f.plans[1].id,idempotencyKey:'same-worker'})).toThrow(expect.objectContaining({code:'COORDINATION_TARGET_MISMATCH'}));
  for(const [i,p]of [a,b].entries()){const d=f.dispatch(p,i),c=f.child(d);expect(listChildTaskDispatches(f.store,f.project.id,p.id)[0].childWorkOrderId).toBe(c.lease.workOrderId);expect(startAgentTask(f.store,{...context(c),idempotencyKey:'start-'+i})).toMatchObject({status:'running'});}
  expect(listChildTaskDispatches(f.store,f.project.id)).toHaveLength(2);
 });
 it('scopes direct worker blocking to the matching plan and conservatively blocks no-plan tasks',()=>{
  const f=fixture();claimCoordinationLease(f.store,f.input(0));
  const direct=(task:ReturnType<typeof f.task>,worker:string)=>claimAgentTask(f.store,{projectId:f.project.id,taskKey:task.taskKey,agentId:task.assignee!.agentId,workerId:worker,role:'designer',idempotencyKey:worker});
  expect(()=>direct(f.task(0),'direct-a')).toThrow(expect.objectContaining({code:'COORDINATION_DISPATCH_REQUIRED'}));
  expect(direct(f.task(1),'direct-b')).toMatchObject({status:'claimed'});
  expect(()=>direct(f.noPlan(),'direct-unplanned')).toThrow(expect.objectContaining({code:'COORDINATION_DISPATCH_REQUIRED'}));
 });
 it.each(['cancel','pause','revoke'] as const)('%s affects only its own independently credentialed parent and descendants',operation=>{
  const f=fixture(),a=claimCoordinationLease(f.store,f.input(0)),b=claimCoordinationLease(f.store,f.input(1)),da=f.dispatch(a,0),db=f.dispatch(b,1),ca=f.child(da),cb=f.child(db);
  startAgentTask(f.store,{...context(ca),idempotencyKey:'start-a'});startAgentTask(f.store,{...context(cb),idempotencyKey:'start-b'});
  if(operation==='cancel')releaseCoordinationLease(f.store,f.control(a));else if(operation==='pause')pauseCoordinationLease(f.store,f.control(a));else revokeAgentCredential(f.store,f.auths[0].credentialId);
  expect(heartbeatCoordinationLease(f.store,f.control(b))).toMatchObject({id:b.id,status:'active'});
  expect(heartbeatAgentTask(f.store,{...context(cb),idempotencyKey:'b-still-running'})).toMatchObject({status:'running'});
  expect(f.dispatch(b,1).dispatchId).toBe(db.dispatchId);
  expect(f.store.db.prepare('SELECT status FROM agent_runner_registrations WHERE project_id=? AND worker_id=?').get(f.project.id,f.auths[1].workerId)).toEqual({status:'online'});
  expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM agent_task_resource_locks WHERE lease_token=?').get(cb.lease.leaseToken)).toEqual({count:1});
  if(operation==='pause'){expect(listCoordinationLeases(f.store,f.project.id).find(p=>p.id===a.id)?.status).toBe('paused');resumeCoordinationLease(f.store,f.control(a));}
  else expect(()=>f.child(da)).toThrow(expect.objectContaining({code:'DISPATCH_LOST'}));
 });
 it.each(['direct','dispatched','paused'] as const)('reserves coordinator worker against %s child claims without altering peer runner',mode=>{
  const f=fixture(),a=claimCoordinationLease(f.store,f.input(0));
  if(mode==='paused')pauseCoordinationLease(f.store,f.control(a));
  const before=f.store.db.prepare('SELECT * FROM agent_runner_registrations WHERE project_id=? AND worker_id=?').get(f.project.id,f.auths[0].workerId);
  if(mode==='dispatched'){
   const b=claimCoordinationLease(f.store,f.input(1));const d=dispatchChildTask(f.store,{...f.control(b),taskId:f.task(1).id,role:'designer',workerId:'MAIN-A'});
   expect(()=>f.child(d)).toThrow(expect.objectContaining({code:'COORDINATION_RUNNER_BUSY'}));
  }else expect(()=>claimAgentTask(f.store,{projectId:f.project.id,taskKey:f.task(1).taskKey,agentId:'designer',workerId:' MAIN-A ',role:'designer',idempotencyKey:'reuse-parent-worker'})).toThrow(expect.objectContaining({code:'COORDINATION_RUNNER_BUSY'}));
  expect(f.store.db.prepare('SELECT * FROM agent_runner_registrations WHERE project_id=? AND worker_id=?').get(f.project.id,f.auths[0].workerId)).toEqual(before);
  expect(listCoordinationLeases(f.store,f.project.id).find(p=>p.id===a.id)?.status).toBe(mode==='paused'?'paused':'active');
 });
 it('preserves own-plan Main Agent approval but rejects its worker on an unrelated approval',()=>{
  const f=fixture();for(const plan of f.plans)f.store.updatePlan(plan.id,{lifecycleStatus:'pending_approval',auditStatus:'passed'});claimCoordinationLease(f.store,f.input(0));
  const approval=(i:number)=>listClaimableAgentTasks(f.store,f.project.id).find(t=>t.planItemId===f.plans[i].id&&t.requiredRole==='approver')!;
  expect(approval(0)).toBeDefined();
  const input=(i:number)=>({projectId:f.project.id,taskKey:approval(i).taskKey,role:'approver' as const,agentId:'Main Agent',workerId:f.auths[0].workerId,idempotencyKey:'approval-'+i});
  expect(()=>claimAgentTask(f.store,input(1))).toThrow(expect.objectContaining({code:'COORDINATION_RUNNER_BUSY'}));
  expect(claimAgentTask(f.store,input(0))).toMatchObject({status:'claimed'});
 });
 it('retains paused-target exclusivity and project repository freeze with a live peer',()=>{
  const f=fixture(),a=claimCoordinationLease(f.store,f.input(0)),b=claimCoordinationLease(f.store,f.input(1));pauseCoordinationLease(f.store,f.control(a));const third=f.identity('third-parent');
  expect(()=>claimCoordinationLease(f.store,{...f.input(0),workerId:third.workerId,authSessionToken:third.authSessionToken,idempotencyKey:'paused-duplicate'})).toThrow(expect.objectContaining({code:'COORDINATION_LEASE_BUSY'}));
  const t=f.noPlan();expect(()=>claimCoordinationLease(f.store,{...f.input(0),workerId:third.workerId,authSessionToken:third.authSessionToken,planId:undefined,taskKey:t.taskKey,taskRevision:t.taskRevision,idempotencyKey:'paused-no-plan'})).toThrow(expect.objectContaining({code:'COORDINATION_LEASE_BUSY'}));
  releaseCoordinationLease(f.store,f.control(a));expect(()=>f.store.updateProject(f.project.id,{repositoryPath:'' ,externalRepositoryId:'other-source'})).toThrow(expect.objectContaining({code:'PROJECT_REPOSITORY_ACTIVE_LEASE'}));expect(heartbeatCoordinationLease(f.store,f.control(b)).status).toBe('active');
 });
 it.each(['expire','revoke'] as const)('rejects %s replay while the peer survives reopening',operation=>{
  const f=fixture(),a=claimCoordinationLease(f.store,f.input(0)),b=claimCoordinationLease(f.store,f.input(1));f.child(f.dispatch(a,0));const db=f.dispatch(b,1);f.child(db);
  if(operation==='expire')f.store.db.prepare("UPDATE agent_coordination_leases SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(a.id);else revokeAgentCredential(f.store,f.auths[0].credentialId);
  const reopened=new Store(f.dbPath);try{expect(()=>claimCoordinationLease(reopened,f.input(0))).toThrow(expect.objectContaining({code:operation==='expire'?'COORDINATION_LEASE_LOST':'AUTH_REQUIRED'}));expect(claimCoordinationLease(reopened,f.input(1)).id).toBe(b.id);expect(dispatchChildTask(reopened,{...f.control(b),taskId:f.task(1).id,taskKey:f.task(1).taskKey,role:'designer',workerId:'child-1',idempotencyKey:'dispatch-1'}).dispatchId).toBe(db.dispatchId);}finally{reopened.close();}
 });
 it('serializes shared node resources even with independently valid concurrent parents',()=>{
  const f=fixture(true),a=claimCoordinationLease(f.store,f.input(0)),b=claimCoordinationLease(f.store,f.input(1));f.child(f.dispatch(a,0));
  expect(()=>f.dispatch(b,1)).toThrow(expect.objectContaining({code:'CHILD_TASK_NOT_AVAILABLE'}));
  releaseCoordinationLease(f.store,f.control(a));expect(f.child(f.dispatch(b,1)).lease.status).toBe('claimed');
 });
 it('persists both parents and receipt identities across reopen without recreating the singleton index',()=>{
  const f=fixture(),a=claimCoordinationLease(f.store,f.input(0)),b=claimCoordinationLease(f.store,f.input(1));const da=f.dispatch(a,0),db=f.dispatch(b,1);f.child(da);f.child(db);
  const reopened=new Store(f.dbPath);try{ensureCoordinationLeaseSchema(reopened);expect(claimCoordinationLease(reopened,f.input(0)).id).toBe(a.id);expect(claimCoordinationLease(reopened,f.input(1)).id).toBe(b.id);expect(listChildTaskDispatches(reopened,f.project.id).map(d=>d.dispatchId).sort()).toEqual([da.dispatchId,db.dispatchId].sort());expect(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name='idx_coordination_active_project'").get()).toBeUndefined();}finally{reopened.close();}
 });
 it.each(['no-plan-first','plan-first'])('keeps no-plan coordination project-exclusive: %s',order=>{
  const f=fixture(),t=f.noPlan(),n={...f.input(0),planId:undefined,taskKey:t.taskKey,taskRevision:t.taskRevision};
  if(order==='no-plan-first'){claimCoordinationLease(f.store,n);expect(()=>claimCoordinationLease(f.store,f.input(1))).toThrow(expect.objectContaining({code:'COORDINATION_LEASE_BUSY'}));}
  else{claimCoordinationLease(f.store,f.input(1));expect(()=>claimCoordinationLease(f.store,n)).toThrow(expect.objectContaining({code:'COORDINATION_LEASE_BUSY'}));}
 });
 it('rejects independently authenticated case-variant worker collisions and unauthorized claim audiences',()=>{
  const f=fixture();claimCoordinationLease(f.store,f.input(0));const variant=f.identity('MAIN-A');
  expect(()=>claimCoordinationLease(f.store,{...f.input(1),workerId:variant.workerId,authSessionToken:variant.authSessionToken})).toThrow(expect.objectContaining({code:'COORDINATION_LEASE_BUSY'}));
  const wrongRole=f.identity('wrong-role',['builder']);expect(()=>claimCoordinationLease(f.store,{...f.input(1),workerId:wrongRole.workerId,authSessionToken:wrongRole.authSessionToken})).toThrow(expect.objectContaining({code:'PERMISSION_DENIED'}));
  const wrongProject=f.identity('wrong-project',['approver'],['other-project']);expect(()=>claimCoordinationLease(f.store,{...f.input(1),workerId:wrongProject.workerId,authSessionToken:wrongProject.authSessionToken})).toThrow(expect.objectContaining({code:'PERMISSION_DENIED'}));
 });
 it('migrates a valid old singleton index atomically and admits another plan afterward',()=>{
  const f=fixture();const a=claimCoordinationLease(f.store,f.input(0));f.store.db.exec("DROP INDEX idx_coordination_active_plan; DROP INDEX idx_coordination_active_worker; DROP INDEX idx_coordination_active_no_plan; CREATE UNIQUE INDEX idx_coordination_active_project ON agent_coordination_leases(project_id) WHERE status IN ('active','paused')");
  ensureCoordinationLeaseSchema(f.store);expect(claimCoordinationLease(f.store,f.input(0)).id).toBe(a.id);expect(claimCoordinationLease(f.store,f.input(1)).planId).toBe(f.plans[1].id);
 });
 it.each(['duplicate-plan','duplicate-worker','mixed-no-plan'])('fails closed on inconsistent historical %s without deleting rows',kind=>{
  const f=fixture();claimCoordinationLease(f.store,f.input(0));const b=claimCoordinationLease(f.store,f.input(1));f.store.db.exec('DROP INDEX idx_coordination_active_plan; DROP INDEX idx_coordination_active_worker; DROP INDEX idx_coordination_active_no_plan');
  if(kind==='duplicate-plan')f.store.db.prepare('UPDATE agent_coordination_leases SET target_plan_id=? WHERE id=?').run(f.plans[0].id,b.id);
  else if(kind==='duplicate-worker')f.store.db.prepare('UPDATE agent_coordination_leases SET worker_id=? WHERE id=?').run('MAIN-A',b.id);
  else f.store.db.prepare("UPDATE agent_coordination_leases SET target_plan_id='',target_task_key='legacy-task' WHERE id=?").run(b.id);
  expect(()=>ensureCoordinationLeaseSchema(f.store)).toThrow(expect.objectContaining({code:'COORDINATION_SCHEMA_CONFLICT'}));expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM agent_coordination_leases WHERE status='active'").get()).toEqual({count:2});
 });
});

async function concurrentProcesses(dbPath: string, inputs: object[]) {
  const script = `
    import { Store } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/server/db.ts")).href)};
    import { claimCoordinationLease } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/server/coordinationLeases.ts")).href)};
    const store = new Store(process.argv[1]);
    console.log("READY");
    process.stdin.once("data", () => {
      try { console.log(JSON.stringify({ result: (claimCoordinationLease)(store, JSON.parse(process.argv[2])) })); }
      catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }
      finally { store.close(); process.stdin.destroy(); }
    });
  `;
  const children = inputs.map((input) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script, dbPath, JSON.stringify(input)],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const result = new Promise<{ result?: { id: string }; code?: string }>((resolve, reject) => {
      child.stdout.on("data", (data) => { stdout += data.toString(); if (stdout.includes("READY\n")) readyResolve(); });
      child.stderr.on("data", (data) => { stderr += data.toString(); });
      child.on("error", (error) => { readyReject(error); reject(error); });
      child.on("close", (code) => {
        if (code !== 0) { const error = new Error(`Child exited ${code}: ${stderr}`); readyReject(error); reject(error); return; }
        try { resolve(JSON.parse(stdout.trim().split("\n").at(-1)!)); }
        catch (error) { readyReject(error as Error); reject(error); }
      });
    });
    // Attach a rejection handler while waiting for the startup barrier.
    void result.catch(() => undefined);
    return { child, ready, result };
  });
  const timer = setTimeout(() => { for (const { child } of children) child.kill(); }, 20_000);
  try {
    await Promise.all(children.map((child) => child.ready));
    for (const { child } of children) child.stdin.end("GO\n");
    return await Promise.all(children.map((child) => child.result));
  } finally { clearTimeout(timer); for (const { child } of children) child.kill(); }
}

describe('plan-parent SQLite process races',()=>{
 it.each(['distinct-plans','same-plan','no-plan-vs-plan'] as const)('serializes %s across actual independent processes',async scenario=>{
  const f=fixture();const a=f.input(0),b=f.input(1);
  const first=scenario==='no-plan-vs-plan'?{...a,planId:undefined,taskKey:f.noPlan().taskKey,taskRevision:f.noPlan().taskRevision}:a;
  const second=scenario==='same-plan'?{...b,planId:a.planId}:b;
  const results=await concurrentProcesses(f.dbPath,[first,second]);
  expect(results.filter(r=>r.result)).toHaveLength(scenario==='distinct-plans'?2:1);
  if(scenario!=='distinct-plans')expect(results.find(r=>r.code)?.code).toBe('COORDINATION_LEASE_BUSY');
  expect(listCoordinationLeases(f.store,f.project.id).filter(p=>p.status==='active')).toHaveLength(scenario==='distinct-plans'?2:1);
 },30000);
});
