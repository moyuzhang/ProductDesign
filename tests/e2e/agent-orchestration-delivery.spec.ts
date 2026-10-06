import { expect, test, type APIRequestContext } from "@playwright/test";
import { createGovernedProject } from "./helpers/governed-project";

interface ProjectSummary {
  id: string;
  code: string;
  name: string;
  stage: string;
}

interface DiagramNodeSummary {
  id: string;
  kind: string;
}

interface ProjectWorkspaceResponse {
  project: ProjectSummary;
  mainDiagram: {
    id: string;
    nodes: DiagramNodeSummary[];
  } | null;
}

interface OrchestrationTask {
  id: string;
  queue: QueueKey;
  projectId: string;
  diagramId: string | null;
  nodeId: string | null;
  planItemId: string | null;
  correlationId: string;
  title: string;
  reason: string;
  priority: "P0" | "P1" | "P2" | "P3";
  deliveryLayer: number | null;
  dueAt: string;
  createdAt: string;
  actionCode: string;
  href: string;
  assignee: { agentId: string; displayName: string } | null;
}

type QueueKey = "design" | "development" | "audit" | "approval" | "managerApproval";

interface AgentOrchestrationResponse {
  project: ProjectSummary;
  workingDirectory: {
    repositoryPath: string;
    ready: boolean;
    issue: string;
  };
  queues: Record<QueueKey, OrchestrationTask[]>;
  workflow: {
    layerGate: { activeLayer: number | null; totalLayers: number; activePlanCount: number; lockedPlanCount: number };
  };
  [key: string]: unknown;
}

interface PlanResponse {
  id: string;
  lifecycleStatus: string;
  correlationId: string;
}

const queueKeys: QueueKey[] = ["design", "development", "audit", "approval", "managerApproval"];

test.use({ channel: "chrome", viewport: { width: 1440, height: 1100 } });
test.describe.configure({ mode: "serial" });

async function loadProjects(request: APIRequestContext): Promise<ProjectSummary[]> {
  const response = await request.get("/api/projects");
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<ProjectSummary[]>;
}

function queueFixture(project: ProjectSummary, queue: QueueKey): OrchestrationTask[] {
  return Array.from({ length: 13 }, (_, index) => ({
    id: `${project.id}:${queue}:${index + 1}`,
    queue,
    projectId: project.id,
    diagramId: null,
    nodeId: null,
    planItemId: `${queue}-plan-${index + 1}`,
    correlationId: `${queue}-correlation-${index + 1}`,
    title: `${queue} task ${index + 1}`,
    reason: `${queue} pagination fixture`,
    priority: index === 0 ? "P0" : "P1",
    deliveryLayer: 1,
    dueAt: "",
    createdAt: `2026-08-30T00:00:${String(index).padStart(2, "0")}.000Z`,
    actionCode: `${queue}_action`,
    href: "#/orchestration",
    assignee: queue === "managerApproval" ? null : {
      agentId: `${queue}-agent-${index + 1}`,
      displayName: `${queue} agent ${index + 1}`,
    },
  }));
}

test("integrated orchestration previews and exports a read-only external handoff without starting work", async ({ page, request, context }) => {
  const created = await request.post("/api/projects", { data: { code: `HANDOFF-${Date.now()}`, name: "Read-only handoff fixture", summary: "Synthetic project; no runtime or model" } });
  expect(created.ok()).toBe(true); const project = await created.json() as ProjectSummary;
  try {
    const response = await request.get(`/api/projects/${project.id}/agent-orchestration`);
    expect(response.ok()).toBe(true); const orchestration = await response.json() as AgentOrchestrationResponse;
    const workspaceResponse = await request.get(`/api/projects/${project.id}/workspace`);
    const workspace = await workspaceResponse.json() as ProjectWorkspaceResponse;
    const leasesBefore = await (await request.get(`/api/projects/${project.id}/agent-task-leases`)).json();
    await page.addInitScript((id) => localStorage.setItem("pcs.workspace", id), project.id);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/#/orchestration", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".orchestration-hero h1")).toHaveText(project.name);
    await expect(page.locator(".orchestration-pulse strong")).toHaveText(`${orchestration.workflow.layerGate.activeLayer ?? "-"}/${orchestration.workflow.layerGate.totalLayers}`);
    await expect(page.locator(".orchestration-queue")).toHaveCount(5);
    for (const key of queueKeys) {
      const card = page.locator(`.queue-${key}`);
      await expect(card.locator(".orchestration-queue-head strong")).toHaveText(String(orchestration.queues[key].length));
      await expect(card.locator(".orchestration-task")).toHaveCount(Math.min(5, orchestration.queues[key].length));
    }
    await expect(page.locator(".manager-card")).toContainText("HUMAN GATE");
    expect(orchestration.queues.design.length).toBeGreaterThan(0);
    await page.locator(".queue-design").getByRole("button", { name: "预览只读交接" }).first().click();
    const preview = page.getByTestId("coordination-handoff-preview"); await expect(preview).toBeVisible();
    await expect(preview).toContainText(project.id);
    await page.getByRole("button", { name: "复制交接", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(await preview.textContent());
    const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "下载交接", exact: true }).click();
    const download = await downloadPromise; expect(download.suggestedFilename()).toBe("coordination-handoff.json"); await download.delete();
    expect(await (await request.get(`/api/projects/${project.id}/agent-task-leases`)).json()).toEqual(leasesBefore);
    await page.screenshot({ path: "artifacts/regression/orchestration-integrated.png", fullPage: true });
    const systemRoot = workspace.mainDiagram!.nodes.find((node) => node.kind === "system")!;
    await page.goto(`/#/canvas/${workspace.mainDiagram!.id}`, { waitUntil: "domcontentloaded" });
    const rootNode = page.locator(`g[data-node-id="${systemRoot.id}"]`); await expect(rootNode).toBeVisible();
    await expect(rootNode).not.toContainText("开发 ·"); await expect(rootNode).not.toContainText("验收 ·");
  } finally { expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true); }
});

