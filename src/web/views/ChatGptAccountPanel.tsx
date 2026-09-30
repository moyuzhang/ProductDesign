import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { CodexAccountStatus, CodexLoginStart, CodexModel } from "../../shared/types";
import { api } from "../api";
import { ErrorBanner } from "../ui";
import { DESIGN_SUBSCRIPTION_BLOCKED_MESSAGE } from "./designAssistant";

export type AccountModel = CodexModel;

// Only render links to official authentication origins, never arbitrary backend text as a URL.
export function officialLoginUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

export function ChatGptAccountPanel(props: {
  onModelsChange: (models: AccountModel[]) => void;
  onAccountChange: () => unknown;
}): ReactElement {
  const [account, setAccount] = useState<CodexAccountStatus | null>(null);
  const [attempt, setAttempt] = useState<CodexLoginStart | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loginType, setLoginType] = useState<"chatgpt" | "chatgptDeviceCode">("chatgptDeviceCode");
  const callbacks = useRef(props);
  callbacks.current = props;
  const mounted = useRef(false);
  const actionLock = useRef(false);
  const refreshGeneration = useRef(0);
  const previousStatus = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const next = await api.getCodexAccount();
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setAccount(next);
      setError("");
      if (next.login && next.login.status !== "pending") {
        setAttempt(null);
        setNotice(next.login.message || ({ succeeded: "官方登录已完成", failed: "登录失败，请重新登录", cancelled: "登录已取消", expired: "登录已过期，请重新登录" }[next.login.status] ?? ""));
      }
      if (previousStatus.current !== undefined && previousStatus.current !== next.status) void callbacks.current.onAccountChange();
      previousStatus.current = next.status;
      if (next.status !== "signed-in") { callbacks.current.onModelsChange([]); return; }
      try {
        const result = await api.listCodexModels();
        if (mounted.current && generation === refreshGeneration.current) callbacks.current.onModelsChange(result.models);
      } catch (cause) {
        if (mounted.current && generation === refreshGeneration.current) {
          callbacks.current.onModelsChange([]);
          setError(`账户已登录，但模型列表加载失败：${cause instanceof Error ? cause.message : "请重试"}`);
        }
      }
    } catch (cause) {
      if (mounted.current && generation === refreshGeneration.current) {
        setAccount(null); callbacks.current.onModelsChange([]);
        setError(cause instanceof Error ? cause.message : "无法读取账户状态");
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; refreshGeneration.current += 1; };
  }, [refresh]);
  useEffect(() => {
    if (account?.login?.status !== "pending" || error) return;
    let cancelled = false;
    let timer: number;
    const tick = async () => {
      if (!actionLock.current) await refresh();
      if (!cancelled) timer = window.setTimeout(() => void tick(), 2500);
    };
    timer = window.setTimeout(() => void tick(), 2500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [account?.login?.status, error, refresh]);

  const run = async (kind: string, action: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(kind); setError(""); setNotice("");
    refreshGeneration.current += 1;
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "操作失败，请刷新状态后重试"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(""); }
  };
  const pendingId = account?.login?.status === "pending" ? account.login.loginId : attempt?.loginId;
  const loginUrl = attempt ? officialLoginUrl(attempt.type === "chatgpt" ? attempt.authUrl : attempt.verificationUrl) : null;

  return <section className="chatgpt-account-panel panel" aria-label="ChatGPT 账户登录">
    <h2>ChatGPT 账户登录</h2>
    <p className="error-banner">{DESIGN_SUBSCRIPTION_BLOCKED_MESSAGE} 如主动选择 API Key 设计通道，将由对应 API 独立计费。</p>
    <p>供本机个人使用，通过官方 Codex 登录使用符合条件的订阅。账户共享于本机 ProductDesign 的 ChatGPT 配置；可用模型与额度取决于账户权限。</p>
    <p role="status">{account?.status === "signed-in" ? `已登录${account.email ? ` · ${account.email}` : ""}${account.planType ? ` · ${account.planType}` : ""}` : account ? "未登录" : error ? "账户状态未知" : "正在读取账户状态…"}</p>
    {error ? <ErrorBanner message={error} /> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {pendingId ? <div className="chatgpt-login-pending">
      <strong>等待你在官方页面完成登录</strong>
      <p>密码和授权只在 OpenAI 官方页面输入；不要将密码或令牌粘贴到此处。关闭此页不会批准登录；如需终止，请取消登录。</p>
      {attempt?.type === "chatgptDeviceCode" ? <p>一次性设备码：<code>{attempt.userCode}</code></p> : null}
      {loginUrl ? <a className="btn btn-primary" href={loginUrl} target="_blank" rel="noopener noreferrer">打开 OpenAI 官方登录</a> : <p>{attempt ? "登录地址未通过官方来源校验，请取消后重试。" : "登录请求仍在等待；如已关闭官方页面，可取消后重新登录。"}</p>}
      <p className="cell-sub">有效期至 {attempt?.expiresAt ?? account?.login?.expiresAt}。设备登录可能需要在 ChatGPT 设置中启用。</p>
      <button className="btn" disabled={Boolean(busy)} onClick={() => void run("cancel", async () => { await api.cancelCodexLogin(pendingId); if (mounted.current) { setAttempt(null); setNotice("已请求取消登录"); } await refresh(); })}>{busy === "cancel" ? "取消中…" : "取消登录"}</button>
    </div> : null}
    <div className="toolbar">
      <button className="btn" disabled={Boolean(busy)} onClick={() => void run("refresh", refresh)}>{busy === "refresh" ? "刷新中…" : "刷新账户与模型"}</button>
      {!pendingId ? <>
        <label>登录方式 <select aria-label="ChatGPT 登录方式" value={loginType} disabled={Boolean(busy)} onChange={(event) => setLoginType(event.target.value as typeof loginType)}><option value="chatgptDeviceCode">设备码登录</option><option value="chatgpt">浏览器登录（本机回调）</option></select></label>
        <button className="btn btn-primary" disabled={Boolean(busy) || !account} onClick={() => void run("login", async () => { const result = await api.startCodexLogin(loginType); if (mounted.current) setAttempt(result); await refresh(); })}>{busy === "login" ? "准备登录…" : account?.status === "signed-in" ? "重新登录 ChatGPT" : "开始 ChatGPT 登录"}</button>
      </> : null}
      {account?.status === "signed-in" ? <button className="btn btn-danger" disabled={Boolean(busy)} onClick={() => {
        if (window.confirm("退出本机 Codex 的 ChatGPT 账户？使用该账户的 ProductDesign 配置将暂时无法运行。")) void run("logout", async () => { await api.logoutCodex(); if (mounted.current) setAttempt(null); await refresh(); });
      }}>{busy === "logout" ? "退出中…" : "退出 ChatGPT"}</button> : null}
    </div>
    <p className="cell-sub">API Key 配置独立保留。保存模型配置不会发起登录；登录成功也不代表任意模型都能使用。</p>
  </section>;
}
