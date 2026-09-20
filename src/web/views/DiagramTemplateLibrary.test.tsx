// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagram, DiagramTemplateSummary } from "../../shared/types";

const harness = vi.hoisted(() => {
  class WhiteboardConflictError extends Error {
    readonly serverUpdatedAt: string;
    readonly code: string;
    constructor(message: string, code: string, serverUpdatedAt: string) {
      super(message);
      this.name = "WhiteboardConflictError";
      this.code = code;
      this.serverUpdatedAt = serverUpdatedAt;
    }
  }
  return {
    WhiteboardConflictError,
    listDiagramTemplates: vi.fn(),
    getDiagramTemplate: vi.fn(),
    createDiagramTemplate: vi.fn(),
    updateDiagramTemplate: vi.fn(),
    revokeDiagramTemplate: vi.fn(),
    applyDiagramTemplate: vi.fn(),
    getDiagram: vi.fn(),
    getDiagramLayers: vi.fn(),
    getFreeformDocument: vi.fn(),
  };
});

vi.mock("../api", () => ({
  WhiteboardConflictError: harness.WhiteboardConflictError,
  api: {
    listDiagramTemplates: harness.listDiagramTemplates,
    getDiagramTemplate: harness.getDiagramTemplate,
    createDiagramTemplate: harness.createDiagramTemplate,
    updateDiagramTemplate: harness.updateDiagramTemplate,
    revokeDiagramTemplate: harness.revokeDiagramTemplate,
    applyDiagramTemplate: harness.applyDiagramTemplate,
    getDiagram: harness.getDiagram,
    getDiagramLayers: harness.getDiagramLayers,
    getFreeformDocument: harness.getFreeformDocument,
  },
}));

import { DiagramTemplateLibrary } from "./DiagramTemplateLibrary";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onClose: () => void;
let onApplied: (result: unknown) => void;

const SCHEMA_V1 = "whiteboard.template/1.0";
const UPDATED_AT = "2026-09-20T00:00:00.000Z";

function makeTemplate(overrides: Partial<DiagramTemplateSummary> & { id: string; name: string; scope: DiagramTemplateSummary["scope"] }): DiagramTemplateSummary {
  return {
    projectId: overrides.scope === "system" ? null : "project-1",
    schemaVersion: SCHEMA_V1,
    thumbnailMeta: { kind: "none", width: 0, height: 0, viewBox: "", generatedAt: UPDATED_AT, source: "auto" },
    createdBy: "system", createdAt: UPDATED_AT, updatedAt: UPDATED_AT, revokedAt: null, contentBytes: 128,
    ...overrides,
  };
}

function makeDiagram(id: string, title: string, type: Diagram["type"], extra: Partial<Diagram> = {}): Diagram {
  return {
    id, projectId: "project-1", title, type, nodes: [], edges: [], groups: [],
    createdAt: UPDATED_AT, updatedAt: UPDATED_AT, ...extra,
  } as Diagram;
}

const CURRENT = makeDiagram("diagram-1", "当前画布", "free");
const OTHER = makeDiagram("diagram-2", "目标画布", "free");
const MAIN = makeDiagram("diagram-main", "主画布", "main");
const DELIVERY = makeDiagram("diagram-3", "含交付画布", "free", {
  nodes: [{ id: "n1", kind: "feature", label: "交付节点", x: 0, y: 0, requirementStatus: "已批准" } as never],
});
const DIAGRAMS = [CURRENT, OTHER, MAIN, DELIVERY];

const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
const rowByName = (name: string): HTMLElement => {
  const found = rows().find((row) => row.getAttribute("aria-label")?.startsWith(`${name}，`));
  if (!found) throw new Error(`未找到模板行：${name}`);
  return found;
};
const buttonByText = (scope: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...scope.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
  if (!found) throw new Error(`未找到按钮：${text}`);
  return found;
};
const sectionTitles = () => [...container.querySelectorAll(".layer-section-title")].map((node) => node.textContent);
const statusText = () => container.querySelector(".layer-panel-status")?.textContent ?? "";

