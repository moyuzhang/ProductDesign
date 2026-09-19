import type { Diagram, DocumentReferenceTargetType } from "../shared/types.js";
import type { Store } from "./db.js";
import { inspectNodeWorkflow, inspectProjectFoundation, isWorkflowDeliveryNode } from "./workflow.js";
import { isExecutableDeliveryPlan } from "./planPolicy.js";

/**
 * Delivery state is persisted inside diagram nodes. Validate only state changes so
 * old incomplete records do not block unrelated layout or title edits.
 */
export function validateDiagramDeliveryTransition(store: Store, before: Diagram, after: Diagram): string | undefined {
  const previous = new Map(before.nodes.map((node) => [node.id, node]));
  for (const node of after.nodes) {
    if (!isWorkflowDeliveryNode(after, node)) continue;
    const old = previous.get(node.id);
    const requirementChanged = old?.requirementStatus !== node.requirementStatus;
    const designChanged = old?.designStatus !== node.designStatus;
    const developmentChanged = old?.developmentStatus !== node.developmentStatus;
    const acceptanceChanged = old?.acceptanceStatus !== node.acceptanceStatus;
    const databaseRequirementChanged = (old?.requiresDatabase ?? old?.kind === "data") !== (node.requiresDatabase ?? node.kind === "data");
    const inspection = inspectNodeWorkflow(store, after, node);
    const controlledPlans = store.listPlans(after.projectId, after.id, node.id)
      .filter((plan) => isExecutableDeliveryPlan(plan) && plan.lifecycleStatus !== "legacy");

    if (controlledPlans.length > 0 && (developmentChanged || acceptanceChanged)) {
      return `节点“${node.label}”的开发与验收状态由施工计划自动汇总，请使用计划交付流转`;
    }

    if (requirementChanged && node.requirementStatus === "已批准") {
      if (!inspection.descriptionReady) return `节点“${node.label}”需求批准前必须填写功能说明`;
      if (!inspection.ownerReady) return `节点“${node.label}”需求批准前必须指定负责人`;
      if (!inspection.criteriaReady) return `节点“${node.label}”需求批准前必须填写验收标准`;
    }

    if (designChanged && node.designStatus === "已批准") {
      if (!inspection.requirementReady) return `节点“${node.label}”需求批准后才能批准设计`;
      if (!inspection.documentReady) return `节点“${node.label}”设计批准前至少需要一份已批准的节点文档`;
      if (!inspection.databaseReady) return `节点“${node.label}”需要数据库，设计批准前必须关联数据库表`;
    }

    if (developmentChanged && node.developmentStatus === "已阻塞" && !node.blockedReason?.trim()) {
      return `节点“${node.label}”标记为已阻塞前必须填写阻塞原因`;
    }

    const beginsOrFinishesDevelopment = developmentChanged && ["开发中", "待验收", "已完成"].includes(node.developmentStatus ?? "未开发");
    if (beginsOrFinishesDevelopment) {
      const foundation = inspectProjectFoundation(store, after.projectId);
      if (!foundation.ready) return `项目进入开发前必须补全：${foundation.missing.join("、")}`;
      if (!inspection.descriptionReady) return `节点“${node.label}”开始开发前必须填写功能说明`;
      if (!inspection.ownerReady) return `节点“${node.label}”开始开发前必须指定负责人`;
      if (!inspection.criteriaReady) return `节点“${node.label}”开始开发前必须填写验收标准`;
      if (!inspection.requirementReady) return `节点“${node.label}”需求批准后才能开始开发`;
      if (!inspection.documentReady) return `节点“${node.label}”开始开发前至少需要一份已批准的节点文档`;
      if (!inspection.designReady) return `节点“${node.label}”设计批准后才能开始开发`;
      if (!inspection.databaseReady) return `节点“${node.label}”开始开发前必须关联数据库表`;
      if (!inspection.planReady) return `节点“${node.label}”至少需要一个开发计划才能开始开发`;
    }

    if (developmentChanged && (node.developmentStatus === "待验收" || node.developmentStatus === "已完成")) {
      if (!inspection.plansCompleted) return `节点“${node.label}”仍有未完成的开发计划`;
    }

    if (databaseRequirementChanged && inspection.state.requiresDatabase && node.developmentStatus !== undefined && node.developmentStatus !== "未开发" && !inspection.databaseReady) {
      return `节点“${node.label}”已进入开发，标记为需要数据库前必须先关联数据库表`;
    }

    if (acceptanceChanged && node.acceptanceStatus === "已通过") {
      if (node.developmentStatus !== "已完成") return `节点“${node.label}”开发完成后才能验收通过`;
      if (!inspection.criteriaReady) return `节点“${node.label}”验收通过前必须填写验收标准`;
      if (!inspection.documentReady) return `节点“${node.label}”验收通过前至少需要一份已批准的节点文档`;
      if (!inspection.databaseReady) return `节点“${node.label}”验收通过前必须完成数据库表关联`;
      if (!inspection.evidenceReady) return `节点“${node.label}”验收通过前至少需要一条完整的节点证据`;
      if (!inspection.plansCompleted) return `节点“${node.label}”验收通过前必须完成全部开发计划`;
    }
  }
  return undefined;
}

export function validateDocumentNodeBinding(store: Store, projectId: string, nodeId: string | null | undefined): string | undefined {
  if (!nodeId) return undefined;
  const workNode = store.getNode(nodeId);
  if (workNode) return workNode.projectId === projectId ? undefined : "绑定的节点不属于当前项目";
  const diagramNode = store.listDiagrams(projectId).some((diagram) => diagram.nodes.some((node) => node.id === nodeId));
  return diagramNode ? undefined : "绑定的画布节点不存在或不属于当前项目";
}

export function validateDocumentReferenceTarget(
  store: Store,
  projectId: string,
  targetType: DocumentReferenceTargetType,
  targetId: string,
): string | undefined {
  if (targetType === "project") return targetId === projectId ? undefined : "引用的项目不是当前项目";
  if (targetType === "diagram") {
    const diagram = store.getDiagram(targetId);
    return diagram?.projectId === projectId ? undefined : "引用的画布不存在或不属于当前项目";
  }
  if (targetType === "diagramNode") return validateDocumentNodeBinding(store, projectId, targetId);
  if (targetType === "plan") return store.getPlan(targetId)?.projectId === projectId ? undefined : "引用的计划不存在或不属于当前项目";
  if (targetType === "databaseModel") return store.getDatabaseModel(targetId)?.projectId === projectId ? undefined : "引用的数据库模型不存在或不属于当前项目";
  if (targetType === "evidence") return store.getEvidence(targetId)?.projectId === projectId ? undefined : "引用的证据不存在或不属于当前项目";
  if (targetType === "governance") return store.getGovernance(targetId)?.projectId === projectId ? undefined : "引用的治理记录不存在或不属于当前项目";
  return "不支持的文档引用目标";
}
