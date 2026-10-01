import { createHash } from "node:crypto";
import { designContractSchema, requirementsBaselineSchema, DESIGN_PHASES,
  type DesignContract, type DesignContractReport, type DesignDocumentVersionRef } from "../shared/designContract.js";
import type { DesignDoc, Diagram, DocumentReference, DocumentRevision, Evidence, PlanItem } from "../shared/types.js";
import type { Store } from "./db.js";
import { isActiveDeliveryPlan } from "./planPolicy.js";
import { matchesImplementationEvidencePolicy } from "./evidencePolicy.js";

export class DesignContractError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: string, message: string, readonly details: unknown) { super(message); this.name = "DesignContractError"; }
}

export interface DesignContractSnapshot {
  projectId: string;
  plans: PlanItem[];
  diagrams: Diagram[];
  documents: DesignDoc[];
  revisions: DocumentRevision[];
  evidence: Evidence[];
  references: DocumentReference[];
  contractRef?: DesignDocumentVersionRef;
}

/** Scope changes stale a mapping; harmless lifecycle timestamps do not. */
export function planScopeRevision(plan: PlanItem): string {
  return createHash("sha256").update(JSON.stringify([
    plan.id, plan.projectId, plan.diagramId, plan.diagramNodeId, plan.parentId, plan.kind,
    plan.title, plan.description, plan.owner, [...plan.dependencyIds].sort(),
    ["designer", "builder", "auditor", "approver"].map((role) => {
      const entry = plan.roleAssignments[role as keyof typeof plan.roleAssignments];
      return [role, entry?.agentId ?? "", entry?.poolId ?? ""];
    }),
  ])).digest("hex");
}

function emptyReport(snapshot: DesignContractSnapshot): DesignContractReport {
  return { status: "unassessed", scope: "declared-structured-requirements-only", issues: [], coverage: [], cycles: [],
    contractRef: snapshot.contractRef,
    plans: snapshot.plans.filter((plan) => plan.projectId === snapshot.projectId && isActiveDeliveryPlan(plan))
      .map((plan) => ({ id: plan.id, title: plan.title, scopeRevision: planScopeRevision(plan), diagramId: plan.diagramId, nodeId: plan.diagramNodeId })),
  };
}

function parseJson(content: string): unknown {
  try { return JSON.parse(content); } catch { return undefined; }
}

/** Inspect only structured assertions against independently loaded authoritative records.
 * No NLP, tests execution, inferred requirements, mutations or automatic approval. */
