import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CodexRuntimeStatus } from "../api";

export function useCodexRuntime(enabled = true) {
  const [status, setStatus] = useState<CodexRuntimeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    const request = ++sequence.current;
    if (!enabled) return;
    setStatus(null); setError("");
    void Promise.resolve().then(() => api.getCodexRuntime()).then((next) => {
      if (sequence.current === request) setStatus(next);
    }).catch((cause: unknown) => {
      if (sequence.current === request) setError(cause instanceof Error ? cause.message : "无法读取运行环境状态");
    });
    return () => { sequence.current++; };
  }, [enabled]);
  const check = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    const request = ++sequence.current;
    setChecking(true); setError(""); setStatus(null);
    try {
      const next = await api.checkCodexRuntime();
      if (sequence.current === request) setStatus(next);
    } catch (cause) {
      if (sequence.current === request) setError(cause instanceof Error ? cause.message : "运行环境检查失败，请重试");
    } finally {
      lock.current = false;
      setChecking(false);
    }
  }, []);
  return { status, checking, error, check };
}
export function CodexRuntimePanel({ runtime }: { runtime: ReturnType<typeof useCodexRuntime> }) {
  const { status, checking, error, check } = runtime;
  const label = checking ? "检查中" : error ? "状态读取失败" : status?.status === "ready" ? "就绪" : status?.status === "unavailable" ? "不可用" : "未检查";
  return <section className="agent-control-note" aria-label="Codex 设计运行环境">
    <strong>Codex 设计运行环境：{label}</strong>
    <p role={error ? "alert" : "status"}>{error || (checking ? "正在检查本机隔离与只读限制…" : status?.message || "请先检查本机设计运行环境")}</p>
    {status?.code && <p>诊断代码：{status.code}</p>}
    {status?.version && <p>运行版本：{status.version}</p>}
    {status?.checkedAt && <p>检查时间：{status.checkedAt}</p>}
    <button type="button" className="btn" disabled={checking} onClick={() => void check()}>{checking ? "检查中…" : "检查设计运行环境"}</button>
    <p>检查仅验证本机运行能力，不会登录或请求模型。就绪不代表账户已登录、拥有模型权限或额度；发送时仍由后端校验。不会自动回退到 API Key，主动选择 API 通道会独立计费。</p>
  </section>;
}
export function CodexRuntimeSettings() {
  const runtime = useCodexRuntime();
  return <CodexRuntimePanel runtime={runtime} />;
}
