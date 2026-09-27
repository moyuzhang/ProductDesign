import type { Store } from "./db.js";
import { listClaimableAgentTasks } from "./agentTaskLeases.js";
import { isExecutableDeliveryPlan } from "./planPolicy.js";
import { CoordinationLeaseError } from "./coordinationLeases.js";

export type CoordinationHandoffTarget =
  | { planId: string; expectedProposalRevision?: number; taskId?: never; expectedTaskKey?: never; expectedTaskRevision?: never }
  | { taskId: string; expectedTaskKey?: string; expectedTaskRevision?: string; planId?: never; expectedProposalRevision?: never };

/** Strict allowlist: never spread a plan, task, lease or credential into the Web payload. */
export function safeCoordinationHandoff(store: Store, projectId: string, target: CoordinationHandoffTarget): string {
  const project = store.getProject(projectId);
  if (!project) throw new CoordinationLeaseError(404, "PROJECT_NOT_FOUND", "项目不存在");
  const projectFields = { id: project.id, code: project.code, name: project.name };
  let payload: object;
  if (target.planId) {
    const plan = store.getPlan(target.planId);
    if (!plan || plan.projectId !== projectId || !isExecutableDeliveryPlan(plan) || plan.lifecycleStatus === "accepted"
      || store.listPlans(projectId).some((item) => item.reworkOfPlanId === plan.id && item.id !== plan.id))
      throw new CoordinationLeaseError(409, "HANDOFF_TARGET_STALE", "目标计划不可交接，请刷新");
    if (target.expectedProposalRevision !== undefined && plan.proposalRevision !== target.expectedProposalRevision)
      throw new CoordinationLeaseError(409, "HANDOFF_TARGET_STALE", "计划修订已变化，请刷新");
    payload = {
      schemaVersion: "1.0.0", generatedAt: plan.updatedAt, project: projectFields,
      binding: { type: "plan", planId: plan.id, proposalRevision: plan.proposalRevision },
      target: { title: plan.title, diagramId: plan.diagramId || "", nodeId: plan.diagramNodeId || "" },
    };
  } else {
    const task = listClaimableAgentTasks(store, projectId).find((item) => item.id === target.taskId);
    if (!task || task.planItemId || task.queue !== "design" || task.deliveryTrack !== "design"
      || task.requiredRole !== "designer" || !task.assignee?.agentId || !task.poolId || !task.available)
      throw new CoordinationLeaseError(409, "HANDOFF_TARGET_STALE", "目标设计任务不可交接，请刷新");
    if (target.expectedTaskKey !== undefined && task.taskKey !== target.expectedTaskKey
      || target.expectedTaskRevision !== undefined && task.taskRevision !== target.expectedTaskRevision)
      throw new CoordinationLeaseError(409, "HANDOFF_TARGET_STALE", "任务修订已变化，请刷新");
    payload = {
      schemaVersion: "1.0.0", generatedAt: task.createdAt, project: projectFields,
      binding: { type: "task", taskId: task.id, taskKey: task.taskKey, taskRevision: task.taskRevision },
      target: { title: task.title, diagramId: task.diagramId || "", nodeId: task.nodeId || "" },
      task: { queue: task.queue, requiredRole: task.requiredRole, deliveryTrack: task.deliveryTrack,
        assigneeAgentId: task.assignee.agentId, poolId: task.poolId, available: task.available,
        availabilityReason: task.availabilityReason || "" },
    };
  }
  return JSON.stringify(payload, null, 2);
}