export function validateDesignContract(input: unknown, snapshot: DesignContractSnapshot): DesignContractReport {
  const report = emptyReport(snapshot);
  const issue = (code: string, message: string, path: string, ...entityIds: string[]) => {
    report.issues.push({ code, message, path, entityIds });
  };
  if (input === undefined || input === null) {
    issue("CONTRACT_ABSENT", "没有明确引用的结构化设计合同，尚未评估需求覆盖。", "contract");
    return report;
  }
  const parsed = designContractSchema.safeParse(input);
  if (!parsed.success) {
    report.status = "invalid";
    for (const error of parsed.error.issues) issue("CONTRACT_SCHEMA_INVALID", error.message, error.path.join("."));
    return report;
  }
  const contract = parsed.data;
  report.baselineRef = contract.baseline;
  if (contract.projectId !== snapshot.projectId) issue("PROJECT_MISMATCH", "合同不属于当前项目。", "projectId", contract.projectId);
  const documents = new Map(snapshot.documents.map((document) => [document.id, document]));
  const revisions = new Map(snapshot.revisions.map((revision) => [revision.id, revision]));
  const resolveRevision = (ref: DesignDocumentVersionRef, path: string, approved: boolean) => {
    const doc = documents.get(ref.documentId);
    const revision = revisions.get(ref.revisionId);
    if (!doc || !revision) { issue("DOCUMENT_REFERENCE_DANGLING", "文档或固定修订不存在。", path, ref.documentId, ref.revisionId); return undefined; }
    if (doc.projectId !== snapshot.projectId || revision.projectId !== snapshot.projectId || revision.documentId !== doc.id) {
      issue("DOCUMENT_REFERENCE_MISMATCH", "文档、修订和项目归属不一致。", path, doc.id, revision.id); return undefined;
    }
    if (doc.currentRevisionId !== revision.id) issue("DOCUMENT_REFERENCE_STALE", "引用不是文档当前修订。", path, doc.id, revision.id);
    if (doc.status === "已废弃" || revision.status === "已废弃") issue("DOCUMENT_DEPRECATED", "引用文档已废弃。", path, doc.id);
    if (approved && (doc.status !== "已批准" || revision.status !== "已批准")) issue("BASELINE_NOT_APPROVED", "独立需求清单尚未批准；不能据此宣称覆盖完整。", path, doc.id, revision.id);
    return revision;
  };
  if (snapshot.contractRef) {
    const contractRevision = resolveRevision(snapshot.contractRef, "contractRef", false);
    if (contractRevision && (contractRevision.status !== "已批准" || documents.get(snapshot.contractRef.documentId)?.status !== "已批准")) {
      issue("CONTRACT_NOT_APPROVED", "合同草稿可检查，但进入正式交付基线前须独立批准。", "contractRef", snapshot.contractRef.documentId, snapshot.contractRef.revisionId);
    }
  }
  const baselineRevision = resolveRevision(contract.baseline, "baseline", true);
  const parsedBaseline = requirementsBaselineSchema.safeParse(baselineRevision ? parseJson(baselineRevision.content) : undefined);
  if (!parsedBaseline.success) {
    issue("BASELINE_SCHEMA_INVALID", "基线必须是独立的结构化需求清单，不能从现有计划反推。", "baseline", contract.baseline.revisionId);
    report.status = "invalid";
    return report;
  }
  const baseline = parsedBaseline.data;
  if (baseline.projectId !== snapshot.projectId) issue("BASELINE_PROJECT_MISMATCH", "需求清单不属于当前项目。", "baseline.projectId", baseline.projectId);
  if (baseline.inventoryStatus !== "reviewed") issue("BASELINE_PARTIAL", "基线清单尚未确认完整，当前结果仅是部分检查。", "baseline.inventoryStatus");
  const requirements = new Map<string, typeof baseline.requirements[number]>();
  for (const [index, requirement] of baseline.requirements.entries()) {
    if (requirements.has(requirement.id)) issue("REQUIREMENT_ID_DUPLICATE", "需求 ID 重复。", `baseline.requirements.${index}`, requirement.id);
    requirements.set(requirement.id, requirement);
    for (const key of ["criteria", "interfaces"] as const) {
      const seen = new Set<string>();
      for (const item of requirement[key]) {
        if (seen.has(item.key)) issue("BASELINE_KEY_DUPLICATE", "同一需求内的结构化键重复。", `baseline.requirements.${index}.${key}`, requirement.id, item.key);
        seen.add(item.key);
      }
    }
  }
  const plans = new Map(snapshot.plans.filter((plan) => plan.projectId === snapshot.projectId && isActiveDeliveryPlan(plan)).map((plan) => [plan.id, plan]));
  const diagrams = new Map(snapshot.diagrams.filter((diagram) => diagram.projectId === snapshot.projectId).map((diagram) => [diagram.id, diagram]));
  const mappingKeys = new Set<string>();
  const usableMappings: DesignContract["mappings"] = [];
  for (const [index, mapping] of contract.mappings.entries()) {
    const path = `mappings.${index}`;
    const issueCount = report.issues.length;
    const key = JSON.stringify([mapping.requirementId, mapping.planId]);
    if (mappingKeys.has(key)) issue("MAPPING_DUPLICATE", "同一需求/计划映射重复。", path, mapping.requirementId, mapping.planId);
    mappingKeys.add(key);
    const requirement = requirements.get(mapping.requirementId);
    if (!requirement) issue("REQUIREMENT_REFERENCE_DANGLING", "映射指向基线中不存在的需求。", path, mapping.requirementId);
    const plan = plans.get(mapping.planId);
    if (!plan) issue("PLAN_REFERENCE_DANGLING", "计划不存在、不属于项目或不再是有效交付任务。", path, mapping.planId);
    else {
      if (plan.title !== mapping.planTitle) issue("PLAN_LABEL_MISMATCH", "计划 ID 与摘要中的名称不一致。", path, plan.id);
      if (planScopeRevision(plan) !== mapping.planScopeRevision) issue("PLAN_SCOPE_STALE", "计划范围已变化，应重新确认映射。", path, plan.id);
      if (plan.diagramId !== mapping.diagramId || plan.diagramNodeId !== mapping.nodeId) issue("PLAN_NODE_MISMATCH", "计划没有绑定到所声明的节点。", path, plan.id, mapping.nodeId);
    }
    const node = diagrams.get(mapping.diagramId)?.nodes.find((item) => item.id === mapping.nodeId);
    if (!node) issue("NODE_REFERENCE_DANGLING", "节点不存在或不属于当前项目。", path, mapping.diagramId, mapping.nodeId);
    else if (node.label !== mapping.nodeLabel) issue("NODE_LABEL_MISMATCH", "节点 ID 与摘要中的名称不一致。", path, mapping.nodeId);
    resolveRevision(mapping.design, `${path}.design`, false);
    if (!snapshot.references.some((reference) => reference.projectId === snapshot.projectId
      && reference.documentId === mapping.design.documentId && reference.documentRevisionId === mapping.design.revisionId
      && reference.relationType === "defines"
      && ((reference.targetType === "plan" && reference.targetId === mapping.planId)
        || (reference.targetType === "diagramNode" && reference.targetId === mapping.nodeId)))) {
      issue("DESIGN_REFERENCE_UNBOUND", "设计修订未明确绑定该计划或节点。", `${path}.design`, mapping.planId, mapping.design.revisionId);
    }
    const criterionKeys = new Set<string>();
    for (const criterionKey of mapping.criterionKeys) {
      if (criterionKeys.has(criterionKey)) issue("CRITERION_DUPLICATE", "映射中的验收标准键重复。", path, criterionKey);
      criterionKeys.add(criterionKey);
      if (requirement && !requirement.criteria.some((criterion) => criterion.key === criterionKey)) issue("CRITERION_REFERENCE_DANGLING", "验收标准键不属于该基线需求。", path, mapping.requirementId, criterionKey);
    }
    const factKeys = new Set<string>();
    for (const fact of mapping.interfaces) {
      if (factKeys.has(fact.key)) issue("INTERFACE_DUPLICATE", "接口事实键重复。", path, fact.key);
      factKeys.add(fact.key);
      const expected = requirement?.interfaces.find((item) => item.key === fact.key);
      if (!expected) issue("INTERFACE_UNASSESSED", "基线没有对应的权威结构化接口事实，无法自动确认。", path, fact.key);
      else if (expected.method !== fact.method || expected.path !== fact.path) issue("INTERFACE_MISMATCH", `接口与批准基线不一致：应为 ${expected.method} ${expected.path}，设计为 ${fact.method} ${fact.path}。`, path, mapping.requirementId, fact.key);
    }
    if (report.issues.length === issueCount) usableMappings.push(mapping);
  }
  for (const requirement of baseline.requirements) {
    const mappings = usableMappings.filter((mapping) => mapping.requirementId === requirement.id);
    for (const criterion of requirement.criteria) {
      const matching = mappings.filter((mapping) => mapping.criterionKeys.includes(criterion.key));
      const planIds = matching.map((mapping) => mapping.planId);
      const covered = planIds.length > 0;
      // A passing record for another criterion, producer or implementation cannot fill this cell.
      const verifiedPlanIds = matching.filter((mapping) => snapshot.evidence.some((evidence) =>
        evidence.acceptanceCriterionKey === criterion.key
        && evidence.details.requirementId === requirement.id
        && evidence.details.requirementsBaselineRevisionId === contract.baseline.revisionId
        && matchesImplementationEvidencePolicy(evidence, plans.get(mapping.planId)!, { actorRole: "auditor" }))).map((mapping) => mapping.planId);
      const verified = covered && verifiedPlanIds.length === matching.length;
      report.coverage.push({ requirementId: requirement.id, criterionKey: criterion.key, planIds, verifiedPlanIds, covered, verified });
      if (!covered) issue("CRITERION_UNCOVERED", "基线验收标准没有有效的设计/计划映射。", "coverage", requirement.id, criterion.key);
    }
    for (const fact of requirement.interfaces) {
      if (!mappings.some((mapping) => mapping.interfaces.some((candidate) => candidate.key === fact.key))) issue("INTERFACE_UNCOVERED", "基线接口事实尚未映射到设计。", "coverage", requirement.id, fact.key);
    }
  }

  const graph = new Map<string, Set<string>>();
  const vertex = (planId: string, phase: string) => JSON.stringify([planId, phase]);
  const edge = (from: string, target: string) => { const neighbors = graph.get(from) ?? new Set<string>(); neighbors.add(target); graph.set(from, neighbors); };
  for (const plan of plans.values()) {
    for (let i = 1; i < DESIGN_PHASES.length; i++) edge(vertex(plan.id, DESIGN_PHASES[i]), vertex(plan.id, DESIGN_PHASES[i - 1]));
    for (const dependencyId of plan.dependencyIds) {
      if (!plans.has(dependencyId)) issue("DEPENDENCY_REFERENCE_DANGLING", "依赖不是当前项目的有效交付任务。", "dependencies", plan.id, dependencyId);
      else edge(vertex(plan.id, "build"), vertex(dependencyId, "acceptance"));
    }
    // Preserve the existing aggregate-parent semantics in the phase graph.
    if (plan.parentId && plans.has(plan.parentId)) edge(vertex(plan.parentId, "build"), vertex(plan.id, "acceptance"));
  }
  const waitKeys = new Set<string>();
  for (const [index, wait] of contract.waits.entries()) {
    const from = vertex(wait.from.planId, wait.from.phase);
    const to = vertex(wait.waitsFor.planId, wait.waitsFor.phase);
    const key = JSON.stringify([from, to]);
    if (waitKeys.has(key)) issue("WAIT_DUPLICATE", "阶段依赖重复。", `waits.${index}`, wait.from.planId, wait.waitsFor.planId);
    waitKeys.add(key);
    if (!plans.has(wait.from.planId) || !plans.has(wait.waitsFor.planId)) issue("WAIT_REFERENCE_DANGLING", "阶段依赖指向不存在的有效计划。", `waits.${index}`, wait.from.planId, wait.waitsFor.planId);
    else edge(from, to);
  }
  // Iterative DFS avoids recursion exhaustion on large declared graphs.
  const color = new Map<string, number>();
  for (const start of graph.keys()) {
    if (color.get(start)) continue;
    const stack: Array<{ id: string; remaining: Iterator<string> }> = [{ id: start, remaining: (graph.get(start) ?? new Set<string>()).values() }];
    color.set(start, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = frame.remaining.next();
      if (next.done) { color.set(frame.id, 2); stack.pop(); continue; }
      if (color.get(next.value) === 1) {
        const begin = stack.findIndex((item) => item.id === next.value);
        const cycle = [...stack.slice(begin).map((item) => item.id), next.value];
        report.cycles.push(cycle);
        issue("PHASE_DEPENDENCY_CYCLE", "存在开发/验证/验收阶段循环等待，必须修订设计，不能伪造证据或绕过门禁。", "waits", ...cycle);
      } else if (!color.get(next.value)) {
        color.set(next.value, 1);
        stack.push({ id: next.value, remaining: (graph.get(next.value) ?? new Set<string>()).values() });
      }
    }
  }
  const partialCodes = new Set(["BASELINE_PARTIAL", "BASELINE_NOT_APPROVED", "CONTRACT_NOT_APPROVED", "CRITERION_UNCOVERED", "INTERFACE_UNCOVERED", "INTERFACE_UNASSESSED"]);
  report.status = report.issues.some((item) => !partialCodes.has(item.code)) ? "invalid" : report.issues.length ? "partial" : "valid";
  return report;
}