test("each orchestration queue paginates independently and project switches reset queue boundaries", async ({ page, request }) => {
  const create = async (code: string) => {
    const response = await request.post("/api/projects", { data: { code, name: code, summary: "Queue pagination UI fixture" } });
    expect(response.ok()).toBe(true); return await response.json() as ProjectSummary;
  };
  const projects: ProjectSummary[] = [];
  try {
  const source = await create(`QUEUE-SOURCE-${Date.now()}`); projects.push(source);
  const target = await create(`QUEUE-TARGET-${Date.now()}`); projects.push(target);
  const baseResponse = await request.get(`/api/projects/${source!.id}/agent-orchestration`);
  expect(baseResponse.ok()).toBeTruthy();
  const base = await baseResponse.json() as AgentOrchestrationResponse;
  const projectById = new Map(projects.map((project) => [project.id, project]));

  await page.route("**/api/projects/*/agent-orchestration**", async (route) => {
    const match = new URL(route.request().url()).pathname.match(/^\/api\/projects\/([^/]+)\/agent-orchestration$/);
    const project = projectById.get(match?.[1] ?? "") ?? source!;
    const queues = Object.fromEntries(queueKeys.map((key) => [key, queueFixture(project, key)])) as Record<QueueKey, OrchestrationTask[]>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...base, project, queues }),
    });
  });

  await page.addInitScript((projectId) => localStorage.setItem("pcs.workspace", projectId), source!.id);
  await page.goto("/#/orchestration", { waitUntil: "domcontentloaded" });

  const design = page.locator(".queue-design");
  const development = page.locator(".queue-development");
  await expect(design.locator(".orchestration-task")).toHaveCount(5);
  await expect(design).toContainText("design task 1");
  await expect(development).toContainText("development task 1");

  await design.getByRole("button", { name: "下一页" }).click();
  await expect(design).toContainText("design task 6");
  await expect(development).toContainText("development task 1");
  await expect(development).not.toContainText("development task 6");

  await development.getByRole("button", { name: "下一页" }).click();
  await expect(development).toContainText("development task 6");
  await page.getByRole("button", { name: "刷新队列" }).click();
  await expect(design).toContainText("design task 6");
  await expect(development).toContainText("development task 6");
  await page.screenshot({ path: "artifacts/regression/orchestration-pagination.png", fullPage: true });

  await page.keyboard.press("Control+K");
  await page.locator(".ws-search input").fill(target!.code);
  await page.locator(".ws-item-row", { hasText: target!.code }).locator(".ws-item").click();
  await expect(page.locator(".orchestration-hero h1")).toHaveText(target!.name);
  await expect(design).toContainText("design task 1");
  await expect(design).not.toContainText("design task 6");
  await expect(development).toContainText("development task 1");
  } finally {
    const cleanup = await Promise.allSettled(projects.map(async (project) => expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true)));
    const failed = cleanup.filter((item) => item.status === "rejected"); expect(failed).toEqual([]);
  }
});

