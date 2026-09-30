// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listAgentTaskRetryCandidates: vi.fn(), requestAgentTaskRetry: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
import { AgentTaskRetryModal, AgentTaskRetryPanel } from "./AgentTaskRetryPanel";
import type { AgentTaskRetryCandidate } from "../../shared/types";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const candidate: AgentTaskRetryCandidate = { taskId: "task", taskKey: "frozen-task", taskRevision: "revision-1", failedWorkOrderId: "failed-order", attempt: 3, maxAttempts: 3, title: "校验用户流程", actionCode: "build", role: "builder", diagramId: "diagram", nodeId: "node", lastError: "外部依赖不可用" };
const pending = { requestId: "request", status: "pending", approvalTaskId: "approve-request", additionalAttempts: 1, authorizesRetry: false };
beforeEach(() => { vi.resetAllMocks(); mocks.listAgentTaskRetryCandidates.mockResolvedValue([candidate]); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function fill(index: number, value: string) {
  await act(async () => { const input = container.querySelectorAll("textarea")[index]; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function click(text: string) { const button = [...container.querySelectorAll("button")].find((item) => item.textContent === text); expect(button).toBeTruthy(); await act(async () => button!.click()); }
describe("single-task independently approved retry", () => {
  it("does not invent an eligible retry or request one on mount", async () => {
    mocks.listAgentTaskRetryCandidates.mockResolvedValue([]);
    await act(async () => root.render(<AgentTaskRetryPanel projectId="project" />));
    expect(container.textContent).toContain("没有返回符合额外重试申请条件");
    expect(mocks.requestAgentTaskRetry).not.toHaveBeenCalled();
  });
  it("shows the original failure and requires both rationale and remediation", async () => {
    await act(async () => root.render(<AgentTaskRetryPanel projectId="project" />));
    expect(container.textContent).toContain("外部依赖不可用"); expect(container.textContent).toContain("已尝试 3 次 / 上限 3 次");
    await click("申请一次额外尝试");
    const submit = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "提交独立审批")!;
    expect(submit.disabled).toBe(true); await fill(0, "需要完成这一任务"); expect(submit.disabled).toBe(true); await fill(1, "外部依赖已恢复并通过只读健康检查"); expect(submit.disabled).toBe(false);
  });
  it("freezes the exact task revision/failure/attempt and requests review without granting or executing", async () => {
    mocks.requestAgentTaskRetry.mockResolvedValue(pending);
    await act(async () => root.render(<AgentTaskRetryPanel projectId="project" />));
    await click("申请一次额外尝试"); await fill(0, "必要的额外尝试"); await fill(1, "修复超时配置"); await click("提交独立审批");
    expect(mocks.requestAgentTaskRetry).toHaveBeenCalledExactlyOnceWith("project", expect.objectContaining({ taskKey: "frozen-task", taskRevision: "revision-1", failedWorkOrderId: "failed-order", expectedAttempt: 3, reason: "必要的额外尝试", remediation: "修复超时配置", idempotencyKey: expect.any(String) }));
    const payload = mocks.requestAgentTaskRetry.mock.calls[0][1];
    expect(payload).not.toHaveProperty("maxAttempts"); expect(payload).not.toHaveProperty("approved"); expect(payload).not.toHaveProperty("reset");
    expect(container.textContent).toContain("等待独立审批，尚未授权重试");
    expect(container.textContent).toContain("不会自动启动任务");
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "等待独立审批")?.disabled).toBe(true);
  });
  it("disables candidates with an existing pending request from the server", async () => {
    mocks.listAgentTaskRetryCandidates.mockResolvedValue([{ ...candidate, pendingRequestId: "already-pending" }]);
    await act(async () => root.render(<AgentTaskRetryPanel projectId="project" />));
    expect(container.textContent).toContain("already-pending");
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "等待独立审批")?.disabled).toBe(true);
  });
  it("retains the user's explanations on conflict and locks repeats with an idempotent retry", async () => {
    const onSubmitted = vi.fn(); const onClose = vi.fn();
    mocks.requestAgentTaskRetry.mockRejectedValueOnce(new Error("任务修订已变化"));
    await act(async () => root.render(<AgentTaskRetryModal projectId="project" candidate={candidate} onSubmitted={onSubmitted} onClose={onClose} />));
    await fill(0, "保留原因"); await fill(1, "保留修复记录"); await click("提交独立审批");
    expect(container.querySelectorAll("textarea")[0].value).toBe("保留原因"); expect(container.textContent).toContain("不会自动替换申请范围");
    const key = mocks.requestAgentTaskRetry.mock.calls[0][1].idempotencyKey;
    let resolve!: (value: typeof pending) => void; mocks.requestAgentTaskRetry.mockReturnValue(new Promise((done) => { resolve = done; }));
    await click("提交独立审批"); await click("提交中…"); await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(mocks.requestAgentTaskRetry).toHaveBeenCalledTimes(2); expect(onClose).not.toHaveBeenCalled(); expect(mocks.requestAgentTaskRetry.mock.calls[1][1].idempotencyKey).toBe(key);
    await act(async () => resolve(pending)); expect(onSubmitted).toHaveBeenCalledOnce();
  });
  it("shows read errors and allows a safe refresh", async () => {
    mocks.listAgentTaskRetryCandidates.mockRejectedValueOnce(new Error("候选服务不可用")).mockResolvedValue([]);
    await act(async () => root.render(<AgentTaskRetryPanel projectId="project" />)); expect(container.textContent).toContain("候选服务不可用");
    await click("刷新可申请任务"); expect(container.textContent).toContain("没有返回符合额外重试申请条件");
  });
});
