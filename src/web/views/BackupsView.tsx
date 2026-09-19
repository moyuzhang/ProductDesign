import { useCallback, useEffect, useState, type ReactElement } from "react";
import { HardDrive, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import type { Backup, StorageRetentionSummary } from "../../shared/types";
import { api } from "../api";
import { navigate } from "../App";
import { EmptyState, ErrorBanner, Field, Modal, Pagination, Spinner, formatDateTime } from "../ui";

export function BackupsView(): ReactElement {
  const limit = 20;
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
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
          备份会把全部数据导出为 JSON 快照，保存在 <code className="mono">data/backups/</code> 目录下
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
      {restoreTarget ? <RestoreBackupModal backup={restoreTarget} onClose={() => setRestoreTarget(null)} onRestored={() => { setRestoreTarget(null); setOffset(0); reload(); }} /> : null}
    </div>
  );
}

function RestoreBackupModal(props: { backup: Backup; onClose: () => void; onRestored: () => void }): ReactElement {
  const expected = `RESTORE ${props.backup.id}`;
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={`恢复备份：${props.backup.label}`}
      onClose={props.onClose}
      footer={<>
        <button className="btn" onClick={props.onClose}>取消</button>
        <button className="btn btn-danger" disabled={busy || confirmation !== expected} onClick={() => {
          setBusy(true); setError("");
          api.restoreBackup(props.backup.id, confirmation).then(props.onRestored).catch((e) => setError(e.message)).finally(() => setBusy(false));
        }}>确认恢复</button>
      </>}
    >
      {error ? <ErrorBanner message={error} /> : null}
      <p className="cell-sub">恢复会替换当前项目、画布、计划、文档、证据和治理数据；系统会先自动创建一份恢复前快照。</p>
      <Field label={`输入 ${expected} 以确认`}><input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field>
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
