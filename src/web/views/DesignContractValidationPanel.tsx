import { useEffect, useState, type ReactElement } from "react";
import type { DesignContractReport } from "../../shared/designContract";
import { api } from "../api";
import { ErrorBanner, Pagination } from "../ui";

const STATUS_LABELS: Record<DesignContractReport["status"], string> = {
  unassessed: "尚未评估",
  partial: "仅完成部分检查",
  invalid: "发现结构或一致性问题",
  valid: "已声明的结构一致",
};
const PHASE_LABELS: Record<string, string> = { design: "设计", build: "开发", verification: "验证", acceptance: "验收" };

export function validationPlanHref(plan: DesignContractReport["plans"][number]): string | null {
  return plan.diagramId && plan.nodeId ? `#/canvas/${encodeURIComponent(plan.diagramId)}/node/${encodeURIComponent(plan.nodeId)}?tab=development&plan=${encodeURIComponent(plan.id)}` : null;
}
export function validationCycleLabel(vertex: string, plans: DesignContractReport["plans"]): string {
  try {
    const pair: unknown = JSON.parse(vertex);
    if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string") {
      const plan = plans.find((item) => item.id === pair[0]);
      return `${plan?.title ?? pair[0]} · ${PHASE_LABELS[pair[1]] ?? pair[1]}`;
    }
  } catch { /* Unknown vertices are shown as reported, never turned into invented links. */ }
  return vertex;
}

export function designIssueGuidance(code: string): string {
  if (code === "CONTRACT_NOT_APPROVED") return "通过既有评审路径审核设计合同草稿；不能把草稿视为已批准。";
  if (code === "CONTRACT_REFERENCE_REMOVED") return "恢复经过治理的显式合同引用；不能静默回退到旧流程或猜测最新文档。";
  if (code === "CONTRACT_ABSENT") return "先创建独立需求清单和设计合同草稿，再明确引用固定修订。";
  if (code.includes("STALE")) return "重新读取当前计划和文档，在受控修订中刷新映射与引用后重新检查。";
  if (code === "PHASE_DEPENDENCY_CYCLE") return "修订设计阶段依赖，解除真实循环；不要跳过门禁或伪造证据。";
  if (code === "INTERFACE_MISMATCH") return "核对批准基线中的 HTTP 方法和路径，再修订设计草稿。";
  if (code.includes("LABEL_MISMATCH") || code.includes("DANGLING") || code.includes("NODE_MISMATCH")) return "核对真实计划、节点和文档 ID，再修订错误的名称、归属或引用。";
  if (code.includes("UNCOVERED") || code.includes("PARTIAL") || code.includes("NOT_APPROVED") || code.includes("UNASSESSED")) return "补齐独立基线或缺失的验收标准/接口映射，并按原流程送审。";
  return "按报告位置核对结构化基线与合同，修订草稿后重新检查。";
}

