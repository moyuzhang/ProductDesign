import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { DesignChangeRecovery, DesignChangeIntentResult } from "../../shared/types";
import { api } from "../api";
import { ErrorBanner, Field, Modal } from "../ui";

export function DesignChangeRecoveryPanel(props: { projectId: string; diagramId?: string; nodeId?: string }): ReactElement | null {
  const [candidates, setCandidates] = useState<DesignChangeRecovery[]>([]);
  const [selected, setSelected] = useState<DesignChangeRecovery | null>(null);
  const [error, setError] = useState("");
  const [submittedChangeId, setSubmittedChangeId] = useState("");
  const [result, setResult] = useState<DesignChangeIntentResult | null>(null);
  const [refreshId, setRefreshId] = useState(0);
  useEffect(() => {
    let active = true;
    setCandidates([]); setError("");
    api.listDesignChangeRecoveries(props.projectId)
      .then((items) => {
        if (active) setCandidates(items.filter((item) => (!props.diagramId || item.diagramId === props.diagramId) && (!props.nodeId || item.nodeId === props.nodeId)));
      }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "无法读取变更恢复入口"); });
    return () => { active = false; };
  }, [props.projectId, props.diagramId, props.nodeId, refreshId]);
  if (candidates.length === 0 && !error && !result) return null;
  return <section className="panel design-recovery-panel" aria-label="设计变更恢复">
    <h3>需求影响判断需要更正？申请独立复核</h3>
    <p>以下是服务端识别的未完成变更，原判定为“不影响需求”。这不代表原判断一定错误；如果发现影响需求或验收标准，应正式更正原变更，不能用补充配置文档绕过需求修订。</p>
    {error ? <ErrorBanner message={error} /> : null}
    {result ? <p role="status">更正意图 {result.intentId} 已提交，状态：{result.status}。提交本身不批准更正、不授权开发、不解除返工门禁；{result.status === "pending" ? "下一步由独立审批者复核。" : "请按服务端工单状态核对后续动作。"}</p> : null}
    {candidates.map((candidate) => <div className="toolbar" key={candidate.correctsChangeId}>
      <div><strong>{candidate.nodeLabel}</strong><p className="cell-sub">原变更 {candidate.correctsChangeId} · 根计划 {candidate.rootPlanId}</p><p>{candidate.reason}</p></div>
      <button className="btn" disabled={submittedChangeId === candidate.correctsChangeId && result?.status === "pending"} onClick={() => setSelected(candidate)}>{submittedChangeId === candidate.correctsChangeId && result?.status === "pending" ? "等待独立复核" : "申请更正需求影响判定"}</button>
    </div>)}
    <div className="toolbar"><button className="btn" onClick={() => setRefreshId((value) => value + 1)}>刷新恢复入口</button>{result ? <a className="btn" href="#/orchestration">查看独立审批工单</a> : null}</div>
    {selected ? <DesignChangeRecoveryModal projectId={props.projectId} candidate={selected} onClose={() => setSelected(null)} onSubmitted={(value) => { setSubmittedChangeId(selected.correctsChangeId); setResult(value); setSelected(null); setRefreshId((current) => current + 1); }} /> : null}
  </section>;
}

export function DesignChangeRecoveryModal(props: {
  projectId: string;
  candidate: DesignChangeRecovery;
  onClose: () => void;
  onSubmitted: (result: DesignChangeIntentResult) => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const requestKey = useRef({ signature: "", key: "" });
  const submit = useCallback(async () => {
    if (lock.current || !reason.trim() || !changeSummary.trim()) return;
    const payload = { correctsChangeId: props.candidate.correctsChangeId, diagramId: props.candidate.diagramId, nodeId: props.candidate.nodeId, rootPlanId: props.candidate.rootPlanId, expectedUpdatedAt: props.candidate.expectedUpdatedAt, reason: reason.trim(), changeSummary: changeSummary.trim(), requestedBy: "当前用户（需求影响更正）" };
    const signature = JSON.stringify(payload);
    if (requestKey.current.signature !== signature) requestKey.current = { signature, key: crypto.randomUUID() };
    lock.current = true; setBusy(true); setError("");
    try {
      const result = await api.submitDesignChangeIntent(props.projectId, { ...payload, idempotencyKey: requestKey.current.key });
      props.onSubmitted(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更正意图提交失败"); }
    finally { lock.current = false; setBusy(false); }
  }, [reason, changeSummary, props]);
  return <Modal title="申请更正需求影响判定" onClose={() => { if (!lock.current) props.onClose(); }} width={700} footer={<>
    <button className="btn" disabled={busy} onClick={props.onClose}>取消</button>
    <button className="btn btn-primary" disabled={busy || !reason.trim() || !changeSummary.trim()} onClick={() => void submit()}>{busy ? "提交中…" : "提交独立复核"}</button>
  </>}>
    <p>更正原变更 {props.candidate.correctsChangeId}，对应 {props.candidate.nodeLabel}。原审批、文档和证据保留历史记录；本次只追加更正意图。</p>
    <p>审批者须独立复核“影响需求”。批准后才能建立需求修订与恢复路径；本次提交不会把计划改成已验收，也不会自动批准或直接恢复施工。</p>
    {error ? <><ErrorBanner message={error} /><p className="cell-sub">如果服务端提示记录已变化，请关闭窗口并刷新恢复入口，再确认最新范围。不要绕过门禁修改旧记录。</p></> : null}
    <div className="form-grid">
      <Field label="为什么需要更正" wide><textarea disabled={busy} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明原来“不影响需求”的判断哪里不准确，以及依据" /></Field>
      <Field label="需求或验收标准的变化" wide><textarea disabled={busy} rows={4} value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} placeholder="说明需要新增或修订的需求、验收标准及受影响范围" /></Field>
    </div>
  </Modal>;
}
