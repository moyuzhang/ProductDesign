import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { HardDrive, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import type { Backup, BackupProtectionChallenge, StorageRetentionSummary } from "../../shared/types";
import { api, BackupProtectionRequiredError } from "../api";
import { navigate } from "../App";
import { EmptyState, ErrorBanner, Field, Modal, Pagination, Spinner, formatDateTime } from "../ui";

export function BackupsView(): ReactElement {
  const limit = 20;
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [restoreWarnings, setRestoreWarnings] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [storage, setStorage] = useState<StorageRetentionSummary | null>(null);
  const [unconfigured, setUnconfigured] = useState(0);

  const reload = useCallback(() => {
    api.pageBackups({ offset, limit })
      .then((page) => { setBackups(page.items); setTotal(page.total); setError(""); })
      .catch((e) => setError(e.message));
  }, [offset]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    api.storageRetention().then(setStorage).catch(() => undefined);
    api.dashboard().then((dashboard) => setUnconfigured(dashboard.totals.unconfigured)).catch(() => undefined);
  }, []);

  const bytes = (value: number) => value < 1024 * 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;

  return (
    <div>
      <div className="page-header">
        <h1>备份</h1>
        <div className="sub">
          备份会导出项目业务资料、画布历史、原型、自由画布、项目模板及受控素材；不含账户、凭据、Agent 会话或运行态。JSON 快照保存在 <code className="mono">data/backups/</code> 目录下
        </div>
      </div>

      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <Plus size={14} /> 创建备份
        </button>
      </div>

      {storage ? (
        <div className="storage-retention-grid">
          <div className={storage.backups.overLimit ? "storage-card storage-warn" : "storage-card"}>
            {storage.backups.overLimit ? <TriangleAlert /> : <HardDrive />}
            <div><strong>备份容量</strong><span>{storage.backups.count} 个文件 · {bytes(storage.backups.bytes)}</span></div>
            <small>策略：最多 {storage.policy.maxBackupCount} 份 / {storage.policy.maxBackupAgeDays} 天；系统只提示，不会自动删除。</small>
          </div>
          <div className={storage.exports.overLimit ? "storage-card storage-warn" : "storage-card"}>
            {storage.exports.overLimit ? <TriangleAlert /> : <HardDrive />}
            <div><strong>导出容量</strong><span>{storage.exports.count} 个文件 · {bytes(storage.exports.bytes)}</span></div>
            <small>提示阈值 {bytes(storage.policy.maxExportBytes)}；清理由管理员在文件层确认后执行。</small>
          </div>
          <button className="storage-card storage-action" onClick={() => navigate("#/projects?configured=no")}>
            <TriangleAlert /><div><strong>待配置项目</strong><span>{unconfigured} 个疑似误导入或尚未展开的项目</span></div>
            <small>进入受控列表逐项核对；不会批量自动删除。</small>
          </button>
        </div>
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}
      {restoreWarnings.length ? <section className="storage-card storage-warn" role="status" aria-live="polite">
        <TriangleAlert /><div><strong>恢复已完成，请检查保护归档</strong>{restoreWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>
      </section> : null}

      {!backups ? (
        <Spinner />
      ) : backups.length === 0 ? (
        <EmptyState text="还没有备份。建议在做大规模调整前先创建一份快照。" />
      ) : (
        <table className="table">
          <thead>
            <tr><th>标签</th><th>原因</th><th>记录数</th><th>创建时间</th><th></th></tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.id}>
                <td className="cell-main">{b.label}</td>
                <td className="cell-sub">{b.reason || "—"}</td>
                <td className="mono">{b.itemCount}</td>
                <td className="mono cell-sub">{formatDateTime(b.createdAt)}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setRestoreTarget(b)}><RotateCcw size={13} /> 恢复</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {backups ? <Pagination offset={offset} limit={limit} total={total} onChange={setOffset} /> : null}

      {createOpen ? (
        <CreateBackupModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); reload(); }}
        />
      ) : null}
      {restoreTarget ? <RestoreBackupModal backup={restoreTarget} onClose={() => setRestoreTarget(null)} onRestored={(warnings) => { setRestoreWarnings(warnings); setRestoreTarget(null); setOffset(0); reload(); }} /> : null}
    </div>
  );
}

function RestoreBackupModal(props: { backup: Backup; onClose: () => void; onRestored: (warnings: string[]) => void }): ReactElement {
  const expected = `RESTORE ${props.backup.id}`;
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [protection, setProtection] = useState<BackupProtectionChallenge | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const submitting = useRef(false);
  const restore = async () => {
    if (submitting.current || confirmation !== expected || (protection && !acknowledged)) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const result = await api.restoreBackup(props.backup.id, confirmation, protection ? {
        sourceFingerprint: protection.sourceFingerprint, targetFingerprint: protection.targetFingerprint,
        acknowledgement: "PARTIAL_PROTECTION_IS_NOT_RESTORABLE",
      } : undefined);
      props.onRestored(result.warnings ?? []);
    } catch (cause) {
      // Every new challenge, including drift, requires a fresh explicit acknowledgement.
      setProtection(cause instanceof BackupProtectionRequiredError ? cause.protection : null);
      setAcknowledged(false);
      setError(cause instanceof Error ? cause.message : "恢复失败");
    } finally { submitting.current = false; setBusy(false); }
  };
  return (
    <Modal
      title={`恢复备份：${props.backup.label}`}
      onClose={() => { if (!submitting.current) props.onClose(); }}
      footer={<>
        <button className="btn" disabled={busy} onClick={props.onClose}>取消</button>
        <button className="btn btn-danger" disabled={busy || confirmation !== expected || Boolean(protection && !acknowledged)} onClick={() => void restore()}>确认恢复</button>
      </>}
    >
      {error ? <ErrorBanner message={error} /> : null}
      <p className="cell-sub">恢复会替换当前项目、画布、计划、文档、证据和治理数据；系统会先保存当前资料。素材缺失或损坏时，需要额外确认只能生成部分保护快照。</p>
      <Field label={`输入 ${expected} 以确认`}><input disabled={busy} value={confirmation} onChange={(e) => { setConfirmation(e.target.value); setAcknowledged(false); }} /></Field>
      {protection ? <section aria-label="部分保护快照确认">
        <h3>请核对当前资料的保护范围</h3>
        <p>缺损素材的可读原始字节及业务资料会被保留，但部分保护快照不可直接恢复，不能用它一键回退本次恢复。</p>
        {protection.issues.length ? <ul>{protection.issues.map((issue) => <li key={`${issue.projectId}:${issue.assetId}`}>
          项目 {issue.projectId} · 素材 {issue.assetId}：{issue.reason === "missing" ? "文件缺失" : "文件损坏"}；预期 {issue.expectedByteSize} 字节，实际 {issue.actualByteSize ?? "无法读取"}。
        </li>)}</ul> : <p>当前缺损清单已变化，未发现缺损；请重新核对当前资料与目标备份后确认。</p>}
        <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(e) => setAcknowledged(e.target.checked)} />我已核对缺损清单，理解部分保护快照不可直接恢复，仍确认替换当前业务资料</label>
      </section> : null}
    </Modal>
  );
}

function CreateBackupModal(props: { onClose: () => void; onCreated: () => void }): ReactElement {
  const [label, setLabel] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <Modal
      title="创建备份"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={busy || !label.trim()}
            onClick={() => {
              setBusy(true); setError("");
              api.createBackup(label.trim(), reason.trim())
                .then(() => props.onCreated())
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            创建
          </button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      <div className="form-grid">
        <Field label="标签"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如 重构数据模型前" /></Field>
        <Field label="原因（可选）"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
