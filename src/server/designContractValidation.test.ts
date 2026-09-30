import { claimAgentTask } from "./agentTaskLeases.js";
import { buildApp } from "./index.js";
import { LocalMcpClient, mcpResultText } from "./localMcpClient.js";
import { createMcpServer } from "../mcp/index.js";
import { transitionPlanLifecycle } from "./planLifecycle.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db.js";
import type { DesignContract, RequirementsBaseline } from "../shared/designContract.js";
import { assertPlanContractEvidence, assertPlanDesignContract, planScopeRevision, validateDesignContract, validateProjectDesignContract,
  type DesignContractSnapshot } from "./designContractValidation.js";

const resources: Array<{ store: Store; dir: string }> = [];
afterEach(() => { for (const { store, dir } of resources.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }); } });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "design-contract-"));
  const store = new Store(join(dir, "test.db")); resources.push({ store, dir });
  const project = store.insertProject({ code: "CONTRACT", name: "Contract", summary: "", stage: "设计", health: "正常", progress: 0,
    riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "" });
  const diagram = store.insertDiagram({ projectId: project.id, title: "Features", type: "functional", nodes: [
    { id: "config-node", kind: "feature", label: "Configuration", x: 0, y: 0 },
    { id: "txt-node", kind: "feature", label: "TXT", x: 100, y: 0 },
  ], edges: [], groups: [] });
  const roleAssignments = { designer: { agentId: "designer", displayName: "Designer" }, builder: { agentId: "builder", displayName: "Builder" }, auditor: { agentId: "auditor", displayName: "Auditor" } };
  const config = store.insertPlan({ projectId: project.id, diagramId: diagram.id, diagramNodeId: "config-node", parentId: null,
    kind: "task", title: "Configuration", description: "Settings", status: "未开始", priority: "P2", progress: 0, owner: "builder", roleAssignments,
    versionTag: "", startAt: "", dueAt: "", dependencyIds: [] });
  const txt = store.insertPlan({ ...config, id: undefined, diagramNodeId: "txt-node", title: "TXT", dependencyIds: [config.id] });
  const baseline: RequirementsBaseline = { kind: "productdesign.requirements-baseline", schemaVersion: 1, projectId: project.id, inventoryStatus: "reviewed",
    requirements: [
      { id: "REQ-CONFIG", statement: "Configuration must preserve base settings", criteria: [{ key: "settings", statement: "Read baseline settings" }, { key: "defaults", statement: "Preserve defaults" }], interfaces: [{ key: "read-config", method: "GET", path: "/api/config" }] },
      { id: "REQ-TXT", statement: "Produce TXT", criteria: [{ key: "export", statement: "Produce real TXT output" }], interfaces: [] },
    ] };
  const doc = (title: string, content: string) => store.insertDesignDoc({ projectId: project.id, title, category: "需求文档", summary: "", status: "已批准", version: "1", author: "reviewer", content });
  const baselineDoc = doc("Independent baseline", JSON.stringify(baseline));
  const design = doc("Design", "Reviewed detailed design");
  for (const plan of [config, txt]) store.insertDocumentReference({ projectId: project.id, documentId: design.id, targetType: "plan", targetId: plan.id, relationType: "defines" });
  const contract: DesignContract = { kind: "productdesign.design-contract", schemaVersion: 1, projectId: project.id,
    baseline: { documentId: baselineDoc.id, revisionId: baselineDoc.currentRevisionId }, mappings: [
      { requirementId: "REQ-CONFIG", planId: config.id, planTitle: config.title, planScopeRevision: planScopeRevision(config), diagramId: diagram.id, nodeId: "config-node", nodeLabel: "Configuration",
        design: { documentId: design.id, revisionId: design.currentRevisionId }, criterionKeys: ["settings", "defaults"], interfaces: [{ key: "read-config", method: "GET", path: "/api/config" }] },
      { requirementId: "REQ-TXT", planId: txt.id, planTitle: txt.title, planScopeRevision: planScopeRevision(txt), diagramId: diagram.id, nodeId: "txt-node", nodeLabel: "TXT",
        design: { documentId: design.id, revisionId: design.currentRevisionId }, criterionKeys: ["export"], interfaces: [] },
    ], waits: [] };
  const snapshot = (): DesignContractSnapshot => ({ projectId: project.id, plans: store.listPlans(project.id), diagrams: store.listDiagrams(project.id), documents: store.listDesignDocs(project.id),
    revisions: [store.getDocumentRevision(baselineDoc.currentRevisionId)!, store.getDocumentRevision(design.currentRevisionId)!], evidence: store.listEvidence(project.id), references: store.listDocumentReferences({ projectId: project.id }) });
  const publish = (input: unknown = contract) => {
    const artifact = doc("Structured contract", JSON.stringify(input));
    store.insertDocumentReference({ projectId: project.id, documentId: artifact.id, targetType: "project", targetId: project.id, relationType: "defines" }); return artifact;
  };
  return { store, dir, project, diagram, config, txt, baseline, baselineDoc, design, contract, snapshot, publish };
}
const codes = (report: ReturnType<typeof validateDesignContract>) => report.issues.map((issue) => issue.code);