/** Marker detection is only routing; schema validation remains authoritative. */
export function isDesignContractContent(content: string): boolean {
  const parsed = parseJson(content);
  return (typeof parsed === "object" && parsed !== null && "kind" in parsed && parsed.kind === "productdesign.design-contract")
    || /"kind"\s*:\s*"productdesign\.design-contract"/.test(content);
}

/** Only explicit governed document references activate checks. No migration, no guessed latest document. */
export function validateProjectDesignContract(store: Store, projectId: string, planId?: string): DesignContractReport {
  const plans = store.listPlans(projectId);
  const documents = store.listDesignDocs(projectId);
  const refs = store.listDocumentReferences({ projectId });
  const snapshot: DesignContractSnapshot = { projectId, plans, documents, diagrams: store.listDiagrams(projectId), revisions: [], evidence: store.listEvidence(projectId), references: refs };
  const candidates = refs.filter((ref) => ref.relationType === "defines"
    && ((ref.targetType === "project" && ref.targetId === projectId) || (planId && ref.targetType === "plan" && ref.targetId === planId)))
    .filter((ref) => {
      const current = documents.find((doc) => doc.id === ref.documentId);
      const frozen = store.getDocumentRevision(ref.documentRevisionId);
      return Boolean((current && isDesignContractContent(current.content)) || (frozen && isDesignContractContent(frozen.content)));
    });
  const unique = [...new Map(candidates.map((ref) => [`${ref.documentId}:${ref.documentRevisionId}`, ref])).values()];
  if (planId && !plans.some((plan) => plan.id === planId && isActiveDeliveryPlan(plan))) {
    const report = emptyReport(snapshot); report.status = "invalid";
    report.issues.push({ code: "PLAN_REFERENCE_DANGLING", message: "指定计划不是当前项目的有效交付任务。", path: "planId", entityIds: [planId] }); return report;
  }
  if (unique.length === 0) {
    // A deleted frozen revision is not evidence that this was a legacy/no-contract plan.
    // Fail closed on lost authority rather than inferring opt-out from missing contents.
    const dangling = plans.filter((plan) => (!planId || plan.id === planId) && isActiveDeliveryPlan(plan))
      .flatMap((plan) => plan.designRevisionIds.filter((id) => !store.getDocumentRevision(id)).map((revisionId) => ({ planId: plan.id, revisionId })));
    if (dangling.length) {
      const report = emptyReport(snapshot); report.status = "invalid";
      report.issues.push({ code: "FROZEN_DESIGN_REVISION_MISSING", message: "已提交设计基线的固定修订被删除或缺失；不能据此推断为未启用检查，请恢复依据或重新走设计变更。", path: "designRevisionIds", entityIds: dangling.flatMap((item) => [item.planId, item.revisionId]) });
      return report;
    }
    // Once a submitted plan froze a contract, removing its live reference must not
    // turn governed work back into legacy/unassessed work.
    const frozenContractPlans = plans.filter((plan) => (!planId || plan.id === planId) && isActiveDeliveryPlan(plan)
      && plan.designRevisionIds.some((id) => {
        const frozen = store.getDocumentRevision(id);
        return frozen && isDesignContractContent(frozen.content);
      }));
    if (frozenContractPlans.length > 0) {
      const report = emptyReport(snapshot); report.status = "invalid";
      report.issues.push({ code: "CONTRACT_REFERENCE_REMOVED", message: "已提交计划曾冻结结构化合同，但当前明确引用已丢失；不能退回未评估的旧流程。", path: "contractRef", entityIds: frozenContractPlans.map((plan) => plan.id) });
      return report;
    }
    return validateDesignContract(undefined, snapshot);
  }
  if (unique.length > 1) {
    const report = emptyReport(snapshot); report.status = "invalid";
    report.issues.push({ code: "CONTRACT_AMBIGUOUS", message: "存在多个显式合同修订，必须先明确唯一基线。", path: "contractRef", entityIds: unique.map((ref) => ref.documentRevisionId) }); return report;
  }
  const selected = unique[0];
  snapshot.contractRef = { documentId: selected.documentId, revisionId: selected.documentRevisionId };
  const revision = store.getDocumentRevision(selected.documentRevisionId);
  const input = revision ? parseJson(revision.content) : {};
  const parsed = designContractSchema.safeParse(input);
  const revisionIds = new Set([selected.documentRevisionId]);
  if (parsed.success) {
    revisionIds.add(parsed.data.baseline.revisionId);
    for (const mapping of parsed.data.mappings) revisionIds.add(mapping.design.revisionId);
  }
  snapshot.revisions = [...revisionIds].flatMap((id) => { const item = store.getDocumentRevision(id); return item ? [item] : []; });
  const report = validateDesignContract(input ?? {}, snapshot);
  if (planId && parsed.success && !parsed.data.mappings.some((mapping) => mapping.planId === planId)) {
    report.issues.push({ code: "PLAN_UNMAPPED", message: "该计划尚未映射到独立需求基线。", path: "mappings", entityIds: [planId] });
    if (report.status === "valid") report.status = "partial";
  }
  return report;
}

export function assertPlanDesignContract(store: Store, plan: PlanItem): void {
  const report = validateProjectDesignContract(store, plan.projectId, plan.id);
  if (report.status === "unassessed" || report.status === "valid") return;
  throw new DesignContractError("DESIGN_CONTRACT_INVALID", "结构化设计检查未通过：" + report.issues.map((item) => item.message).slice(0, 5).join("；"), report);
}

/** Opted-in acceptance requires a recorded auditor result for every criterion assigned
 * to this plan. Other plans' evidence neither substitutes nor delays this plan. */
export function assertPlanContractEvidence(store: Store, plan: PlanItem): void {
  assertPlanDesignContract(store, plan);
  const report = validateProjectDesignContract(store, plan.projectId, plan.id);
  if (report.status === "unassessed") return;
  const missing = report.coverage.filter((item) => item.planIds.includes(plan.id) && !item.verifiedPlanIds.includes(plan.id));
  if (missing.length === 0) return;
  throw new DesignContractError("DESIGN_CONTRACT_EVIDENCE_MISSING", "缺少当前计划各验收标准对应的独立审计记录：" + missing.map((item) => `${item.requirementId}/${item.criterionKey}`).join("、"), { planId: plan.id, missing, baselineRef: report.baselineRef });
}
