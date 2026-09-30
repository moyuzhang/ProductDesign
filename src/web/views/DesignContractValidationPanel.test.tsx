// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignContractReport } from "../../shared/designContract";
const mocks = vi.hoisted(() => ({ getDesignContractValidation: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
import { DesignContractValidationPanel, validationCycleLabel, validationPlanHref } from "./DesignContractValidationPanel";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const empty: DesignContractReport = { status: "unassessed", scope: "declared-structured-requirements-only", issues: [], plans: [], coverage: [], cycles: [] };
const plan = { id: "plan-a", title: "注册流程", scopeRevision: "scope-1", diagramId: "diagram", nodeId: "node" };
beforeEach(() => { vi.resetAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(<DesignContractValidationPanel projectId="project" />)); }
async function refresh() { await act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent === "重新检查（只读）")!.click()); }
describe("honest, actionable structured design validation", () => {
  it("reports unassessed rather than complete when the independent baseline or contract is absent", async () => {
    mocks.getDesignContractValidation.mockResolvedValue(empty); await render();
    expect(container.textContent).toContain("尚未评估"); expect(container.textContent).toContain("不能从已有计划反推需求清单");
    expect(container.textContent).not.toContain("已声明的结构一致"); expect(container.textContent).toContain("不能据此认定没有遗漏");
  });
  it("keeps partial coverage separate from passing evidence and final acceptance", async () => {
    mocks.getDesignContractValidation.mockResolvedValue({ ...empty, status: "partial", plans: [plan], coverage: [{ requirementId: "r1", criterionKey: "c1", planIds: [plan.id], covered: true, verified: false, verifiedPlanIds: [] }, { requirementId: "r2", criterionKey: "c2", planIds: [], covered: false, verified: false, verifiedPlanIds: [] }], issues: [{ code: "CRITERION_UNCOVERED", message: "基线验收标准没有映射", path: "coverage", entityIds: [plan.id] }] });
    await render(); expect(container.textContent).toContain("仅完成部分检查"); expect(container.textContent).toContain("已映射验收标准 1 / 2"); expect(container.textContent).toContain("匹配审计记录 0 / 2");
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toContain("#/canvas/diagram/node/node?tab=development&plan=plan-a");
  });
  it("shows cycle phases, issue locations and fixed source versions without offering a bypass", async () => {
    mocks.getDesignContractValidation.mockResolvedValue({ ...empty, status: "invalid", plans: [plan], baselineRef: { documentId: "baseline", revisionId: "baseline-v1" }, contractRef: { documentId: "contract", revisionId: "contract-v2" }, cycles: [[JSON.stringify([plan.id, "verification"]), JSON.stringify([plan.id, "build"])]], issues: [{ code: "PHASE_DEPENDENCY_CYCLE", message: "阶段循环等待", path: "waits.0", entityIds: [plan.id] }] });
    await render(); expect(container.textContent).toContain("注册流程 · 验证 → 注册流程 · 开发"); expect(container.textContent).toContain("waits.0"); expect(container.textContent).toContain("baseline-v1"); expect(container.textContent).toContain("contract-v2");
    expect(container.textContent).toContain("不要伪造证据或绕过审批"); expect(container.querySelectorAll("button")).toHaveLength(1);
  });
  it("limits a valid result to declared structured facts instead of claiming semantic completeness or acceptance", async () => {
    mocks.getDesignContractValidation.mockResolvedValue({ ...empty, status: "valid" }); await render();
    expect(container.textContent).toContain("已声明的结构一致"); expect(container.textContent).toContain("未声明的需求仍需人工评审"); expect(container.textContent).toContain("不代表交付已验收");
  });
  it("removes stale success on refresh failure and permits read-only retry", async () => {
    mocks.getDesignContractValidation.mockResolvedValueOnce({ ...empty, status: "valid" }).mockRejectedValueOnce(new Error("检查服务不可用")).mockResolvedValueOnce(empty);
    await render(); await refresh(); expect(container.textContent).toContain("检查服务不可用"); expect(container.textContent).not.toContain("已声明的结构一致");
    await refresh(); expect(container.textContent).toContain("尚未评估"); expect(mocks.getDesignContractValidation).toHaveBeenCalledTimes(3);
  });
});
it("only constructs plan links from authoritative node identity and handles opaque cycle values safely", () => {
  expect(validationPlanHref({ ...plan, diagramId: null })).toBeNull();
  expect(validationPlanHref({ ...plan, id: "x&plan=y", nodeId: "node/other" })).toBe("#/canvas/diagram/node/node%2Fother?tab=development&plan=x%26plan%3Dy");
  expect(validationCycleLabel("not-json", [plan])).toBe("not-json");
  expect(validationCycleLabel(JSON.stringify(["missing", "acceptance"]), [plan])).toBe("missing · 验收");
});

it("paginates large coverage reports while preserving all criteria", async () => {
  mocks.getDesignContractValidation.mockResolvedValue({ ...empty, status: "partial", coverage: Array.from({ length: 25 }, (_, index) => ({ requirementId: `r${index}`, criterionKey: `criterion-${index}`, planIds: [], covered: false, verified: false, verifiedPlanIds: [] })) });
  await render(); expect(container.querySelectorAll("tbody tr")).toHaveLength(20);
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "下一页")!.click());
  expect(container.querySelectorAll("tbody tr")).toHaveLength(5); expect(container.textContent).toContain("criterion-24");
});
