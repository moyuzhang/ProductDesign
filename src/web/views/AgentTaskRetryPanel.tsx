import { useEffect, useRef, useState, type ReactElement } from "react";
import type { AgentTaskRetryCandidate, AgentTaskRetryRequestResult } from "../../shared/types";
import { api } from "../api";
import { ErrorBanner, Field, Modal } from "../ui";

export function AgentTaskRetryPanel({ projectId }: { projectId: string }): ReactElement {
  const [items, setItems] = useState<AgentTaskRetryCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<AgentTaskRetryCandidate | null>(null);
  const [receipt, setReceipt] = useState<AgentTaskRetryRequestResult | null>(null);
  const [submittedTaskKey, setSubmittedTaskKey] = useState("");
  useEffect(() => {
    let current = true;
    setLoading(true); setError(""); setItems([]);
    api.listAgentTaskRetryCandidates(projectId).then((value) => { if (current) setItems(value); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "无法读取可申请重试的任务"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectId, refresh]);
  useEffect(() => { setSelected(null); setReceipt(null); setSubmittedTaskKey(""); }, [projectId]);
  return <section className="panel agent-retry-panel" aria-label="单项任务额外重试">
    <div className="toolbar"><h2>单项任务额外重试</h2><button className="btn" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? "读取中…" : "刷新可申请任务"}</button></div>
    <p>达到尝试上限后，先说明失败原因和已采取的修复，再申请独立审批。批准只为当前任务的固定修订增加一次尝试，不清空工单历史、不重置次数、不修改项目级上限。</p>
    {error ? <ErrorBanner message={error} /> : null}
    {receipt ? <p role="status">申请 {receipt.requestId}：{receipt.status === "approved" ? receipt.authorizesRetry ? "已批准一次额外尝试，仍需按原流程领取任务并检查其他门禁" : "申请已审批，但当前未授权重试，请核对工单状态" : "等待独立审批，尚未授权重试"}。提交或批准都不会自动启动任务。</p> : null}
    {!loading && !error && items.length === 0 ? <p>服务端当前没有返回符合额外重试申请条件的任务。</p> : null}
    {items.map((candidate) => {
      const pending = Boolean(candidate.pendingRequestId) || (submittedTaskKey === candidate.taskKey && receipt?.status === "pending");
      return <article className="agent-retry-candidate" key={`${candidate.taskKey}:${candidate.taskRevision}`}>
        <h3>{candidate.title}</h3>
        <p>{candidate.role} · {candidate.actionCode} · 已尝试 {candidate.attempt} 次 / 上限 {candidate.maxAttempts} 次</p>
        <p>失败工单：<span className="mono">{candidate.failedWorkOrderId}</span></p>
        <p>上次失败：{candidate.lastError || "服务端未提供失败详情；请先核对原工单"}</p>
        <details><summary>查看固定任务标识</summary><p className="mono">{candidate.taskKey}</p><p className="mono">修订：{candidate.taskRevision}</p></details>
        <button className="btn" disabled={pending} onClick={() => setSelected(candidate)}>{pending ? "等待独立审批" : "申请一次额外尝试"}</button>
        {candidate.pendingRequestId ? <p className="cell-sub">申请 {candidate.pendingRequestId} 已存在，请查看待常规批准工单。</p> : null}
      </article>;
    })}
    {selected ? <AgentTaskRetryModal projectId={projectId} candidate={selected} onClose={() => setSelected(null)} onSubmitted={(value) => { setSubmittedTaskKey(selected.taskKey); setReceipt(value); setSelected(null); setRefresh((current) => current + 1); }} /> : null}
  </section>;
}

export function AgentTaskRetryModal(props: {
  projectId: string;
  candidate: AgentTaskRetryCandidate;
  onClose: () => void;
  onSubmitted: (receipt: AgentTaskRetryRequestResult) => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [remediation, setRemediation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const retry = useRef({ signature: "", key: "" });
  const submit = async () => {
    if (lock.current || !reason.trim() || !remediation.trim()) return;
    const body = { taskKey: props.candidate.taskKey, taskRevision: props.candidate.taskRevision, failedWorkOrderId: props.candidate.failedWorkOrderId, expectedAttempt: props.candidate.attempt, reason: reason.trim(), remediation: remediation.trim() };
    const signature = JSON.stringify(body);
    if (signature !== retry.current.signature) retry.current = { signature, key: crypto.randomUUID() };
    lock.current = true; setBusy(true); setError("");
    try { props.onSubmitted(await api.requestAgentTaskRetry(props.projectId, { ...body, idempotencyKey: retry.current.key })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "额外重试申请失败"); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Modal title={`申请一次额外尝试 · ${props.candidate.title}`} onClose={() => { if (!lock.current) props.onClose(); }} width={720} footer={<>
    <button className="btn" disabled={busy} onClick={props.onClose}>取消</button>
    <button className="btn btn-primary" disabled={busy || !reason.trim() || !remediation.trim()} onClick={() => void submit()}>{busy ? "提交中…" : "提交独立审批"}</button>
  </>}>
    <p>本次仅针对失败工单 {props.candidate.failedWorkOrderId} 对应的任务修订。新的独立审批通过后，最多增加一次尝试；其他审批、依赖、资源锁和工单要求仍有效。</p>
    <p>上次失败：{props.candidate.lastError || "请核对原工单"}</p>
    {error ? <><ErrorBanner message={error} /><p>如果任务修订、尝试次数或失败工单已经变化，请保留这些说明，关闭后刷新任务再申请。不会自动替换申请范围。</p></> : null}
    <div className="form-grid">
      <Field label="重试理由" wide><textarea disabled={busy} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明为什么这一次额外尝试有必要" /></Field>
      <Field label="已采取的修复或调整" wide><textarea disabled={busy} rows={4} value={remediation} onChange={(event) => setRemediation(event.target.value)} placeholder="说明上次失败原因、具体修复，以及为什么不会重复相同失败" /></Field>
    </div>
  </Modal>;
}
