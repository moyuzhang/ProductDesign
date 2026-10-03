# Business workflow QA summary

Test date: 2026-10-01 UTC. These results cover disposable local projects and scripted external harnesses, not production deployments or live Codex/model execution. This publication contains maintained source/tests and this summary; raw runtime histories, credentials, databases and operational dumps are not included.

## Authenticated plan submission

A fresh public-API project exposed a real plan-submission failure: REST/MCP schemas and the shared lease transition lost submitted document revision, audit outcome and completion context. The fix forwards the submitted context without inventing missing fields. It also checks the selected document revision, evidence, actor, implementation revision, command and audit outcome against the exact plan and transition.

The single-module sample subsequently completed development, independent exact-commit audit and acceptance. The builder ran 18 tests; the independent reviewer reran these and six additional edge-probe groups. Reopening the service preserved completed state. Eight maintained regression cases cover success, missing/inconsistent input and transaction rollback.

## Mid-development design changes

A separate fresh project exercised actual development followed by a rejected gap report, preserved baseline, formal design change, independent correction of an intentionally mistaken requirement-impact classification, requirement revision/reapproval, new frozen baseline, rejection of historical audit evidence, and renewed development dispatch/start. Cleanup revoked temporary identities and closed active leases.

This run stopped after renewed development started. It does not establish v2 implementation or final acceptance.

## Multi-plan coordination

The original business run confirmed the project-singleton parent limitation. A reviewed bounded correction now allows concurrent independently authenticated coordinator workers, each holding one exact-plan parent lease. Cross-plan tokens remain invalid; worker ownership, no-plan exclusivity, resource locks and individual parent lifecycles remain enforced. See [the coordination contract](PARALLEL_PLAN_COORDINATION.md).

A fresh post-fix project completed both plans and reached completed workflow. Two real isolated Node child processes each executed 14 passing tests and overlapped for 467 ms; independent reviewers reran each exact implementation and three extra assertions per module. Separate parent-scoped Auditor dispatch and final acceptance passed. Pausing one parent left the other usable; resuming required fresh child dispatch/claim. This is a scripted-harness functional test, not a model-throughput benchmark. The new regression suite has 24 cases, including separate-process SQLite races and migration/lifecycle isolation.

## Bounded MCP stability

Actual local HTTP transport completed 990/990 paced reads with no errors over 180 seconds at 1, 4 and 8 clients. Client deadlines, reconnects, graceful close and restart were exercised. Actual stdio entry points completed 30/30 reads over three process connections, with successful EOF/SIGTERM exits.

This small one-project read workload does not establish production capacity, long-term uptime or leak freedom. RSS grew substantially before plateauing; allocation behavior warrants profiling for higher throughput or stricter memory budgets. HTTP serving is stateless. Restart checks establish workflow persistence, not active-task recovery; client deadlines do not prove cancellation of long-running server work.

## Verification and limits

The combined maintained source/tests passed `npm run verify`: 89 test files, 816 passed, 1 skipped; Web/server TypeScript checks and builds passed. The existing large frontend-chunk warning remains. Independent source reviews and focused regressions were completed before integration.

No browser/UI acceptance, real Codex runtime/model execution, production migration/deployment or NumberSet data modification is claimed. External workspace paths and baselines remain runner attestations to the service; local independent source review does not establish generic service-side remote verification. Trusted external evidence repair remains unimplemented. No multi-plan bearer token, automatic coordinator scheduler or service-spawned model process was added.