function click(target: Element): void {
  act(() => { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}
function selectValue(select: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function setInputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function keyOn(target: Element, key: string): void {
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
}
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

async function renderLibrary(templates: DiagramTemplateSummary[]): Promise<void> {
  harness.listDiagramTemplates.mockResolvedValue(templates);
  await act(async () => {
    root.render(
      <DiagramTemplateLibrary
        projectId="project-1"
        currentDiagram={CURRENT}
        diagrams={DIAGRAMS}
        onClose={onClose}
        onApplied={onApplied as never}
      />,
    );
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onClose = vi.fn();
  onApplied = vi.fn();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  harness.getDiagram.mockResolvedValue(CURRENT);
  harness.getDiagramLayers.mockResolvedValue({ schemaVersion: 1, layers: [], itemOverrides: {}, diagramUpdatedAt: UPDATED_AT });
  harness.getFreeformDocument.mockResolvedValue(null);
  harness.createDiagramTemplate.mockResolvedValue(makeTemplate({ id: "tpl-new", name: "新模板", scope: "project" }));
  harness.updateDiagramTemplate.mockImplementation(async (_id: string, patch: { name?: string }) =>
    makeTemplate({ id: "tpl-project", name: patch.name ?? "项目模板", scope: "project" }));
  harness.revokeDiagramTemplate.mockResolvedValue(makeTemplate({ id: "tpl-project", name: "项目模板", scope: "project" }));
  harness.applyDiagramTemplate.mockResolvedValue({
    diagram: OTHER, createdNodeIds: ["tpl_node_1"], createdEdgeIds: [], createdFreeformIds: ["fr_1"],
    droppedLinkDiagramIds: [], migrated: false, thumbnailApplied: true, diagramUpdatedAt: UPDATED_AT,
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("UI-TMP-01 列表分区与缩略图占位", () => {
  it("按系统内置/项目级分区，kind=none 显示占位、svg 用 data URI 渲染", async () => {
    await renderLibrary([
      makeTemplate({ id: "tpl-system", name: "系统模板", scope: "system", createdBy: "system" }),
      makeTemplate({
        id: "tpl-project", name: "项目模板", scope: "project",
        thumbnailMeta: { kind: "svg", width: 160, height: 120, viewBox: "0 0 160 120", content: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", generatedAt: UPDATED_AT, source: "auto" },
      }),
    ]);
    expect(sectionTitles()).toEqual(["系统内置（1）", "项目级（1）"]);
    expect(container.querySelectorAll('[role="listbox"]')).toHaveLength(2);
    expect(rowByName("系统模板").querySelector(".template-thumb-empty")?.textContent).toBe("无缩略图");
    const img = rowByName("项目模板").querySelector("img.template-thumb");
    expect(img?.getAttribute("src")).toContain("data:image/svg+xml;utf8,");
    expect(rowByName("项目模板").querySelector(".template-meta")?.textContent).toContain(SCHEMA_V1);
  });
});

describe("UI-TMP-02 兼容标记与禁用态", () => {
  it("exact/downgrade/unsupported 三种标记与禁用", async () => {
    await renderLibrary([
      makeTemplate({ id: "tpl-exact", name: "同版本", scope: "project", schemaVersion: SCHEMA_V1 }),
      makeTemplate({ id: "tpl-old", name: "旧版本", scope: "project", schemaVersion: "whiteboard.template/0.9" }),
      makeTemplate({ id: "tpl-new", name: "新版本", scope: "project", schemaVersion: "whiteboard.template/2.0" }),
    ]);
    expect(rowByName("同版本").querySelector(".template-compat")?.textContent).toBe("版本一致");
    expect(rowByName("旧版本").querySelector(".template-compat")?.textContent).toBe("将升级应用");
    expect(rowByName("新版本").querySelector(".template-compat")?.textContent).toContain("不兼容");
    const applyButton = buttonByText(rowByName("新版本"), "应用…");
    expect(applyButton.disabled).toBe(true);
    expect(applyButton.getAttribute("title")).toContain("版本不兼容");
    expect(buttonByText(rowByName("旧版本"), "应用…").disabled).toBe(false);
  });
});

describe("UI-TMP-03 应用确认与结果提示", () => {
  it("append 应用到目标画布并播报新增数量与缩略图", async () => {
    await renderLibrary([makeTemplate({ id: "tpl-project", name: "项目模板", scope: "project" })]);
    click(buttonByText(rowByName("项目模板"), "应用…"));
    const panel = container.querySelector(".template-apply")!;
    expect(panel).not.toBeNull();
    selectValue(panel.querySelector<HTMLSelectElement>('select[aria-label="目标画布"]')!, OTHER.id);
    selectValue(panel.querySelector<HTMLSelectElement>('select[aria-label="应用模式"]')!, "append");
    click(buttonByText(panel as HTMLElement, "确认应用"));
    await flush();
    expect(harness.applyDiagramTemplate).toHaveBeenCalledWith(OTHER.id, {
      templateId: "tpl-project", mode: "append", expectedUpdatedAt: UPDATED_AT,
    });
    expect(statusText()).toContain("新增 1 节点、0 连线、1 自由元素");
    expect(statusText()).toContain("缩略图已应用");
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("replace 对主画布/含交付数据画布禁用并给出原因", async () => {
    await renderLibrary([makeTemplate({ id: "tpl-project", name: "项目模板", scope: "project" })]);
    click(buttonByText(rowByName("项目模板"), "应用…"));
    const panel = container.querySelector(".template-apply")!;
    selectValue(panel.querySelector<HTMLSelectElement>('select[aria-label="应用模式"]')!, "replace");

    selectValue(panel.querySelector<HTMLSelectElement>('select[aria-label="目标画布"]')!, MAIN.id);
    await flush();
    expect(container.querySelector(".template-block")?.textContent).toContain("主画布不允许 replace");
    expect(buttonByText(panel as HTMLElement, "确认应用").disabled).toBe(true);

    selectValue(container.querySelector<HTMLSelectElement>('select[aria-label="目标画布"]')!, DELIVERY.id);
    await flush();
    expect(container.querySelector(".template-block")?.textContent).toContain("交付状态节点");
    expect(buttonByText(container.querySelector(".template-apply") as HTMLElement, "确认应用").disabled).toBe(true);

    selectValue(container.querySelector<HTMLSelectElement>('select[aria-label="目标画布"]')!, OTHER.id);
    await flush();
    expect(container.querySelector(".template-block")).toBeNull();
    expect(buttonByText(container.querySelector(".template-apply") as HTMLElement, "确认应用").disabled).toBe(false);
  });
});

describe("UI-TMP-04 撤销二次确认与提示文案", () => {
  it("确认撤销后移出列表并提示已应用内容不受影响", async () => {
    await renderLibrary([makeTemplate({ id: "tpl-project", name: "项目模板", scope: "project" })]);
    click(rowByName("项目模板").querySelectorAll("button")[2] as HTMLButtonElement);
    await flush();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("确认撤销模板「项目模板」"));
    expect(harness.revokeDiagramTemplate).toHaveBeenCalledWith("tpl-project");
    expect(rows()).toHaveLength(0);
    expect(statusText()).toContain("已应用的画布内容不受影响");
  });

  it("取消二次确认则不调用撤销接口", async () => {
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await renderLibrary([makeTemplate({ id: "tpl-project", name: "项目模板", scope: "project" })]);
    click(rowByName("项目模板").querySelectorAll("button")[2] as HTMLButtonElement);
    await flush();
    expect(harness.revokeDiagramTemplate).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });
});

describe("UI-TMP-05 系统模板只读与创建入口", () => {
  it("系统内置模板的重命名/撤销禁用并给出只读原因", async () => {
    await renderLibrary([makeTemplate({ id: "tpl-system", name: "系统模板", scope: "system" })]);
    const row = rowByName("系统模板");
    const rename = buttonByText(row, "重命名");
    const revoke = row.querySelectorAll("button")[2] as HTMLButtonElement;
    expect(rename.disabled).toBe(true);
    expect(rename.getAttribute("title")).toContain("系统内置模板只读");
    expect(revoke.disabled).toBe(true);
    expect(revoke.getAttribute("title")).toContain("只读");
  });

  it("从当前画布创建项目级模板", async () => {
    await renderLibrary([]);
    click(buttonByText(container, "从当前画布创建模板"));
    const input = container.querySelector<HTMLInputElement>(".template-create input")!;
    setInputValue(input, "画布快照模板");
    click(buttonByText(container.querySelector(".template-create") as HTMLElement, "确定"));
    await flush();
    expect(harness.createDiagramTemplate).toHaveBeenCalledTimes(1);
    const [projectId, body] = harness.createDiagramTemplate.mock.calls[0] as [string, { name: string; content: { schemaVersion: string; diagram: { layers: unknown } } }];
    expect(projectId).toBe("project-1");
    expect(body.name).toBe("画布快照模板");
    expect(body.content.schemaVersion).toBe(SCHEMA_V1);
    expect(body.content.diagram.layers).toEqual({ schemaVersion: 1, layers: [], itemOverrides: {} });
    expect(statusText()).toContain("已创建项目级模板：新模板");
  });

  it("Esc 关闭对话框", async () => {
    await renderLibrary([]);
    keyOn(container.querySelector('[role="dialog"]')!, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});