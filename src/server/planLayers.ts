import type { PlanDeliveryLayerGate, PlanDeliveryLayerPlanState, PlanItem } from "../shared/types.js";
import { assertNoDesignGap } from "./designGap.js";
import type { Store } from "./db.js";
import { isExecutableDeliveryPlan } from "./planPolicy.js";

const DESIGN_PHASE_ACTIONS = new Set([
  "complete_node_definition", "approve_node_requirement", "approve_node_document",
  "approve_node_design", "bind_node_database", "create_node_plan", "submit_plan",
  "audit_design", "pass_design_audit", "fail_design_audit", "approve_plan", "reject_plan",
]);

export function isDesignPhaseAction(action?: string): boolean {
  return DESIGN_PHASE_ACTIONS.has(action ?? "");
}

function controlledTasks(plans: PlanItem[]): PlanItem[] {
  return plans.filter((plan) => isExecutableDeliveryPlan(plan) && Boolean(plan.diagramId && plan.diagramNodeId));
}

function isComplete(plan: PlanItem): boolean {
  return plan.lifecycleStatus === "accepted" || (plan.lifecycleStatus === "legacy" && plan.status === "已完成");
}

export function analyzePlanLayers(plans: PlanItem[]): PlanDeliveryLayerGate {
  const tasks = controlledTasks(plans);
  const byId = new Map(tasks.map((plan) => [plan.id, plan]));
  const issues: string[] = [];
  const issueSet = new Set<string>();
  const layerById = new Map<string, number>();
  const visiting = new Set<string>();
  const childIdsByParentId = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentId || !byId.has(task.parentId)) continue;
    const childIds = childIdsByParentId.get(task.parentId) ?? [];
    childIds.push(task.id);
    childIdsByParentId.set(task.parentId, childIds);
  }

  const addIssue = (issue: string) => {
    if (!issueSet.has(issue)) {
      issueSet.add(issue);
      issues.push(issue);
    }
  };
  const visit = (plan: PlanItem, path: string[]): number => {
    const cached = layerById.get(plan.id);
    if (cached !== undefined) return cached;
    if (visiting.has(plan.id)) {
      const cycleStart = path.indexOf(plan.id);
      const cycle = [...path.slice(Math.max(0, cycleStart)), plan.id];
      addIssue(`开发计划依赖存在循环：${cycle.join(" -> ")}`);
      return 1;
    }
    visiting.add(plan.id);
    let maxDependencyLayer = 0;
    // A task with executable child tasks is an aggregate delivery task. Its Builder work
    // starts only after every direct child has completed the full lifecycle. Children do
    // not implicitly depend on the parent, so they remain independently claimable.
    const dependencyIds = [...new Set([...plan.dependencyIds, ...(childIdsByParentId.get(plan.id) ?? [])])];
    for (const dependencyId of dependencyIds) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        const referenced = plans.find((item) => item.id === dependencyId);
        if (!referenced) addIssue(`开发计划“${plan.title}”引用了不存在的依赖 ${dependencyId}`);
        continue;
      }
      maxDependencyLayer = Math.max(maxDependencyLayer, visit(dependency, [...path, plan.id]));
    }
    visiting.delete(plan.id);
    const layer = maxDependencyLayer + 1;
    layerById.set(plan.id, layer);
    return layer;
  };

  for (const task of tasks) visit(task, []);
  const totalLayers = Math.max(0, ...layerById.values());
  const effectiveDependencyIds = (plan: PlanItem) => [
    ...new Set([...plan.dependencyIds, ...(childIdsByParentId.get(plan.id) ?? [])]),
  ];
  const states: PlanDeliveryLayerPlanState[] = tasks.map((plan) => {
    const layer = layerById.get(plan.id) ?? 1;
    const complete = isComplete(plan);
    const incompleteDependencies = plan.dependencyIds
      .map((dependencyId) => byId.get(dependencyId))
      .filter((dependency): dependency is PlanItem => Boolean(dependency && !isComplete(dependency)));
    const locked = issues.length > 0 || (!complete && incompleteDependencies.length > 0);
    return {
      planId: plan.id,
      layer,
      complete,
      locked,
      lockReason: issues.length > 0
        ? issues[0]
        : locked
          ? `必须先完成并验收依赖任务：${incompleteDependencies.map((dependency) => dependency.title).join("、")}`
          : "",
    };
  });
  const activeLayer = issues.length > 0
    ? null
    : Math.min(...states.filter((state) => !state.complete && !state.locked).map((state) => state.layer));
  const normalizedActiveLayer = Number.isFinite(activeLayer) ? activeLayer : null;
  return {
    activeLayer: normalizedActiveLayer,
    totalLayers,
    activePlanCount: states.filter((state) => !state.complete && !state.locked).length,
    lockedPlanCount: states.filter((state) => state.locked).length,
    issues,
    plans: states.sort((left, right) => left.layer - right.layer || left.planId.localeCompare(right.planId)),
  };
}

export function assertPlanLayerUnlocked(store: Store, plan: PlanItem, action?: string): void {
  const gate = analyzePlanLayers(store.listPlans(plan.projectId));
  const state = gate.plans.find((item) => item.planId === plan.id);
  if (gate.issues.length > 0) {
    throw Object.assign(new Error(`计划依赖无法分层：${gate.issues.join("；")}`), { statusCode: 409, code: "PLAN_LAYER_INVALID" });
  }
  if (state?.locked && !isDesignPhaseAction(action)) {
    throw Object.assign(new Error(state.lockReason), { statusCode: 409, code: "PLAN_LAYER_LOCKED" });
  }
}

export function assertPlanImplementationUnlocked(store: Store, plan: PlanItem): void {
  assertNoDesignGap(store, plan);
  assertPlanLayerUnlocked(store, plan);
  const incompleteChildren = store.listPlans(plan.projectId)
    .filter((candidate) => candidate.parentId === plan.id && isExecutableDeliveryPlan(candidate) && !isComplete(candidate));
  if (incompleteChildren.length > 0) {
    throw Object.assign(new Error(`父聚合任务必须先完成并验收直接子任务：${incompleteChildren.map((child) => child.title).join("、")}`), {
      statusCode: 409,
      code: "PLAN_CHILDREN_INCOMPLETE",
    });
  }
}

export function isPlanImplementationUnlocked(plans: PlanItem[], plan: PlanItem): boolean {
  return !plans.some((candidate) => candidate.parentId === plan.id && isExecutableDeliveryPlan(candidate) && !isComplete(candidate));
}

export function validatePlanLayerGraph(plans: PlanItem[]): string | undefined {
  return analyzePlanLayers(plans).issues[0];
}
