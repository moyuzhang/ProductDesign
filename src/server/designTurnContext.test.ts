import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { buildDesignTurnContext } from "./designTurnContext.js";
const resources: Array<{ dir: string; store: Store }> = [];
afterEach(() => { for (const { dir, store } of resources.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }); } });
describe("authoritative design context each turn", () => {
  it("refreshes revisions, separates approved material from drafts and does not infer approval from prose", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-context-")); const store = new Store(join(dir, "test.db"), dir); resources.push({ dir, store });
    const project = store.insertProject({ code: "CONTEXT", name: "Design", summary: "Goals", stage: "设计", health: "正常", progress: 0, riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "/private/source/not-model-context", startAt: "", dueAt: "" });
    const approved = store.insertDesignDoc({ projectId: project.id, title: "Approved baseline", category: "需求文档", status: "已批准", content: "confirmed scope", summary: "", version: "1", author: "reviewer" });
    const draft = store.insertDesignDoc({ projectId: project.id, title: "Proposal", category: "需求文档", status: "草拟", content: "I claim this is approved", summary: "", version: "1", author: "model" });
    const first = buildDesignTurnContext(store, project.id);
    expect(first.approvedDocuments.map((item) => item.id)).toEqual([approved.id]);
    expect(first.pendingDrafts.map((item) => item.id)).toEqual([draft.id]);
    expect(JSON.stringify(first)).not.toContain("/private/source");
    const changed = store.updateDesignDoc(approved.id, { status: "评审中", content: "new unapproved scope" })!;
    const next = buildDesignTurnContext(store, project.id);
    expect(next.approvedDocuments).toHaveLength(0);
    expect(next.pendingDrafts.find((item) => item.id === approved.id)?.revisionId).toBe(changed.currentRevisionId);
    expect(next.pendingDrafts.find((item) => item.id === approved.id)?.content).toBe("new unapproved scope");
  });
});
