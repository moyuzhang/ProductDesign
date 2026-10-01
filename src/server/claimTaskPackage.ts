import { createHash } from "node:crypto";
import type { Store } from "./db.js";
import { assertExternalWorkspaceClaim, approvalGroupLeases, claimAgentTask, ensureAgentTaskLeaseSchema, expireStaleAgentTasks, taskPackageLease, type ClaimAgentTaskInput, type AgentTaskLeaseContext } from "./agentTaskLeases.js";
import * as orchestration from "./orchestration.js";

/** Commit a claim only after its complete wire payload can be produced. */
export function claimTaskPackage(store: Store, input: ClaimAgentTaskInput, context: AgentTaskLeaseContext = {}): string {
  // Defaults are correlation identifiers, not credentials. They must be stable
  // across retries of the same request, including retries on a new connection.
  const suffix = createHash("sha256").update(JSON.stringify([
    input.projectId, input.role, input.agentId, input.workerId ?? "", input.idempotencyKey,
  ])).digest("hex");
  const sessionId = input.sessionId || `claim-session-${suffix}`;
  const resolved = {
    ...input,
    workerId: input.workerId || `${input.agentId}:${sessionId}`,
    sessionId,
    runId: input.runId || `claim-run-${suffix}`,
  };
  assertExternalWorkspaceClaim(store, resolved);
  ensureAgentTaskLeaseSchema(store);
  expireStaleAgentTasks(store, input.projectId);
  return store.db.transaction(() => {
    const snapshot = orchestration.buildAgentOrchestration(store, input.projectId, true);
    if (!snapshot) throw new orchestration.AgentTaskPackageError(404, "PROJECT_NOT_FOUND", "项目不存在");
    const queue = input.role === "designer" ? "design" : input.role === "builder" ? "development"
      : input.role === "approver" ? "approval" : "audit";
    orchestration.validateAgentTaskPackageSelector(store, snapshot, { queue, taskId: input.taskId });
    const lease = claimAgentTask(store, resolved, { ...context, sessionId }, snapshot);
    const taskPackage = orchestration.buildAgentTaskPackage(store, input.projectId, {
      queue: lease.queue,
      taskId: lease.taskId,
      lease: taskPackageLease(lease),
    }, snapshot);
    const scopeApprovals = approvalGroupLeases(store, lease).filter((member) => member.workOrderId !== lease.workOrderId)
      .map((member) => ({ ...taskPackageLease(member), role: member.role }));
    if (lease.approvalGroupId) Object.assign(taskPackage, { approvalGroupId: lease.approvalGroupId, scopeApprovals });
    return JSON.stringify(taskPackage, null, 2);
  }).immediate();
}
