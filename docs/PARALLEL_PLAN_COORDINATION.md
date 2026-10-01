# Bounded multi-plan coordination

## Model

An external harness may hold multiple concurrent coordination leases in one project, **one exact plan per lease and one unique worker per live lease**. Each worker authenticates using its existing independently provisioned Main Agent/approver credential whose project audience already authorizes that project. No credential, token, role or project audience is broadened. A parent token still grants only its own exact plan and stage. One harness-level process may supervise these logical coordinator workers; the service does not spawn them.

Plan scope is an explicit public claim, not a new credential-level allowedPlans feature. Existing credentials authorize the project; each lease narrows authority to one plan. No new plan privileges or credential provisioning are introduced by this feature.

No-plan Designer/brief coordination remains project-exclusive for compatibility. It cannot coexist with plan coordinators. A legacy bound-but-untargeted parent remains exclusive until existing safe adoption/release logic runs. A worker cannot own two live parents even if agent IDs or worker casing differ. Task claims also reserve each active/paused coordinator worker: unrelated-plan approvals and all Designer/Builder/Auditor children must use another worker. The compatibility exception is the exact Main Agent taking its own parent plan’s Approver work order; that shares only the same parent lifecycle.

## Invariants

1. At most one active/paused parent for `(project, targetPlan)`; at most one active/paused parent for `(project, normalizedWorker)`.
2. No-plan active/paused parent excludes every other parent in that project. Claims serialize in the existing immediate transaction.
3. Exact plan/role/stage/assignee/taskRevision checks in dispatch, child claim and Approver transitions are unchanged. Cross-plan token use remains rejected.
4. Parent heartbeat, pause, advance, cancel, plan invalidation and credential invalidation act only on that parent's children. Distinct worker registrations prevent cancelling one from marking another offline. Expiration remains per worker and parent.
5. Resource/workspace locks and task capacity remain project-wide and unchanged; plan independence does not imply resource independence.
6. Direct Builder/Designer/Auditor claims are blocked when a live parent owns the same plan. They remain blocked globally for any no-plan parent; direct no-plan tasks remain blocked while any parent is live. An unrelated plan without its own coordinator can use the existing worker pool.
7. Rebinding project repository remains forbidden while ANY coordinator or work order is active. Listings already return all parents/children and retain historical rows.
8. Claim replay verifies original auth session/credential, exact target, worker, token lifetime and active state; dispatch/reassign replay remains scoped to exact parent. A revoked coordinator cannot replay; another independently credentialed coordinator is unaffected.

## Implemented source / schema impact

- `coordinationLeases.ts`: remove creation of project-singleton index; in existing schema migration immediate transaction, retire insecure legacy rows as before, drop `idx_coordination_active_project`, create partial unique active-plan, normalized-worker and no-plan-project indices. Existing DB can only contain one live parent per project so migration is deterministic. Never recreate old singleton index on restart.
- Replace claim's `SELECT ... project ... .get()` with transaction-local conflict lookup: same worker, same target plan, or either request/existing parent is no-plan. Preserve existing same-target owner retry/reuse logic and errors. Different plan + different worker + independently valid credential is admitted. No changes to exact-parent bearer verification.
- `agentTaskLeases.ts`: narrow coordinator presence query to selected task's matching plan, conservatively retaining all no-plan exclusivity described above. Keep active exact-task dispatch check unchanged.
- API/MCP argument/response shapes unchanged. `getAgentTaskCapacity`/API/MCP listings already arrays; confirm both entries visible. Repository binding query remains global. Source scan found no UI singleton caller; public/MCP parent and child listings already enumerate multiple records.

## Tests / acceptance

- Fresh two approved independent plans: independently authenticated coordinator workers claim both and dispatch/claim/start their own builders; each token refuses the other's plan.
- Duplicate plan with another worker/credential rejected; same worker cannot claim another plan, including case variation; invalid role/project and revoked credential rejected.
- No-plan/plan exclusivity in both claim orders, with existing no-plan handoff tests unchanged.
- Matching-plan direct claim blocked, unrelated-plan pool claim permitted; direct no-plan tasks remain blocked during coordination.
- Same-node/shared resource plans: parents can coexist, but second child claim/dispatch cannot acquire occupied scope; succeeds after release.
- Cancel/pause/stage/heartbeat/revoke one parent leaves the other parent, dispatch, work order, resource lock, runner and replay usable.
- Persist/reopen DB with two live parents; schema initialization does not recreate singleton or discard rows; claim/dispatch replay returns original IDs. Legacy singleton DB migrates safely; insecure old parent still atomically reclaimed.
- Concurrent independent process claims for distinct plans both succeed; same-plan race creates exactly one parent. Existing 54 coordination, dispatch/retry, external workspace/lifecycle and whole verify suites pass.
- Fresh public-API business journey from an empty disposable DB, genuine isolated parallel child implementations, exact-commit independent audits and acceptance; no pre-approved DB seed for business claim. Regression fixtures explicitly synthetic.

## Non-goals

No multi-plan bearer token, no automatic coordinator scheduling, no child model runtime, no credential creation/expansion, no broad no-plan parallelization, no weakening of design-change or evidence gates, no deployment.

## Verification notes

Independent design review approved this bounded model before source changes. Independent code review identified a missing symmetric coordinator-worker occupancy check in task claims; the final implementation includes it with the own-plan approval exception described above. The 24 new tests cover actual separate Node process races and explicit migration/lifecycle/worker isolation. A fresh public-API QA run exercised a project with two active parents, real independent sample child processes, scoped Auditor dispatches, independent content/source reviews and completed acceptance. It does not claim live Codex/model execution.

Pause intentionally reclaims that parent's children. Resume restores only the parent; the harness must dispatch and claim new child work. It cannot reuse the old child lease. Revoking a credential invalidates all parents bound to that credential; peer-isolation tests use independent credentials and do not promise immunity for another parent bound to the revoked credential.
