import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "./db.js";
import { requirementChangeSource } from "./nodeRequirementRevision.js";

it("只给交付画布的正式变更节点派需求修订", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcs-requirement-types-"));
  const store = new Store(join(dir, "test.db"), dir);
  try {
    const project = store.insertProject({ code: "REQ-TYPES", name: "画布类型门禁", summary: "", stage: "设计",
      health: "正常", progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "",
      repositoryPath: dir, startAt: "", dueAt: "" });
    store.db.exec(`CREATE TABLE design_change_requests (idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
      change_id TEXT NOT NULL UNIQUE, response_json TEXT NOT NULL, created_at TEXT NOT NULL)`);
    for (const [index, type] of ["functional", "deployment", "flow", "free"].entries()) {
      const changeId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const node = { id: `node-${index}`, kind: "feature" as const, label: "Profile", description: "旧需求",
        owner: "team", acceptanceCriteria: "旧验收", requirementStatus: "草拟中" as const,
        blockedReason: `设计变更处理中 · ${changeId}`, x: 100, y: 100 };
      const diagram = store.insertDiagram({ projectId: project.id, title: `子画布 ${type}`,
        type: type as "functional" | "deployment" | "flow" | "free", nodes: [node], edges: [] });
      store.insertGovernance({ id: changeId, projectId: project.id, type: "decision", title: "正式变更",
        content: JSON.stringify({ diagramId: diagram.id, nodeId: node.id, requirementImpact: true }),
        rationale: "旧需求错误", status: "有效", author: "Main Agent" });
      store.db.prepare("INSERT INTO design_change_requests VALUES (?, ?, ?, ?, ?)").run(`formal-${index}`, "digest", changeId,
        JSON.stringify({ changeId, projectId: project.id, diagramId: diagram.id, nodeId: node.id }), new Date().toISOString());
      expect(requirementChangeSource(store, diagram, node), type)
        .toBe(["functional", "deployment"].includes(type) ? changeId : null);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
