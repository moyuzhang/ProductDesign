import { expect, test, type APIRequestContext } from "@playwright/test";

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

const productDesignCode = "PRODUCTDESIGN";
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

test("integrated orchestration view generates a manual external-agent task package and hides synthetic root delivery state", async ({ page, request, context }) => {
  const projects = await loadProjects(request);
  const project = projects.find((item) => item.code === productDesignCode);
  expect(project).toBeTruthy();

  const orchestrationResponse = await request.get(`/api/projects/${project!.id}/agent-orchestration`);
  expect(orchestrationResponse.ok()).toBeTruthy();
  const orchestration = await orchestrationResponse.json() as AgentOrchestrationResponse;
  const workspaceResponse = await request.get(`/api/projects/${project!.id}/workspace`);
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = await workspaceResponse.json() as ProjectWorkspaceResponse;
  expect(workspace.mainDiagram).toBeTruthy();

  await page.addInitScript((projectId) => localStorage.setItem("pcs.workspace", projectId), project!.id);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#/orchestration", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".orchestration-hero h1")).toHaveText(project!.name);
  await expect(page.locator(".orchestration-pulse")).toContainText(`当前层${orchestration.workflow.layerGate.activeLayer ?? "-"}/${orchestration.workflow.layerGate.totalLayers}`);
  await expect(page.locator(".orchestration-queue")).toHaveCount(4);
  await expect(page.getByTestId("agent-working-directory")).toContainText(orchestration.workingDirectory.repositoryPath || "未配置 repositoryPath");

  for (const key of queueKeys) {
    const card = page.locator(`.queue-${key}`);
    await expect(card.locator(".orchestration-queue-head strong")).toHaveText(String(orchestration.queues[key].length));
    await expect(card.locator(".orchestration-task")).toHaveCount(Math.min(5, orchestration.queues[key].length));
  }

  await expect(page.locator(".orchestration-role-title strong", { hasText: /^设计 Agent$/ })).toBeVisible();
  await expect(page.locator(".orchestration-role-title strong", { hasText: /^施工 Agent$/ })).toBeVisible();
  await expect(page.locator(".orchestration-role-title strong", { hasText: /^审计 Agent$/ })).toBeVisible();
  await expect(page.locator(".manager-card")).toContainText("HUMAN GATE");
  if (orchestration.workingDirectory.ready && orchestration.queues.development.length > 0) {
    const assignedTask = orchestration.queues.development[0];
    expect(assignedTask.assignee?.agentId).toBeTruthy();
    await expect(page.locator(".queue-development .orchestration-task").first()).toContainText(
      assignedTask.assignee!.displayName || assignedTask.assignee!.agentId,
    );
    await expect(page.locator(".queue-development .orchestration-task").first()).toContainText(`第 ${assignedTask.deliveryLayer} 层`);
    await page.locator(".queue-development").getByRole("button", { name: /生成任务包/ }).first().click();
    const packageView = page.getByTestId("agent-task-package");
    await expect(packageView).toBeVisible();
    await expect(packageView).toContainText(orchestration.workingDirectory.repositoryPath);
    await expect(packageView).toContainText("ProductDesign 只生成交接材料");
    await expect(packageView).toContainText(assignedTask.assignee!.agentId);
    await packageView.getByRole("button", { name: "复制启动提示词" }).click();
    await expect(packageView.getByRole("button", { name: "提示词已复制" })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await packageView.getByRole("button", { name: "下载 JSON" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    await download.delete();
  }
  await page.screenshot({ path: "artifacts/regression/orchestration-integrated.png", fullPage: true });

  const systemRoot = workspace.mainDiagram!.nodes.find((node) => node.kind === "system");
  expect(systemRoot).toBeTruthy();
  await page.goto(`/#/canvas/${workspace.mainDiagram!.id}`, { waitUntil: "domcontentloaded" });
  const rootNode = page.locator(`g[data-node-id="${systemRoot!.id}"]`);
  await expect(rootNode).toBeVisible();
  await expect(rootNode).not.toContainText("开发 ·");
  await expect(rootNode).not.toContainText("验收 ·");
  await page.screenshot({ path: "artifacts/regression/orchestration-system-root.png", fullPage: true });
});

test("each orchestration queue paginates independently and project switches reset queue boundaries", async ({ page, request }) => {
  const projects = await loadProjects(request);
  const source = projects.find((item) => item.code === productDesignCode);
  const target = projects.find((item) => item.id !== source?.id);
  expect(source).toBeTruthy();
  expect(target).toBeTruthy();

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
});

test("integrated delivery lifecycle preserves one correlation timeline from proposal through manager acceptance", async ({ request }) => {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const projectResponse = await request.post("/api/projects", {
    data: {
      code: `E2E-${unique}`.slice(0, 64),
      name: `E2E delivery ${unique}`,
      summary: "Agent orchestration lifecycle browser regression fixture",
      stage: "探索",
      health: "正常",
      progress: 0,
      riskLevel: "P2",
      riskSummary: "",
      blockerSummary: "",
      nextStep: "",
      startAt: "",
      dueAt: "",
    },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json() as ProjectSummary;
  const correlationId = `e2e-delivery-${unique}`;

  try {
    const planResponse = await request.post("/api/plans", {
      data: {
        projectId: project.id,
        kind: "task",
        title: "E2E controlled delivery",
        description: "Exercise the complete delivery lifecycle",
        owner: "builder-e2e",
        roleAssignments: {
          designer: { agentId: "designer-e2e", displayName: "Designer E2E" },
          builder: { agentId: "builder-e2e", displayName: "Builder E2E" },
          auditor: { agentId: "auditor-e2e", displayName: "Auditor E2E" },
        },
        priority: "P0",
      },
    });
    expect(planResponse.ok()).toBeTruthy();
    const plan = await planResponse.json() as PlanResponse;

    const transition = async (action: string, actor: string, extra: Record<string, unknown> = {}) => {
      const response = await request.post(`/api/plans/${plan.id}/transition`, {
        data: { action, actor, correlationId, clientId: "playwright-chrome", sessionId: `${actor}-session`, ...extra },
      });
      return response;
    };

    expect((await (await transition("submit_plan", "designer-e2e", { agentId: "designer-e2e" })).json() as PlanResponse).lifecycleStatus).toBe("pending_approval");
    expect((await (await transition("approve_plan", "manager-e2e")).json() as PlanResponse).lifecycleStatus).toBe("approved");

    const skippedStart = await transition("complete_development", "builder-e2e", { agentId: "builder-e2e", implementationRevision: "e2e-build-1" });
    expect(skippedStart.status()).toBe(409);

    expect((await (await transition("start_development", "builder-e2e", { agentId: "builder-e2e" })).json() as PlanResponse).lifecycleStatus).toBe("in_progress");

    const evidenceResponse = await request.post("/api/evidence", {
      data: {
        projectId: project.id,
        nodeId: null,
        planItemId: plan.id,
        sourceType: "playwright",
        sourcePath: "tests/e2e/agent-orchestration-delivery.spec.ts",
        command: "npx playwright test tests/e2e/agent-orchestration-delivery.spec.ts --project=chromium",
        resultStatus: "pass",
        summary: "Real Chrome controlled delivery lifecycle evidence",
        acceptanceCriterionKey: "orchestration-delivery-lifecycle",
        actorRole: "builder",
        agentId: "builder-e2e",
        sessionId: "builder-e2e-session",
        runId: unique,
      },
    });
    expect(evidenceResponse.ok()).toBeTruthy();

    expect((await (await transition("complete_development", "builder-e2e", { agentId: "builder-e2e", implementationRevision: "e2e-build-1" })).json() as PlanResponse).lifecycleStatus).toBe("pending_audit");

    const auditorEvidenceResponse = await request.post("/api/evidence", {
      data: {
        projectId: project.id,
        nodeId: null,
        planItemId: plan.id,
        sourceType: "playwright",
        sourcePath: "tests/e2e/agent-orchestration-delivery.spec.ts",
        command: "npx playwright test tests/e2e/agent-orchestration-delivery.spec.ts",
        resultStatus: "pass",
        summary: "Independent auditor identity evidence",
        acceptanceCriterionKey: "orchestration-independent-audit",
        actorRole: "auditor",
        agentId: "auditor-e2e",
        sessionId: "auditor-e2e-session",
        runId: `${unique}-audit`,
      },
    });
    expect(auditorEvidenceResponse.ok()).toBeTruthy();

    expect((await (await transition("pass_audit", "auditor-e2e", { agentId: "auditor-e2e" })).json() as PlanResponse).lifecycleStatus).toBe("pending_manager");
    expect((await (await transition("approve_acceptance", "manager-e2e")).json() as PlanResponse).lifecycleStatus).toBe("accepted");

    const auditResponse = await request.get(`/api/audit?projectId=${project.id}&correlationId=${correlationId}&offset=0&limit=100`);
    expect(auditResponse.ok()).toBeTruthy();
    const audit = await auditResponse.json() as { items: Array<{ action: string; entityType: string; sessionId?: string }> };
    expect(audit.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "submit_plan", entityType: "plan", sessionId: "designer-e2e-session" }),
      expect.objectContaining({ action: "approve_plan", entityType: "plan", sessionId: "manager-e2e-session" }),
      expect.objectContaining({ action: "create", entityType: "evidence", sessionId: "builder-e2e-session" }),
      expect.objectContaining({ action: "complete_development", entityType: "plan", sessionId: "builder-e2e-session" }),
      expect.objectContaining({ action: "pass_audit", entityType: "plan", sessionId: "auditor-e2e-session" }),
      expect.objectContaining({ action: "approve_acceptance", entityType: "plan", sessionId: "manager-e2e-session" }),
    ]));
  } finally {
    const deleted = await request.delete(`/api/projects/${project.id}`);
    expect(deleted.ok()).toBeTruthy();
  }
});

test("same-node higher-layer work stays out of every queue, rejects task packages, and shows its lock reason", async ({ page, request }) => {
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
    expect(Object.values(orchestration.queues).flat().some((item) => item.planItemId === higher.id)).toBe(false);
    const blockedPackage = await request.get(`/api/projects/${project.id}/agent-task-package?queue=development&taskId=${encodeURIComponent(`development:${higher.id}`)}`);
    expect(blockedPackage.status()).toBe(409);
    expect(await blockedPackage.json()).toMatchObject({ code: "PLAN_LAYER_LOCKED" });
    const unchanged = await (await request.get(`/api/plans/${higher.id}`)).json() as PlanResponse;
    expect(unchanged.lifecycleStatus).toBe("draft");

    await page.addInitScript((projectId) => localStorage.setItem("pcs.workspace", projectId), project.id);
    await page.goto(`/#/projects/${project.id}?tab=plans`, { waitUntil: "domcontentloaded" });
    const row = page.locator("table.table tbody tr", { hasText: "同节点第二层" });
    await expect(row).toContainText("第 2 层");
    await expect(row).toContainText("当前必须先完成并验收第 1 层的全部任务");
    await page.screenshot({ path: "artifacts/regression/plan-layer-lock-chrome.png", fullPage: true });
  } finally {
    expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
  }
});
