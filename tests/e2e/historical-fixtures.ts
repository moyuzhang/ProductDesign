import { randomUUID } from "node:crypto";
import { expect, test as base, type APIRequestContext } from "@playwright/test";

export interface HistoricalFixture {
  projectId: string;
  diagramId: string;
  nodeId: string;
  createPlan: (dependencyIds?: string[]) => Promise<{
    id: string; title: string; diagramId: string; diagramNodeId: string;
    roleAssignments: Record<"designer" | "builder" | "auditor", { agentId: string; displayName: string }>;
  }>;
}

async function workflow(request: APIRequestContext, projectId: string) {
  const response = await request.get(`/api/projects/${projectId}/workflow`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

// Public API fixtures only: assignment labels are draft identities, never credentials or approvals.
export const test = base.extend<{ historicalProject: HistoricalFixture }>({
  historicalProject: async ({ request }, use) => {
    const suffix = randomUUID();
    const response = await request.post("/api/projects", { data: {
      code: `E2E_HISTORY_${suffix}`, name: "独立布局与导航回归", summary: "Synthetic draft UI fixture", stage: "规划", health: "正常",
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const projectId = (await response.json()).id as string;
    try {
      await workflow(request, projectId);
      const nodes = [
        { id: "navigation", label: "Agent 页面上下文与实时同步", x: 180, y: 140 },
        { id: "routing", label: "路由定义", x: 700, y: 140 },
        { id: "layers", label: "图层定义", x: 180, y: 480 },
        { id: "delivery", label: "交付定义", x: 700, y: 480 },
      ].map((node) => ({ ...node, kind: "feature", shape: "rect", w: 220, h: 90, owner: "Synthetic reviewer", acceptanceCriteria: "可展示独立草稿节点", developmentStatus: "未开发", acceptanceStatus: "未验收" }));
      const edges = [
        { id: "edge-routing-layers", from: "navigation", to: "delivery", sourcePort: "right", targetPort: "left" },
        { id: "edge-top", from: "navigation", to: "routing" },
        { id: "edge-left", from: "navigation", to: "layers" },
        { id: "edge-right", from: "routing", to: "delivery" },
        { id: "edge-bottom", from: "layers", to: "delivery" },
        { id: "edge-cross", from: "routing", to: "layers" },
      ].map((edge) => ({ ...edge, style: "ortho" }));
      const diagramResponse = await request.post("/api/diagrams", { data: { projectId, title: "独立交付草稿", type: "functional", nodes, edges } });
      expect(diagramResponse.ok(), await diagramResponse.text()).toBeTruthy();
      const diagramId = (await diagramResponse.json()).id as string;
      await workflow(request, projectId);
      let planNumber = 0;
      await use({ projectId, diagramId, nodeId: "navigation", createPlan: async (dependencyIds = []) => {
        await workflow(request, projectId);
        const planResponse = await request.post("/api/plans", { data: {
          projectId, diagramId, diagramNodeId: "navigation", kind: "task", title: `独立计划详情 ${++planNumber}`,
          status: "未开始", progress: 0, dependencyIds,
          roleAssignments: {
            designer: { agentId: `designer-${suffix}`, displayName: "ProductDesign Designer（方案 B）" },
            builder: { agentId: `builder-${suffix}`, displayName: "Codex Builder" },
            auditor: { agentId: `auditor-${suffix}`, displayName: "Codex Auditor（独立审计 Agent）" },
          },
        } });
        expect(planResponse.ok(), await planResponse.text()).toBeTruthy();
        const plan = await planResponse.json();
        expect(plan.status).toBe("未开始"); expect(plan.lifecycleStatus).toBe("draft");
        await workflow(request, projectId);
        return plan;
      } });
    } finally {
      try {
        await workflow(request, projectId);
      } finally {
        const removed = await request.delete(`/api/projects/${projectId}`);
        expect(removed.ok(), await removed.text()).toBeTruthy();
        expect((await request.get(`/api/projects/${projectId}/workflow`)).status()).toBe(404);
      }
    }
  },
});
export { expect };
