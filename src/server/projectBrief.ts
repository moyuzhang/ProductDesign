import type { DesignDoc, Evidence } from "../shared/types.js";
import type { Store } from "./db.js";

export const projectBriefTaskSuffix = (projectId: string) => `project-brief:${projectId}`;
export const isProjectBriefTask = (actionCode: string) =>
  ["prepare_project_brief", "audit_project_brief", "approve_project_brief"].includes(actionCode);

export function projectBriefDocument(store: Store, projectId: string): DesignDoc | null {
  const ids = new Set(store.listDocumentReferences({ projectId, targetType: "project", targetId: projectId })
    .filter((reference) => reference.relationType === "defines").map((reference) => reference.documentId));
  return store.listDesignDocs(projectId)
    .filter((document) => ids.has(document.id) && ["需求文档", "功能说明"].includes(document.category))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

export function isInitialProjectBriefApproval(store: Store, projectId: string, document: Pick<DesignDoc, "id" | "category">): boolean {
  if (!["需求文档", "功能说明"].includes(document.category)) return false;
  const references = store.listDocumentReferences({ projectId, targetType: "project", targetId: projectId })
    .filter((reference) => reference.relationType === "defines");
  const alreadyApproved = store.listDesignDocs(projectId).some((candidate) => candidate.status === "已批准"
    && ["需求文档", "功能说明"].includes(candidate.category)
    && references.some((reference) => reference.documentId === candidate.id
      && reference.documentRevisionId === candidate.currentRevisionId));
  return !alreadyApproved && (document.id === "" || references.some((reference) => reference.documentId === document.id));
}

interface CompletedLease {
  id: string;
  task_key: string;
  task_revision: string;
  worker_id: string;
  agent_id: string;
  result_digest: string;
  completed_at: string;
}

function completedLease(store: Store, projectId: string, taskId: string, revision?: string): CompletedLease | null {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_task_leases'").get()) return null;
  return (store.db.prepare(`SELECT id, task_key, task_revision, worker_id, agent_id, result_digest, completed_at
    FROM agent_task_leases WHERE project_id=? AND task_id=? AND status='completed'
      AND (?='' OR task_revision=?) ORDER BY completed_at DESC LIMIT 1`)
    .get(projectId, taskId, revision ?? "", revision ?? "") as CompletedLease | undefined) ?? null;
}

export function projectBriefProgress(store: Store, projectId: string) {
  const document = projectBriefDocument(store, projectId);
  const revisionId = document?.currentRevisionId ?? "";
  const suffix = projectBriefTaskSuffix(projectId);
  const design = revisionId ? completedLease(store, projectId, `design:${suffix}`) : null;
  const submitted = design?.result_digest === revisionId ? design : null;
  const audit = revisionId ? completedLease(store, projectId, `audit:${suffix}`, `audit_project_brief:${revisionId}`) : null;
  const evidence = audit?.result_digest ? store.getEvidence(audit.result_digest) : undefined;
  const audited = evidence?.projectId === projectId && evidence.documentRevisionId === revisionId
    && evidence.actorRole === "auditor" && evidence.details.auditScope === "design"
    && evidence.status === "active" && ["pass", "fail"].includes(evidence.resultStatus) ? evidence : null;
  const approval = revisionId ? completedLease(store, projectId, `approval:${suffix}`, `approve_project_brief:${revisionId}`) : null;
  return { document, revisionId, design: submitted, audit: audited ? audit : null,
    evidence: audited as Evidence | null, approval,
    stage: !submitted || audited?.resultStatus === "fail" || approval?.result_digest.startsWith("rejected:")
      ? "design" as const : !audited ? "audit" as const : "approval" as const };
}