describe("structured design contracts", () => {
  it("keeps legacy projects unassessed and never infers a baseline from complete plans", () => {
    const f = setup();
    expect(validateProjectDesignContract(f.store, f.project.id).status).toBe("unassessed");
    expect(() => assertPlanDesignContract(f.store, f.config)).not.toThrow();
    expect(() => assertPlanContractEvidence(f.store, f.config)).not.toThrow();
  });
  it("reads explicit governed artifacts and returns authoritative plan identities", () => {
    const f = setup(); f.publish();
    const report = validateProjectDesignContract(f.store, f.project.id, f.config.id);
    expect(report.status).toBe("valid");
    expect(report.coverage).toHaveLength(3);
    expect(report.coverage.every((item) => item.covered && !item.verified)).toBe(true);
    expect(report.plans.find((plan) => plan.id === f.config.id)?.scopeRevision).toBe(planScopeRevision(f.config));
  });
  it("detects lost baseline requirements and per-criterion holes after splitting", () => {
    const f = setup(); f.contract.mappings = [f.contract.mappings[0]]; f.contract.mappings[0].criterionKeys = ["settings"];
    const report = validateDesignContract(f.contract, f.snapshot());
    expect(report.status).toBe("partial");
    expect(report.coverage.filter((item) => !item.covered).map((item) => item.criterionKey)).toEqual(["defaults", "export"]);
  });
  it("rejects a valid but swapped plan ID and its misleading summary", () => {
    const f = setup(); f.contract.mappings[0].planId = f.txt.id;
    expect(codes(validateDesignContract(f.contract, f.snapshot()))).toEqual(expect.arrayContaining(["PLAN_LABEL_MISMATCH", "PLAN_SCOPE_STALE", "PLAN_NODE_MISMATCH"]));
  });
  it("detects explicit GET versus drafted POST without inferring from prose", () => {
    const f = setup(); f.contract.mappings[0].interfaces[0].method = "POST";
    expect(codes(validateDesignContract(f.contract, f.snapshot()))).toContain("INTERFACE_MISMATCH");
  });
  it("detects configuration acceptance waiting for TXT whose build waits for config acceptance", () => {
    const f = setup(); f.contract.waits.push({ from: { planId: f.config.id, phase: "acceptance" }, waitsFor: { planId: f.txt.id, phase: "verification" }, reason: "Needs actual TXT artifact" });
    const report = validateDesignContract(f.contract, f.snapshot());
    expect(report.status).toBe("invalid"); expect(codes(report)).toContain("PHASE_DEPENDENCY_CYCLE");
    expect(report.cycles[0]).toContain(JSON.stringify([f.config.id, "acceptance"]));
    expect(report.cycles[0]).toContain(JSON.stringify([f.txt.id, "build"]));
  });
  it("allows acyclic downstream verification without relaxing upstream dependencies", () => {
    const f = setup(); f.contract.waits.push({ from: { planId: f.txt.id, phase: "verification" }, waitsFor: { planId: f.config.id, phase: "build" }, reason: "Read built config" });
    expect(validateDesignContract(f.contract, f.snapshot()).status).toBe("valid");
  });
  it("rejects stale revisions and unbound design documents", () => {
    const f = setup(); f.store.updateDesignDoc(f.design.id, { content: "Changed design" });
    expect(codes(validateDesignContract(f.contract, f.snapshot()))).toContain("DOCUMENT_REFERENCE_STALE");
    const snapshot = f.snapshot(); snapshot.references = [];
    expect(codes(validateDesignContract(f.contract, snapshot))).toContain("DESIGN_REFERENCE_UNBOUND");
  });
  it("rejects scope drift but not lifecycle timestamp changes", () => {
    const f = setup(); f.store.updatePlan(f.config.id, { status: "进行中", updatedAt: "later" });
    expect(validateDesignContract(f.contract, f.snapshot()).status).toBe("valid");
    f.store.updatePlan(f.config.id, { description: "Changed deliverable" });
    expect(codes(validateDesignContract(f.contract, f.snapshot()))).toContain("PLAN_SCOPE_STALE");
  });
  it("rejects duplicate, dangling, and cross-project references", () => {
    const f = setup(); f.contract.mappings.push(f.contract.mappings[0]);
    f.contract.waits.push({ from: { planId: "missing", phase: "build" }, waitsFor: { planId: f.config.id, phase: "acceptance" }, reason: "Unknown" });
    f.contract.projectId = "another-project";
    expect(codes(validateDesignContract(f.contract, f.snapshot()))).toEqual(expect.arrayContaining(["MAPPING_DUPLICATE", "WAIT_REFERENCE_DANGLING", "PROJECT_MISMATCH"]));
  });
  it("cannot call an incomplete or unapproved baseline complete", () => {
    const f = setup(); const snapshot = f.snapshot();
    snapshot.revisions[0] = { ...snapshot.revisions[0], content: JSON.stringify({ ...f.baseline, inventoryStatus: "partial" }), status: "草拟" };
    const report = validateDesignContract(f.contract, snapshot);
    expect(report.status).toBe("partial"); expect(codes(report)).toEqual(expect.arrayContaining(["BASELINE_PARTIAL", "BASELINE_NOT_APPROVED"]));
  });
  it("does not accept one passing record as coverage for every criterion", () => {
    const f = setup(); f.store.updatePlan(f.config.id, { implementationRevision: "sha1" });
    f.store.insertEvidence({ projectId: f.project.id, nodeId: f.config.diagramNodeId, planItemId: f.config.id, sourceType: "manual", sourcePath: "test.json", command: "test", resultStatus: "pass", summary: "Settings pass",
      details: { auditScope: "implementation", implementationRevision: "sha1", requirementId: "REQ-CONFIG", requirementsBaselineRevisionId: f.baselineDoc.currentRevisionId },
      commitSha: "sha1", digest: "x", collectedAt: "2026-09-30", actorRole: "auditor", agentId: "auditor", acceptanceCriterionKey: "settings" });
    f.publish();
    const report = validateDesignContract(f.contract, f.snapshot());
    expect(() => assertPlanContractEvidence(f.store, f.store.getPlan(f.config.id)!)).toThrow("REQ-CONFIG/defaults");
    expect(report.coverage.find((item) => item.criterionKey === "settings")?.verified).toBe(true);
    expect(report.coverage.find((item) => item.criterionKey === "defaults")?.verified).toBe(false);
    const first = f.store.listEvidence(f.project.id)[0];
    f.store.insertEvidence({ ...first, id: undefined, acceptanceCriterionKey: "defaults" });
    expect(() => assertPlanContractEvidence(f.store, f.store.getPlan(f.config.id)!)).not.toThrow();
    expect(() => assertPlanContractEvidence(f.store, f.store.getPlan(f.txt.id)!)).toThrow("REQ-TXT/export");
    const wrong = f.snapshot(); for (const evidence of wrong.evidence) evidence.details.requirementsBaselineRevisionId = "old";
    expect(validateDesignContract(f.contract, wrong).coverage.every((item) => !item.verified)).toBe(true);
  });
  it("does not drop a previously frozen contract back to legacy after its live reference is removed", () => {
    const f = setup(); const artifact = f.publish();
    f.store.updatePlan(f.config.id, { designRevisionIds: [artifact.currentRevisionId] });
    for (const reference of f.store.listDocumentReferences({ projectId: f.project.id, documentId: artifact.id })) f.store.deleteDocumentReference(reference.id);
    const report = validateProjectDesignContract(f.store, f.project.id, f.config.id);
    expect(report.status).toBe("invalid"); expect(codes(report)).toContain("CONTRACT_REFERENCE_REMOVED");
    expect(() => assertPlanContractEvidence(f.store, f.store.getPlan(f.config.id)!)).toThrow();
  });
  it("shows a contract draft as partial until independently approved", () => {
    const f = setup(); const artifact = f.publish();
    const draft = f.store.updateDesignDoc(artifact.id, { status: "草拟" })!;
    const reference = f.store.listDocumentReferences({ projectId: f.project.id, documentId: artifact.id })[0];
    f.store.updateDocumentReferenceRevision(reference.id, draft.currentRevisionId);
    const report = validateProjectDesignContract(f.store, f.project.id);
    expect(report.status).toBe("partial"); expect(codes(report)).toContain("CONTRACT_NOT_APPROVED");
  });
  it("does not silently select the latest among ambiguous contracts", () => {
    const f = setup(); f.publish(); f.publish();
    expect(codes(validateProjectDesignContract(f.store, f.project.id))).toContain("CONTRACT_AMBIGUOUS");
  });
  it("blocks opted-in partial submissions but does not mutate plans", () => {
    const f = setup(); f.contract.mappings = []; f.publish(); const before = f.store.getPlan(f.config.id);
    expect(() => assertPlanDesignContract(f.store, f.config)).toThrow("结构化设计检查未通过");
    expect(f.store.getPlan(f.config.id)).toEqual(before);
  });
  it("treats malformed recognized artifacts as invalid, never as legacy", () => {
    const f = setup(); const artifact = f.publish();
    const changed = f.store.updateDesignDoc(artifact.id, { content: '{"kind":"productdesign.design-contract",broken' })!;
    f.store.insertDocumentReference({ projectId: f.project.id, documentId: artifact.id, documentRevisionId: changed.currentRevisionId, targetType: "project", targetId: f.project.id, relationType: "defines" });
    expect(validateProjectDesignContract(f.store, f.project.id).status).toBe("invalid");
  });
});