export function DesignContractValidationPanel({ projectId, planId }: { projectId: string; planId?: string }): ReactElement {
  const [issueOffset, setIssueOffset] = useState(0);
  const [coverageOffset, setCoverageOffset] = useState(0);
  const [cycleOffset, setCycleOffset] = useState(0);
  const [report, setReport] = useState<DesignContractReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true); setReport(null); setError(""); setIssueOffset(0); setCoverageOffset(0); setCycleOffset(0);
    api.getDesignContractValidation(projectId, planId).then((value) => { if (current) setReport(value); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "设计一致性检查不可用"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectId, planId, refresh]);
  const planLink = (id: string) => {
    const plan = report?.plans.find((item) => item.id === id);
    const href = plan ? validationPlanHref(plan) : null;
    return href ? <a key={id} href={href}>{plan!.title}（{id}）</a> : <span key={id}>{plan?.title ?? id}</span>;
  };
  return <section className="panel design-contract-report" aria-label="设计覆盖与一致性检查">
    <div className="toolbar"><h2>设计覆盖与一致性检查</h2><button className="btn" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? "检查中…" : "重新检查（只读）"}</button></div>
    <p>检查独立需求基线中明确声明的验收标准、计划/节点身份、固定修订、API 方法与路径，以及设计/开发/验证/验收之间的循环等待。</p>
    <p className="cell-sub">仅检查已声明的结构化事实，不能证明自然语言需求已被完整理解，也不代表交付已验收。此处不会批准、修复或更改项目。审计列只核对已有记录，不重新运行测试、检查产物字节或执行验收。</p>
    {error ? <ErrorBanner message={error} /> : null}
    {report ? <>
      <h3 role="status">{STATUS_LABELS[report.status]}</h3>
      {report.status === "unassessed" ? <p>先建立并明确引用独立需求基线与设计合同。不能从已有计划反推需求清单，再据此宣称覆盖完整。</p> : null}
      {report.status === "partial" ? <p>基线、映射或接口事实仍有待确认项。补齐下方缺失内容并按原流程评审后，再重新检查。</p> : null}
      {report.status === "invalid" ? <p>先按问题定位修订设计、映射或阶段依赖，再重新检查；不要伪造证据或绕过审批解决循环等待。</p> : null}
      {report.status === "valid" ? <p>本次声明范围内未发现结构性冲突。未声明的需求仍需人工评审；实际实现证据与最终验收另行判断。</p> : null}
      <details className="design-contract-sources"><summary>本次检查引用的固定文档版本</summary>
        <p>独立需求基线：{report.baselineRef ? `${report.baselineRef.documentId} / ${report.baselineRef.revisionId}` : "未提供"}</p>
        <p>设计合同：{report.contractRef ? `${report.contractRef.documentId} / ${report.contractRef.revisionId}` : "未提供"}</p>
        <a href={`#/projects/${encodeURIComponent(projectId)}?tab=documents`}>到项目文档列表核对以上 ID 与修订</a>
      </details>
      {report.issues.length > 0 ? <ol className="design-contract-issues" aria-label="需要处理的设计问题">{report.issues.slice(issueOffset, issueOffset + 20).map((issue, index) => <li key={`${issue.code}:${issue.path}:${index}`}>
        <strong>{issue.message}</strong><p>{designIssueGuidance(issue.code)}</p><p className="cell-sub">{issue.code} · 位置：{issue.path || "未指定"}</p>
        {issue.entityIds.length > 0 ? <div className="design-contract-refs">{issue.entityIds.map((id, entityIndex) => <span key={`${id}:${entityIndex}`}>{planLink(id)}</span>)}</div> : null}
      </li>)}</ol> : null}
      <Pagination offset={issueOffset} limit={20} total={report.issues.length} onChange={setIssueOffset} />
      {report.cycles.length > 0 ? <div aria-label="阶段循环等待"><h3>需要修订的循环依赖</h3>{report.cycles.slice(cycleOffset, cycleOffset + 10).map((cycle, index) => <p className="design-contract-cycle" key={index}>{cycle.map((vertex) => validationCycleLabel(vertex, report.plans)).join(" → ")}</p>)}<Pagination offset={cycleOffset} limit={10} total={report.cycles.length} onChange={setCycleOffset} /></div> : null}
      {report.coverage.length > 0 ? <>
        <p>已映射验收标准 {report.coverage.filter((item) => item.covered).length} / {report.coverage.length}；当前标准匹配审计记录 {report.coverage.filter((item) => item.verified).length} / {report.coverage.length}</p>
        <div className="design-contract-table"><table className="table"><thead><tr><th>需求 / 验收标准</th><th>关联计划</th><th>设计映射</th><th>当前修订审计记录</th></tr></thead><tbody>
          {report.coverage.slice(coverageOffset, coverageOffset + 20).map((item, index) => <tr key={`${item.requirementId}:${item.criterionKey}:${index}`}>
            <td>{item.requirementId}<br /><span className="cell-sub">{item.criterionKey}</span></td>
            <td><div className="design-contract-refs">{item.planIds.length ? item.planIds.map((id, planIndex) => <span key={`${id}:${planIndex}`}>{planLink(id)}</span>) : "无有效映射"}</div></td>
            <td>{item.covered ? "已映射" : "缺少映射"}</td><td>{item.verified ? "有匹配审计记录" : "未找到匹配审计记录"}</td>
          </tr>)}
        </tbody></table></div>
        <Pagination offset={coverageOffset} limit={20} total={report.coverage.length} onChange={setCoverageOffset} />
      </> : <p>尚无可展示的结构化覆盖清单，不能据此认定没有遗漏。</p>}
    </> : null}
  </section>;
}