test("authenticated scripted delivery preserves one correlation timeline through independent acceptance", async () => {
  const fixture = await createGovernedProject("Authenticated scripted delivery fixture");
  try {
    const design = await fixture.setupDesign();
    const accepted = await fixture.deliver(design); expect(accepted.lifecycleStatus).toBe("accepted");
    const audit = await fixture.http("GET", `/api/audit?projectId=${fixture.project.id}&correlationId=${fixture.correlationId}&offset=0&limit=100`);
    expect(audit.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "submit_plan", entityType: "plan", sessionId: "synthetic-designer-session" }),
      expect.objectContaining({ action: "approve_plan", entityType: "plan", sessionId: "Main Agent-session" }),
      expect.objectContaining({ action: "create", entityType: "evidence", sessionId: "synthetic-builder-session" }),
      expect.objectContaining({ action: "complete_development", entityType: "plan", sessionId: "synthetic-builder-session" }),
      expect.objectContaining({ action: "pass_audit", entityType: "plan", sessionId: "synthetic-auditor-session" }),
      expect.objectContaining({ action: "approve_acceptance", entityType: "plan", sessionId: "Main Agent-session" }),
    ]));
    const workflow = await fixture.workflow(); expect(workflow.nodes.find((node: { nodeId: string }) => node.nodeId === design.nodeId).acceptanceStatus).toBe("已通过");
  } finally { await fixture.close(); }
});

test("same-node higher-layer design can advance while development stays locked and shows its dependency", async ({ page, request }) => {
  const governed = await createGovernedProject("Authenticated layer gate fixture");
  try { await governed.assertDependentLayerLocked(await governed.setupDesign(true)); }
  finally { await governed.close(); }

  const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const projectResponse = await request.post("/api/projects", { data: {
    code: `LAYER-${unique}`.slice(0, 64), name: `Layer gate ${unique}`, summary: "逐层门禁回归",
    stage: "开发", health: "正常", progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", startAt: "", dueAt: "",
  } });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json() as ProjectSummary;
  try {
    const workspaceResponse = await request.get(`/api/projects/${project.id}/workspace`);
    const workspace = await workspaceResponse.json() as ProjectWorkspaceResponse;
    expect(workspace.mainDiagram).toBeTruthy();
    const diagramResponse = await request.get(`/api/diagrams/${workspace.mainDiagram!.id}`);
    const diagram = await diagramResponse.json() as { id: string; nodes: Array<Record<string, unknown>> };
    const nodeId = `same-node-${unique}`;
    expect((await request.patch(`/api/diagrams/${diagram.id}`, { data: {
      nodes: [...diagram.nodes, { id: nodeId, kind: "feature", label: "同节点跨层交付", x: 620, y: 160 }],
    } })).ok()).toBeTruthy();
    const assignments = {
      designer: { agentId: "designer-layer", displayName: "Designer Layer" },
      builder: { agentId: "builder-layer", displayName: "Builder Layer" },
      auditor: { agentId: "auditor-layer", displayName: "Auditor Layer" },
    };
    const firstResponse = await request.post("/api/plans", { data: {
      projectId: project.id, diagramId: diagram.id, diagramNodeId: nodeId, kind: "task", title: "同节点第一层", priority: "P2", roleAssignments: assignments,
    } });
    const first = await firstResponse.json() as PlanResponse;
    const higherResponse = await request.post("/api/plans", { data: {
      projectId: project.id, diagramId: diagram.id, diagramNodeId: nodeId, kind: "task", title: "同节点第二层", priority: "P0",
      dependencyIds: [first.id], roleAssignments: assignments,
    } });
    const higher = await higherResponse.json() as PlanResponse;

    const orchestrationResponse = await request.get(`/api/projects/${project.id}/agent-orchestration`);
    const orchestration = await orchestrationResponse.json() as AgentOrchestrationResponse;
    expect(orchestration.workflow.layerGate).toMatchObject({ activeLayer: 1, totalLayers: 2, lockedPlanCount: 1 });
    // Design preparation does not wait for upstream implementation acceptance.
    // The implementation dependency remains locked (see DEPENDENCY_STAGE_DEADLOCK_FIX.md).
    const higherTasks = Object.values(orchestration.queues).flat().filter((item) => item.planItemId === higher.id);
    expect(higherTasks).toEqual([expect.objectContaining({ queue: "design", actionCode: "submit_plan" })]);
    const blockedPackage = await request.get(`/api/projects/${project.id}/agent-task-package?queue=development&taskId=${encodeURIComponent(`development:${higher.id}`)}`);
    expect(blockedPackage.status()).toBe(409);
    // Public task-package access also requires a claimed work order; do not bypass it.
    expect(await blockedPackage.json()).toMatchObject({ code: "TASK_CLAIM_REQUIRED" });
    const unchanged = await (await request.get(`/api/plans/${higher.id}`)).json() as PlanResponse;
    expect(unchanged.lifecycleStatus).toBe("draft");

    await page.addInitScript((projectId) => localStorage.setItem("pcs.workspace", projectId), project.id);
    await page.goto(`/#/projects/${project.id}?tab=plans`, { waitUntil: "domcontentloaded" });
    const row = page.locator("table.table tbody tr", { hasText: "同节点第二层" });
    await expect(row).toContainText("第 2 层");
    await expect(row).toContainText("必须先完成并验收依赖任务：同节点第一层");
    await page.screenshot({ path: "artifacts/regression/plan-layer-lock-chrome.png", fullPage: true });
  } finally {
    expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
  }
});