describe("design contract integration", () => {
  it("revalidates every sibling's exact criterion evidence before accepting a node", () => {
    const f = setup();
    const sibling = f.store.updatePlan(f.txt.id, { diagramNodeId: f.config.diagramNodeId })!;
    f.contract.mappings[1] = { ...f.contract.mappings[1], nodeId: "config-node", nodeLabel: "Configuration", planScopeRevision: planScopeRevision(sibling) };
    const artifact = f.publish();
    for (const plan of [f.config, sibling]) f.store.updatePlan(plan.id, { lifecycleStatus: "accepted", auditStatus: "passed", managerDecision: "approved", implementationRevision: "sha1", designRevisionIds: [f.design.currentRevisionId, artifact.currentRevisionId] });
    for (const [plan, requirementId, criterion] of [[f.config, "REQ-CONFIG", "settings"], [sibling, "REQ-TXT", "export"]] as const) {
      f.store.insertEvidence({ projectId: f.project.id, nodeId: "config-node", planItemId: plan.id, sourceType: "manual", sourcePath: "fixture.json", command: "test", resultStatus: "pass", summary: "Fixture audit", details: { auditScope: "implementation", implementationRevision: "sha1", requirementId, requirementsBaselineRevisionId: f.baselineDoc.currentRevisionId }, commitSha: "sha1", digest: criterion, collectedAt: new Date().toISOString(), actorRole: "auditor", agentId: "auditor", acceptanceCriterionKey: criterion });
    }
    expect(() => transitionPlanLifecycle(f.store, sibling.id, { action: "accept_node", actor: "Main Agent", agentId: "Main Agent" })).toThrow("REQ-CONFIG/defaults");
  });

  it("cannot opt out by deleting a frozen contract and its revision history", () => {
    const f = setup(); const artifact = f.publish();
    f.store.updatePlan(f.config.id, { designRevisionIds: [f.design.currentRevisionId, artifact.currentRevisionId] });
    f.store.deleteDesignDoc(artifact.id);
    const report = validateProjectDesignContract(f.store, f.project.id, f.config.id);
    expect(report.status).toBe("invalid"); expect(report.issues.some((item) => item.code === "FROZEN_DESIGN_REVISION_MISSING")).toBe(true);
    expect(() => assertPlanDesignContract(f.store, f.store.getPlan(f.config.id)!)).toThrow("固定修订被删除");
  });

  it("serves authoritative schemas and findings through real read-only REST and MCP", async () => {
    const f = setup(); f.publish();
    const app = buildApp({ dbPath: join(f.dir, "test.db"), dataDir: f.dir });
    await app.ready();
    const before = f.store.listAudit().length;
    const client = await LocalMcpClient.connect(() => createMcpServer({ store: f.store, dataDir: f.dir, trustedInternal: true }));
    try {
      const response = await app.inject({ method: "GET", url: `/api/projects/${f.project.id}/design-contract-validation?planId=${f.config.id}` });
      expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ status: "valid", scope: "declared-structured-requirements-only" });
      expect(response.json().artifactSchemas.baseline.properties.kind.const).toBe("productdesign.requirements-baseline");
      const text = mcpResultText(await client.callTool("validate_design_contract", { projectRef: f.project.id, planId: f.config.id, includeSchemas: false }));
      expect(text).toContain('"valid"'); expect(text).toContain(f.config.id);
      expect(f.store.listAudit()).toHaveLength(before);
      const invalid = await app.inject({ method: "GET", url: `/api/projects/${f.project.id}/design-contract-validation?planId=another-project-plan` });
      expect(invalid.statusCode).toBe(404);
    } finally { await client.close(); await app.close(); }
  });
  it("blocks incomplete mappings at the actual REST submission gate without advancing plan", async () => {
    const f = setup();
    f.store.updateProject(f.project.id, { summary: "Independent requirements baseline" });
    f.store.updateDiagram(f.diagram.id, { nodes: f.diagram.nodes.map((node) => ({ ...node, description: "Reviewed scope", owner: "team", acceptanceCriteria: "Named criteria", requirementStatus: "已批准", designStatus: "已批准" })) });
    for (const plan of [f.config, f.txt]) f.store.insertDocumentReference({ projectId: f.project.id, documentId: f.design.id, targetType: "diagramNode", targetId: plan.diagramNodeId!, relationType: "defines" });
    f.contract.mappings[0].criterionKeys = ["settings"]; f.publish();
    const app = buildApp({ dbPath: join(f.dir, "test.db"), dataDir: f.dir, trustedInternalApi: true });
    try {
      await app.ready();
      const lease = claimAgentTask(f.store, { projectId: f.project.id, taskId: `design:${f.config.id}`, role: "designer", agentId: "designer", workerId: "contract-test-designer", idempotencyKey: "contract-test-claim" });
      const response = await app.inject({ method: "POST", url: `/api/plans/${f.config.id}/transition`, payload: { action: "submit_plan", actor: "designer", agentId: "designer", leaseToken: lease.leaseToken } });
      expect(response.statusCode).toBe(409); expect(response.json().code).toBe("DESIGN_CONTRACT_INVALID");
      expect(response.json().details.issues.some((item: { code: string }) => item.code === "CRITERION_UNCOVERED")).toBe(true);
      expect(f.store.getPlan(f.config.id)?.submittedAt).toBe("");
    } finally { await app.close(); }
  });
  it("freezes the governed project contract and requires fresh design audit after it changes", () => {
    const f = setup(); const artifact = f.publish();
    const submitted = transitionPlanLifecycle(f.store, f.config.id, { action: "submit_plan", actor: "designer", agentId: "designer" });
    expect(submitted.designRevisionIds).toContain(artifact.currentRevisionId);
    const updated = f.store.updateDesignDoc(artifact.id, { version: "2", content: JSON.stringify(f.contract, null, 2) })!;
    const ref = f.store.listDocumentReferences({ projectId: f.project.id, documentId: artifact.id })[0];
    f.store.updateDocumentReferenceRevision(ref.id, updated.currentRevisionId);
    expect(() => transitionPlanLifecycle(f.store, f.config.id, { action: "pass_design_audit", actor: "auditor", agentId: "auditor" })).toThrow("合同已变化");
  });
  it("requires each mapped criterion at the real implementation audit gate", () => {
    const f = setup(); const artifact = f.publish();
    f.store.updatePlan(f.config.id, { lifecycleStatus: "pending_audit", implementationRevision: "sha1", designRevisionIds: [f.design.currentRevisionId, artifact.currentRevisionId] });
    const record = (criterion: string) => f.store.insertEvidence({ projectId: f.project.id, nodeId: f.config.diagramNodeId, planItemId: f.config.id,
      sourceType: "manual", sourcePath: "fixture.json", command: "test", resultStatus: "pass", summary: "Fixture audit", details: { auditScope: "implementation", implementationRevision: "sha1", requirementId: "REQ-CONFIG", requirementsBaselineRevisionId: f.baselineDoc.currentRevisionId },
      commitSha: "sha1", digest: criterion, collectedAt: new Date().toISOString(), actorRole: "auditor", agentId: "auditor", acceptanceCriterionKey: criterion });
    record("settings");
    expect(() => transitionPlanLifecycle(f.store, f.config.id, { action: "pass_audit", actor: "auditor", agentId: "auditor" })).toThrow("REQ-CONFIG/defaults");
    record("defaults");
    expect(transitionPlanLifecycle(f.store, f.config.id, { action: "pass_audit", actor: "auditor", agentId: "auditor" }).lifecycleStatus).toBe("pending_manager");
  });
});
