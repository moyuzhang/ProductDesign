// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getCodexAccount: vi.fn(), listCodexModels: vi.fn(), startCodexLogin: vi.fn(), cancelCodexLogin: vi.fn(), logoutCodex: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
import { ChatGptAccountPanel, officialLoginUrl } from "./ChatGptAccountPanel";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let models: ReturnType<typeof vi.fn<(models: import("../../shared/types").CodexModel[]) => void>>;
const signedOut = { status: "signed-out", login: null };
const pending = { loginId: "login-1", status: "pending", expiresAt: "2026-09-30T21:00:00Z" };
const start = { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-CODE", expiresAt: pending.expiresAt };
async function render() { await act(async () => root.render(<ChatGptAccountPanel onModelsChange={models} onAccountChange={() => {}} />)); }
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button).toBeTruthy(); await act(async () => button!.click());
}
beforeEach(() => {
  vi.resetAllMocks(); models = vi.fn();
  mocks.getCodexAccount.mockResolvedValue(signedOut); mocks.listCodexModels.mockResolvedValue({ models: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
describe("explicit official ChatGPT login", () => {
  it("never begins authorization or fabricates models on mount", async () => {
    await render(); expect(mocks.startCodexLogin).not.toHaveBeenCalled(); expect(mocks.listCodexModels).not.toHaveBeenCalled();
    expect(container.textContent).toContain("未登录"); expect(container.querySelector('input[type="password"]')).toBeNull();
  });
  it("locks repeated start clicks, shows the device instructions, and cancels the exact login", async () => {
    await render(); let resolve!: (value: typeof start) => void;
    mocks.startCodexLogin.mockReturnValue(new Promise((done) => { resolve = done; }));
    await click("开始 ChatGPT 登录"); await click("准备登录…"); expect(mocks.startCodexLogin).toHaveBeenCalledExactlyOnceWith("chatgptDeviceCode");
    mocks.getCodexAccount.mockResolvedValue({ ...signedOut, login: pending });
    await act(async () => resolve(start));
    expect(container.textContent).toContain("TEST-CODE");
    expect(container.querySelector("a")?.href).toBe(start.verificationUrl);
    mocks.cancelCodexLogin.mockResolvedValue({ status: "cancelled" });
    mocks.getCodexAccount.mockResolvedValue({ ...signedOut, login: { ...pending, status: "cancelled" } });
    await click("取消登录"); expect(mocks.cancelCodexLogin).toHaveBeenCalledExactlyOnceWith("login-1");
    expect(container.textContent).not.toContain("TEST-CODE"); expect(container.textContent).toContain("登录已取消");
  });
  it("recovers an interrupted pending login without inventing a link or a new attempt", async () => {
    mocks.getCodexAccount.mockResolvedValue({ ...signedOut, login: pending }); await render();
    expect(container.textContent).toContain("取消后重新登录"); expect(container.querySelector("a")).toBeNull();
    expect(mocks.startCodexLogin).not.toHaveBeenCalled();
  });
  it("does not show signed-in or stale model success when status fails, and permits refresh", async () => {
    mocks.getCodexAccount.mockRejectedValueOnce(new Error("账户服务不可用")); await render();
    expect(container.textContent).toContain("账户状态未知"); expect(models).toHaveBeenLastCalledWith([]);
    await click("刷新账户与模型"); expect(container.textContent).toContain("未登录");
  });
  it("stops polling after expiry and allows another explicit attempt", async () => {
    vi.useFakeTimers(); mocks.getCodexAccount.mockResolvedValueOnce({ ...signedOut, login: pending }).mockResolvedValue({ ...signedOut, login: { ...pending, status: "expired" } });
    await render(); await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(container.textContent).toContain("登录已过期");
    await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(mocks.getCodexAccount).toHaveBeenCalledTimes(2);
    expect(mocks.startCodexLogin).not.toHaveBeenCalled();
  });
  it("uses account model results only after confirmed sign-in and handles model-list failure", async () => {
    mocks.getCodexAccount.mockResolvedValue({ status: "signed-in", email: "tester@example.com", planType: "plus", login: null });
    const list = [{ id: "one", model: "account-model", displayName: "Account model", isDefault: true }];
    mocks.listCodexModels.mockResolvedValueOnce({ models: list }).mockRejectedValueOnce(new Error("目录不可用"));
    await render(); expect(models).toHaveBeenLastCalledWith(list);
    await click("刷新账户与模型"); expect(models).toHaveBeenLastCalledWith([]); expect(container.textContent).toContain("模型列表加载失败");
  });
  it("requires the user's explicit logout action and refreshes its result", async () => {
    mocks.getCodexAccount.mockResolvedValueOnce({ status: "signed-in", login: null }).mockResolvedValue(signedOut);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true); mocks.logoutCodex.mockResolvedValue({ status: "signed-out" });
    await render(); await click("退出 ChatGPT"); expect(confirm).toHaveBeenCalledOnce(); expect(mocks.logoutCodex).toHaveBeenCalledOnce(); expect(container.textContent).toContain("未登录"); confirm.mockRestore();
  });
});
it("only exposes official HTTPS login origins", () => {
  expect(officialLoginUrl(start.verificationUrl)).toBe(start.verificationUrl);
  expect(officialLoginUrl("https://chatgpt.com/auth/login")).toBe("https://chatgpt.com/auth/login");
  expect(officialLoginUrl("https://auth0.openai.com/authorize")).toBe("https://auth0.openai.com/authorize");
  for (const url of ["javascript:alert(1)", "https://auth.openai.com.attacker.test/login", "http://auth.openai.com", "https://secret@auth.openai.com", "https://auth.openai.com:8443"]) expect(officialLoginUrl(url)).toBeNull();
});
