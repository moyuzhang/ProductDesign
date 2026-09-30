// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listDesignChangeRecoveries: vi.fn(), submitDesignChangeIntent: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
import { DesignChangeRecoveryModal, DesignChangeRecoveryPanel } from "./DesignChangeRecoveryPanel";
import type { DesignChangeRecovery } from "../../shared/types";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const candidate: DesignChangeRecovery = { correctsChangeId: "change-current", diagramId: "diagram", nodeId: "node", rootPlanId: "root", nodeLabel: "报名", expectedUpdatedAt: "2026-09-30T00:00:00Z", reason: "原记录未影响需求", requiresIndependentApproval: true };
const result = { intentId: "intent", status: "pending", approvalTaskIds: ["approval"], authorizesImplementation: false, snapshotHash: "hash", changeId: "", createdAt: "now", updatedAt: "now" };
beforeEach(() => { vi.resetAllMocks(); mocks.listDesignChangeRecoveries.mockResolvedValue([candidate]); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function fill(index: number, value: string) {
  await act(async () => { const input = container.querySelectorAll("textarea")[index]; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function click(label: string) { const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label); expect(button).toBeTruthy(); await act(async () => button!.click()); }
describe("formal requirement-impact correction", () => {
  it("uses authoritative candidates and does not manufacture an eligible recovery from local state", async () => {
    mocks.listDesignChangeRecoveries.mockResolvedValue([]);
    await act(async () => root.render(<DesignChangeRecoveryPanel projectId="project" />));
    expect(container.textContent).toBe(""); expect(mocks.submitDesignChangeIntent).not.toHaveBeenCalled();
  });
  it("filters to the current node instead of offering another node's correction", async () => {
    await act(async () => root.render(<DesignChangeRecoveryPanel projectId="project" diagramId="diagram" nodeId="different" />));
    expect(container.textContent).toBe("");
  });
  it("submits only an append-only intent with exact server IDs and leaves approval independent", async () => {
    mocks.submitDesignChangeIntent.mockResolvedValue(result);
    await act(async () => root.render(<DesignChangeRecoveryPanel projectId="project" />));
    await click("申请更正需求影响判定"); await fill(0, "原判定遗漏资格要求"); await fill(1, "新增资格校验及验收标准"); await click("提交独立复核");
    expect(mocks.submitDesignChangeIntent).toHaveBeenCalledExactlyOnceWith("project", expect.objectContaining({ correctsChangeId: candidate.correctsChangeId, rootPlanId: candidate.rootPlanId, nodeId: candidate.nodeId, diagramId: candidate.diagramId, expectedUpdatedAt: candidate.expectedUpdatedAt, reason: "原判定遗漏资格要求", changeSummary: "新增资格校验及验收标准", idempotencyKey: expect.any(String) }));
    expect(mocks.submitDesignChangeIntent.mock.calls[0][1]).not.toHaveProperty("requirementImpact");
    expect(container.textContent).toContain("不授权开发、不解除返工门禁");
    expect(container.querySelector(".modal")).toBeNull();
  });
  it("retains the exact idempotency key for retry and guards repeated submission/dismissal", async () => {
    const onSubmitted = vi.fn(); const onClose = vi.fn();
    mocks.submitDesignChangeIntent.mockRejectedValueOnce(new Error("记录已变化，请刷新"));
    await act(async () => root.render(<DesignChangeRecoveryModal projectId="project" candidate={candidate} onClose={onClose} onSubmitted={onSubmitted} />));
    await fill(0, "修正依据"); await fill(1, "修订需求"); await click("提交独立复核");
    const key = mocks.submitDesignChangeIntent.mock.calls[0][1].idempotencyKey;
    expect(container.textContent).toContain("关闭窗口并刷新恢复入口");
    let resolve!: (value: typeof result) => void; mocks.submitDesignChangeIntent.mockReturnValue(new Promise((done) => { resolve = done; }));
    await click("提交独立复核"); await click("提交中…");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).not.toHaveBeenCalled(); expect(mocks.submitDesignChangeIntent).toHaveBeenCalledTimes(2);
    expect(mocks.submitDesignChangeIntent.mock.calls[1][1].idempotencyKey).toBe(key);
    await act(async () => resolve(result)); expect(onSubmitted).toHaveBeenCalledOnce();
  });
});
