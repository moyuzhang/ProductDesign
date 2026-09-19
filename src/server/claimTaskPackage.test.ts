import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { claimTaskPackage } from "./claimTaskPackage.js";
import { listClaimableAgentTasks, releaseAgentTask, startAgentTask } from "./agentTaskLeases.js";
import * as orchestration from "./orchestration.js";

const resources: Array<{ store: Store; dir: string }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, dir } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-atomic-package-"));
  const store = new Store(join(dir, "test.db"));
  resources.push({ store, dir });
  const project = store.insertProject({
    code: "ATOMIC", name: "Atomic claim", summary: "Claim rollback", stage: "设计", health: "正常",
    progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "",
    repositoryPath: dir, startAt: "", dueAt: "",
  });
  const brief = store.insertDesignDoc({
    projectId: project.id, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
    version: "1", author: "manager", content: "Atomic claims",
  });
  store.insertDocumentReference({
    projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines",
  });
  const main = store.listDiagrams(project.id).find((item) => item.type === "main")!;
  store.updateDiagram(main.id, { nodes: [...main.nodes, {
    id: "atomic-node", kind: "feature", label: "Atomic", description: "Claim rollback", owner: "designer",
    acceptanceCriteria: "Failed response leaves no claim", requirementStatus: "已批准", designStatus: "进行中",
    developmentStatus: "未开发", acceptanceStatus: "未验收", x: 600, y: 160,
  }] });
  const task = listClaimableAgentTasks(store, project.id).find((item) => item.nodeId === "atomic-node")!;
  const input = {
    projectId: project.id, role: "designer" as const, agentId: task.assignee!.agentId,
    workerId: "atomic-worker", idempotencyKey: "atomic-request",
  };
  return { store, dir, project, input };
}

function counts(store: Store) {
  return ["agent_task_leases", "agent_task_workspace_reservations", "agent_runner_registrations", "agent_task_lease_idempotency"]
    .map((table) => store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get());
}

describe("atomic claim and task package", () => {
  it("reuses one orchestration snapshot for atomic claim and package generation", () => {
    const { store, input } = fixture();
    const build = vi.spyOn(orchestration, "buildAgentOrchestration");
    const taskPackage = JSON.parse(claimTaskPackage(store, input));
    expect(build).toHaveBeenCalledTimes(1);
    expect(taskPackage.workflowPolicyVersion).toBe("1.1.0");
    expect(taskPackage.agentSecurityPolicyVersion).toBe("2.3.0");
  });

  it("rolls back the lease, reservations, runner and idempotency cache when package validation fails", () => {
    const { store, dir, project, input } = fixture();
    const before = counts(store);
    store.updateProject(project.id, { repositoryPath: join(dir, "missing") });
    expect(() => claimTaskPackage(store, input)).toThrow(expect.objectContaining({ code: "WORKING_DIRECTORY_NOT_READY" }));
    expect(counts(store)).toEqual(before);
    store.updateProject(project.id, { repositoryPath: dir });
    expect(JSON.parse(claimTaskPackage(store, input)).lease.status).toBe("claimed");
  });

  it("rolls back even when JSON serialization fails after the package was built", () => {
    const { store, input } = fixture();
    const before = counts(store);
    const build = orchestration.buildAgentTaskPackage;
    vi.spyOn(orchestration, "buildAgentTaskPackage").mockImplementationOnce((...args) => {
      const payload = build(...args);
      Object.defineProperty(payload, "toJSON", { value: () => { throw new Error("wire serialization failed"); } });
      return payload;
    });
    expect(() => claimTaskPackage(store, input)).toThrow("wire serialization failed");
    expect(counts(store)).toEqual(before);
    expect(JSON.parse(claimTaskPackage(store, input)).lease.status).toBe("claimed");
  });

  it("recovers a lost response with omitted optional IDs and returns the current running lease", () => {
    const { store, input } = fixture();
    const first = JSON.parse(claimTaskPackage(store, input));
    const before = counts(store);
    startAgentTask(store, { leaseToken: first.lease.leaseToken, agentId: input.agentId, idempotencyKey: "start" });
    const retry = JSON.parse(claimTaskPackage(store, input));
    expect(retry.lease).toMatchObject({
      workOrderId: first.lease.workOrderId, leaseToken: first.lease.leaseToken,
      sessionId: first.lease.sessionId, runId: first.lease.runId, status: "running",
    });
    expect(counts(store).slice(0, 3)).toEqual(before.slice(0, 3));
    expect(() => claimTaskPackage(store, { ...input, workerId: "other-worker" }))
      .toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  it("does not return a released lease or replace another worker's claim on replay", () => {
    const { store, input } = fixture();
    const first = JSON.parse(claimTaskPackage(store, input));
    releaseAgentTask(store, { leaseToken: first.lease.leaseToken, agentId: input.agentId, idempotencyKey: "release" });
    expect(() => claimTaskPackage(store, input)).toThrow(expect.objectContaining({ code: "LEASE_LOST" }));
    const replacement = JSON.parse(claimTaskPackage(store, { ...input, workerId: "replacement", idempotencyKey: "new-claim" }));
    expect(() => claimTaskPackage(store, input)).toThrow(expect.objectContaining({ code: "LEASE_LOST" }));
    expect(replacement.lease.workOrderId).not.toBe(first.lease.workOrderId);
  });
});
