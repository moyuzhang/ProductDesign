import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { BookOpen, Braces, Check, ChevronLeft, Clipboard, Code2, Database, Download, Focus, GitFork, KeyRound, LayoutGrid, Link2, Plus, RefreshCw, Rocket, Save, Search, Star, Table2, Trash2, WandSparkles, X } from "lucide-react";
import {
  DATABASE_CODE_TARGETS,
  DATABASE_DATA_TYPES,
  DATABASE_DIALECTS,
  type DatabaseCodeResult,
  type DatabaseCodeTarget,
  type DatabaseConnectionInput,
  type DatabaseDeployPreview,
  type DesignDoc,
  type DatabaseField,
  type DatabaseIndex,
  type DatabaseModel,
  type DatabaseRelation,
  type DatabaseReversePreview,
  type DatabaseTable,
  type Paginated,
} from "../../shared/types.js";
import { api } from "../api.js";
import { navigate } from "../App.js";
import { Badge, EmptyState, ErrorBanner, Field, Modal, Pagination, Spinner, formatDateTime } from "../ui.js";
import { agentVisibleContent, useAgentUiBridge } from "./agentUiBridge.js";
import { databaseRelationCounts, matchesDatabaseTableQuery, rankDatabaseTables, relatedDatabaseTableIds } from "./databaseNavigator.js";
import { DocumentReferencePanel } from "./DocumentReferencePanel.js";

const PAGE_SIZE = 12;
const TABLE_WIDTH = 292;
const TABLE_HEADER = 47;
const FIELD_ROW = 29;
const FIELD_COMMENT_ROW = 13;

function readStoredTableIds(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const DIALECT_LABEL: Record<DatabaseModel["dialect"], string> = { mysql: "MySQL 8", postgresql: "PostgreSQL", sqlite: "SQLite" };
const TARGET_LABEL: Record<DatabaseCodeTarget | "ddl", string> = {
  ddl: "SQL DDL",
  "java-jpa": "Java · JPA",
  "java-mybatis-plus": "Java · MyBatis-Plus",
  "typescript-typeorm": "TypeScript · TypeORM",
  "csharp-ef-core": "C# · EF Core",
  "go-gorm": "Go · GORM",
};

function uid(): string {
  return crypto.randomUUID();
}

function createField(name = "id", primaryKey = false): DatabaseField {
  return { id: uid(), name, type: primaryKey ? "uuid" : "string", length: primaryKey ? undefined : 255, nullable: !primaryKey, primaryKey, autoIncrement: false, unique: primaryKey, defaultValue: "", comment: "" };
}

function createTable(index: number, name?: string): DatabaseTable {
  return { id: uid(), name: name ?? `table_${index}`, displayName: "", comment: "", x: 90 + ((index - 1) % 3) * 350, y: 90 + Math.floor((index - 1) / 3) * 310, fields: [createField("id", true)], indexes: [] };
}

function tableHeight(table: DatabaseTable): number {
  return TABLE_HEADER
    + Math.max(1, table.fields.length) * FIELD_ROW
    + table.fields.filter((field) => field.comment.trim()).length * FIELD_COMMENT_ROW
    + 13;
}

function connectionDraft(dialect: DatabaseModel["dialect"]): DatabaseConnectionInput {
  return dialect === "sqlite"
    ? { dialect, filePath: "data/control-surface.db" }
    : { dialect, host: "127.0.0.1", port: dialect === "mysql" ? 3306 : 5432, database: "", schema: dialect === "postgresql" ? "public" : undefined, username: "", password: "", ssl: false };
}

function ConnectionFields({ value, onChange, dialectLocked = false }: { value: DatabaseConnectionInput; onChange: (value: DatabaseConnectionInput) => void; dialectLocked?: boolean }): ReactElement {
  const patch = (next: Partial<DatabaseConnectionInput>) => onChange({ ...value, ...next });
  const setDialect = (dialect: DatabaseModel["dialect"]) => onChange(connectionDraft(dialect));
  return <div className="db-connection-form">
    <Field label="数据库类型" wide><select disabled={dialectLocked} value={value.dialect} onChange={(event) => setDialect(event.target.value as DatabaseModel["dialect"])}>{DATABASE_DIALECTS.map((dialect) => <option key={dialect} value={dialect}>{DIALECT_LABEL[dialect]}</option>)}</select></Field>
    {value.dialect === "sqlite" ? <Field label="SQLite 文件路径" wide><input value={value.filePath ?? ""} placeholder="D:\\project\\app\\data\\app.db" onChange={(event) => patch({ filePath: event.target.value })} /></Field> : <>
      <div className="db-connection-section"><span>服务器</span></div>
      <Field label="主机"><input value={value.host ?? ""} placeholder="127.0.0.1" onChange={(event) => patch({ host: event.target.value })} /></Field>
      <Field label="端口"><input type="number" value={value.port ?? ""} onChange={(event) => patch({ port: Number(event.target.value) })} /></Field>
      <label className="db-ssl-field"><input type="checkbox" checked={value.ssl ?? false} onChange={(event) => patch({ ssl: event.target.checked })} /> 使用 SSL 连接</label>
      <div className="db-connection-section"><span>数据库</span></div>
      <Field label="数据库" wide={value.dialect !== "postgresql"}><input value={value.database ?? ""} onChange={(event) => patch({ database: event.target.value })} /></Field>
      {value.dialect === "postgresql" ? <Field label="Schema"><input value={value.schema ?? "public"} onChange={(event) => patch({ schema: event.target.value })} /></Field> : null}
      <div className="db-connection-section"><span>登录</span></div>
      <Field label="用户名"><input autoComplete="username" value={value.username ?? ""} onChange={(event) => patch({ username: event.target.value })} /></Field>
      <Field label="密码"><input type="password" autoComplete="current-password" value={value.password ?? ""} onChange={(event) => patch({ password: event.target.value })} /></Field>
    </>}
    <p className="db-secret-note">密码只用于当前操作，不会保存到模型或审计日志。</p>
  </div>;
}

function ChangePreview({ changes }: { changes: DatabaseReversePreview["changes"] }): ReactElement {
  if (!changes.length) return <div className="db-engineering-empty"><Check /> 数据结构没有差异</div>;
  return <div className="db-change-list">{changes.slice(0, 80).map((change, index) => <div key={`${change.path}-${index}`} className={`db-change db-change-${change.kind}`}><span>{change.kind === "add" ? "+" : change.kind === "remove" ? "−" : "~"}</span><div><strong>{change.path}</strong><small>{change.detail}</small></div>{change.destructive ? <i>覆盖</i> : null}</div>)}</div>;
}

function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadBundle(result: DatabaseCodeResult): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const file of result.files) zip.file(file.name, file.code);
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = `database-${result.target}.zip`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type DatabaseSurface = "project" | "canvas";

function ListView({ projectId, embedded, surface }: { projectId: string; embedded?: boolean; surface: DatabaseSurface }): ReactElement {
  const [page, setPage] = useState<Paginated<DatabaseModel> | null>(null);
  const [q, setQ] = useState("");
  const [dialect, setDialect] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("核心业务库");
  const [newDialect, setNewDialect] = useState<DatabaseModel["dialect"]>("mysql");
  const [importing, setImporting] = useState(false);
  const [importName, setImportName] = useState("数据库导入模型");
  const [importConnection, setImportConnection] = useState<DatabaseConnectionInput>(() => connectionDraft("sqlite"));
  const [importPreview, setImportPreview] = useState<DatabaseReversePreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();
  const modelPath = (modelId: string) => surface === "canvas"
    ? `#/canvas/database/${modelId}`
    : `#/projects/${projectId}/database/${modelId}`;

  const reload = useCallback(() => {
    setError("");
    api.pageDatabaseModels({ projectId, q: q || undefined, dialect: dialect || undefined, offset, limit: PAGE_SIZE })
      .then(setPage)
      .catch((cause: Error) => setError(cause.message));
  }, [projectId, q, dialect, offset]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!page) return;
    setPageContextDetail({
      projectId,
      pageType: "database",
      title: "数据库模型",
      entityRefs: [{ type: "project", id: projectId }, ...page.items.map((model) => ({ type: "databaseModel" as const, id: model.id, label: model.name }))],
      selection: { entityRefs: [] },
      draft: null,
      visibleContent: agentVisibleContent("databaseModelList", "当前可见数据库模型", page.items.map((model) => ({
        id: model.id, name: model.name, dialect: model.dialect, tables: model.tables.map((table) => ({ id: table.id, name: table.name, displayName: table.displayName })),
        relationCount: model.relations.length, updatedAt: model.updatedAt,
      }))),
    });
  }, [page, projectId, setPageContextDetail]);
  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);
  useEffect(() => {
    if (lastEntityChange?.value.entityType === "databaseModel" && lastEntityChange.value.projectId === projectId) reload();
  }, [lastEntityChange, projectId, reload]);

  const create = async () => {
    try {
      const model = await api.createDatabaseModel({ projectId, name: newName.trim(), dialect: newDialect, tables: [createTable(1, "users")], relations: [] });
      setCreating(false);
      navigate(modelPath(model.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const remove = async (model: DatabaseModel) => {
    if (!window.confirm(`删除数据库模型“${model.name}”？`)) return;
    try { await api.deleteDatabaseModel(model.id); reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const previewImport = async () => {
    setImportBusy(true); setError("");
    try { setImportPreview(await api.previewDatabaseImport(projectId, importName.trim(), importConnection)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setImportBusy(false); }
  };

  const applyImport = async () => {
    setImportBusy(true); setError("");
    try {
      const model = await api.importDatabaseModel(projectId, importName.trim(), importConnection);
      setImporting(false); navigate(modelPath(model.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setImportBusy(false); }
  };

  if (!page) return <Spinner />;
  const tableCount = page.items.reduce((sum, model) => sum + model.tables.length, 0);
  const relationCount = page.items.reduce((sum, model) => sum + model.relations.length, 0);

  return (
    <div className={`db-page db-page-${surface} ${embedded ? "db-page-embedded" : ""}`}>
      {error ? <ErrorBanner message={error} /> : null}
      <section className="db-workspace-command">
        <div className="db-workspace-heading">
          <div className="db-workspace-title"><span className="db-workspace-symbol"><Database /></span><div><span>DATA MODELING</span><h2>数据库设计</h2>{!embedded ? <p>设计 ER 模型、表关系，并从同一结构生成实体代码</p> : null}</div></div>
          <div className="db-compact-metrics" aria-label="数据库设计统计">
            <span><strong>{page.total}</strong> 模型</span>
            <span><strong>{tableCount}</strong> 当前页数据表</span>
            <span><strong>{relationCount}</strong> 当前页关系</span>
          </div>
          <div className="db-workspace-actions"><button className="btn" onClick={() => { setImportPreview(null); setImporting(true); }}><RefreshCw /> 从数据库导入</button><button className="btn btn-primary db-create-model" onClick={() => setCreating(true)}><Plus /> 新建模型</button></div>
        </div>
        <div className="db-list-toolbar">
          <div className="search-box"><input value={q} onChange={(event) => { setQ(event.target.value); setOffset(0); }} placeholder="搜索模型或表名…" /></div>
          <select value={dialect} onChange={(event) => { setDialect(event.target.value); setOffset(0); }} aria-label="数据库类型"><option value="">全部数据库</option>{DATABASE_DIALECTS.map((value) => <option key={value} value={value}>{DIALECT_LABEL[value]}</option>)}</select>
          <span className="db-result-count">共 {page.total} 个模型</span>
        </div>
      </section>
      {page.items.length === 0 ? (
        <div className="db-empty-guide">
          <span className="db-empty-guide-icon"><Database /></span>
          <h3>还没有数据库模型</h3>
          <p>为当前项目设计 ER 模型，或从已有数据库逆向导入表结构。</p>
          <div className="db-empty-actions">
            <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus /> 新建模型</button>
            <button className="btn" onClick={() => { setImportPreview(null); setImporting(true); }}><RefreshCw /> 从数据库导入</button>
          </div>
        </div>
      ) : (
        <div className="db-model-grid">{page.items.map((model) => (
          <article className="db-model-card" key={model.id} role="button" tabIndex={0}
            onClick={() => navigate(modelPath(model.id))}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(modelPath(model.id)); } }}>
            <div className="db-model-icon"><Database /></div>
            <div className="db-model-main"><div className="db-model-title"><strong>{model.name}</strong><Badge tone="info">{DIALECT_LABEL[model.dialect]}</Badge></div><span>ER MODEL · 最近更新 {formatDateTime(model.updatedAt)}</span></div>
            <div className="db-model-metrics"><span><Table2 /> {model.tables.length} 张表</span><span><GitFork /> {model.relations.length} 条关系</span></div>
            <div className="db-model-footer"><span>打开 ER 工作区 <strong>→</strong></span><button className="btn btn-ghost btn-icon btn-danger" aria-label="删除" onClick={(event) => { event.stopPropagation(); void remove(model); }}><Trash2 /></button></div>
          </article>
        ))}</div>
      )}
      <Pagination offset={page.offset} limit={PAGE_SIZE} total={page.total} onChange={setOffset} />
      {creating ? <Modal title="新建数据库模型" onClose={() => setCreating(false)} footer={<><button className="btn" onClick={() => setCreating(false)}>取消</button><button className="btn btn-primary" disabled={!newName.trim()} onClick={() => void create()}>创建并打开</button></>}>
        <div className="form-grid"><Field label="模型名称" wide><input value={newName} onChange={(event) => setNewName(event.target.value)} /></Field><Field label="数据库方言" wide><select value={newDialect} onChange={(event) => setNewDialect(event.target.value as DatabaseModel["dialect"])}>{DATABASE_DIALECTS.map((value) => <option key={value} value={value}>{DIALECT_LABEL[value]}</option>)}</select></Field></div>
      </Modal> : null}
      {importing ? <Modal title="从真实数据库生成 ER 模型" onClose={() => setImporting(false)} footer={<><button className="btn" onClick={() => setImporting(false)}>取消</button>{importPreview ? <button className="btn btn-primary" disabled={importBusy || !importName.trim()} onClick={() => void applyImport()}>{importBusy ? "导入中…" : "确认导入并打开"}</button> : <button className="btn btn-primary" disabled={importBusy || !importName.trim()} onClick={() => void previewImport()}>{importBusy ? "读取中…" : "读取数据库结构"}</button>}</>}>
        <div className="db-engineering-modal">
          {error ? <div className="db-modal-error">{error}</div> : null}
          <Field label="模型名称" wide><input value={importName} onChange={(event) => { setImportName(event.target.value); setImportPreview(null); }} /></Field>
          <ConnectionFields value={importConnection} onChange={(value) => { setImportConnection(value); setImportPreview(null); }} />
          {importPreview ? <section className="db-engineering-preview"><header><div><span>反向工程预览</span><strong>{importPreview.snapshot.databaseName}</strong></div><div><b>{importPreview.snapshot.tables.length}</b> 张表 <b>{importPreview.snapshot.relations.length}</b> 条关系</div></header><ChangePreview changes={importPreview.changes} /></section> : null}
        </div>
      </Modal> : null}
    </div>
  );
}

type Gesture = { type: "none" } | { type: "pan"; x: number; y: number; panX: number; panY: number } | { type: "table"; tableId: string; x: number; y: number; tableX: number; tableY: number; moved: boolean };

function Editor({ projectId, modelId, surface }: { projectId?: string; modelId: string; surface: DatabaseSurface }): ReactElement {
  const [model, setModel] = useState<DatabaseModel | null>(null);
  const [draft, setDraft] = useState<DatabaseModel | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [focusRootTableId, setFocusRootTableId] = useState<string | null>(null);
  const [tab, setTab] = useState<"structure" | "relations" | "code">("structure");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 38, y: 38 });
  const [tableQuery, setTableQuery] = useState("");
  const [viewMode, setViewMode] = useState<"focus" | "overview">("focus");
  const [favoriteTableIds, setFavoriteTableIds] = useState<string[]>(() => readStoredTableIds(`database-favorites:${modelId}`));
  const [recentTableIds, setRecentTableIds] = useState<string[]>(() => readStoredTableIds(`database-recent:${modelId}`));
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const wheelPanFrameRef = useRef<number | null>(null);
  const wheelPanDeltaRef = useRef({ x: 0, y: 0 });
  zoomRef.current = zoom;
  panRef.current = pan;
  const [target, setTarget] = useState<DatabaseCodeTarget | "ddl">("java-jpa");
  const [generated, setGenerated] = useState<DatabaseCodeResult | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [engineeringMode, setEngineeringMode] = useState<"reverse" | "deploy" | null>(null);
  const [engineeringConnection, setEngineeringConnection] = useState<DatabaseConnectionInput>(() => connectionDraft("sqlite"));
  const [reversePreview, setReversePreview] = useState<DatabaseReversePreview | null>(null);
  const [deployPreview, setDeployPreview] = useState<DatabaseDeployPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [navigatorOpen, setNavigatorOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [documents, setDocuments] = useState<DesignDoc[]>([]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const navigatorRef = useRef<HTMLElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const navigatorHideTimer = useRef<number | null>(null);
  const inspectorHideTimer = useRef<number | null>(null);
  const gesture = useRef<Gesture>({ type: "none" });
  const tableDragFrameRef = useRef<number | null>(null);
  const pendingTableDragRef = useRef<{ tableId: string; x: number; y: number } | null>(null);
  const suppressTableClickRef = useRef<{ tableId: string; until: number } | null>(null);
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();

  const cancelNavigatorHide = useCallback(() => {
    if (navigatorHideTimer.current !== null) window.clearTimeout(navigatorHideTimer.current);
    navigatorHideTimer.current = null;
  }, []);
  const revealNavigator = useCallback(() => {
    cancelNavigatorHide();
    setNavigatorOpen(true);
  }, [cancelNavigatorHide]);
  const scheduleNavigatorHide = useCallback(() => {
    cancelNavigatorHide();
    navigatorHideTimer.current = window.setTimeout(() => {
      const navigator = navigatorRef.current;
      if (navigator?.matches(":hover") || navigator?.contains(document.activeElement)) return;
      setNavigatorOpen(false);
      navigatorHideTimer.current = null;
    }, 3000);
  }, [cancelNavigatorHide]);
  const cancelInspectorHide = useCallback(() => {
    if (inspectorHideTimer.current !== null) window.clearTimeout(inspectorHideTimer.current);
    inspectorHideTimer.current = null;
  }, []);
  const revealInspector = useCallback(() => {
    cancelInspectorHide();
    setInspectorOpen(true);
  }, [cancelInspectorHide]);
  const scheduleInspectorHide = useCallback(() => {
    cancelInspectorHide();
    inspectorHideTimer.current = window.setTimeout(() => {
      const inspector = inspectorRef.current;
      if (inspector?.matches(":hover") || inspector?.contains(document.activeElement)) return;
      setInspectorOpen(false);
      inspectorHideTimer.current = null;
    }, 3000);
  }, [cancelInspectorHide]);
  useEffect(() => {
    if (!navigatorOpen || !draft?.id) return;
    scheduleNavigatorHide();
    return cancelNavigatorHide;
  }, [cancelNavigatorHide, draft?.id, navigatorOpen, scheduleNavigatorHide]);
  useEffect(() => cancelNavigatorHide, [cancelNavigatorHide]);
  useEffect(() => cancelInspectorHide, [cancelInspectorHide]);

  const fitTableIdsInView = useCallback((value: DatabaseModel, tableIds: Set<string>) => {
    const viewport = viewportRef.current;
    const tables = value.tables.filter((table) => tableIds.has(table.id));
    if (!viewport || tables.length === 0) return;
    const rect = viewport.getBoundingClientRect();
    const minX = Math.min(...tables.map((table) => table.x));
    const minY = Math.min(...tables.map((table) => table.y));
    const maxX = Math.max(...tables.map((table) => table.x + TABLE_WIDTH));
    const maxY = Math.max(...tables.map((table) => table.y + tableHeight(table)));
    const contentWidth = Math.max(TABLE_WIDTH, maxX - minX);
    const contentHeight = Math.max(120, maxY - minY);
    const nextZoom = Math.max(.35, Math.min(1, (rect.width - 88) / contentWidth, (rect.height - 88) / contentHeight));
    setZoom(nextZoom);
    setPan({
      x: (rect.width - contentWidth * nextZoom) / 2 - minX * nextZoom,
      y: (rect.height - contentHeight * nextZoom) / 2 - minY * nextZoom,
    });
  }, []);

  const load = useCallback(() => {
    setError("");
    api.getDatabaseModel(modelId).then((value) => {
      if (projectId && value.projectId !== projectId) throw new Error("该数据库模型不属于当前项目");
      const query = new URLSearchParams(window.location.hash.includes("?") ? window.location.hash.slice(window.location.hash.indexOf("?") + 1) : "");
      const requestedTable = query.get("table");
      const targetTable = requestedTable ? value.tables.find((table) => table.name.toLocaleLowerCase() === requestedTable.toLocaleLowerCase()) : undefined;
      const entryTable = targetTable ?? rankDatabaseTables(value)[0];
      setModel(value); setDraft(value); setSelectedTableId(entryTable?.id ?? null); setFocusRootTableId(entryTable?.id ?? null); setDirty(false); setViewMode("focus"); revealInspector();
      if (entryTable) {
        setTab("structure");
        window.requestAnimationFrame(() => fitTableIdsInView(value, relatedDatabaseTableIds(value, entryTable.id)));
      }
    }).catch((cause: Error) => setError(cause.message));
  }, [fitTableIdsInView, modelId, projectId, revealInspector]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!model?.projectId) return;
    api.listReferencedDesignDocs(model.projectId, "databaseModel", model.id).then(setDocuments).catch(() => undefined);
  }, [model?.id, model?.projectId, model?.updatedAt]);

  useEffect(() => { window.localStorage.setItem(`database-favorites:${modelId}`, JSON.stringify(favoriteTableIds)); }, [favoriteTableIds, modelId]);
  useEffect(() => { window.localStorage.setItem(`database-recent:${modelId}`, JSON.stringify(recentTableIds)); }, [modelId, recentTableIds]);

  const change = useCallback((next: DatabaseModel) => { setDraft(next); setDirty(true); setGenerated(null); }, []);
  const updateTable = useCallback((tableId: string, updater: (table: DatabaseTable) => DatabaseTable) => {
    setDraft((current) => {
      if (!current) return current;
      setDirty(true); setGenerated(null);
      return { ...current, tables: current.tables.map((table) => table.id === tableId ? updater(table) : table) };
    });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const queuePan = (x: number, y: number) => {
      wheelPanDeltaRef.current.x += x;
      wheelPanDeltaRef.current.y += y;
      if (wheelPanFrameRef.current !== null) return;
      wheelPanFrameRef.current = window.requestAnimationFrame(() => {
        const delta = wheelPanDeltaRef.current;
        wheelPanDeltaRef.current = { x: 0, y: 0 };
        wheelPanFrameRef.current = null;
        const next = { x: panRef.current.x + delta.x, y: panRef.current.y + delta.y };
        panRef.current = next;
        setPan(next);
      });
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        // Ctrl/⌘+滚轮：以光标为中心缩放画布。non-passive 监听 + preventDefault 可拦截浏览器页面缩放，
        // 让滚轮只缩放画布本身；触控板两指捏合（浏览器发 ctrlKey wheel）也走这里。
        const rect = viewport.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        const factor = event.deltaY < 0 ? 1.1 : 0.9;
        const next = Math.max(0.35, Math.min(1.8, zoomRef.current * factor));
        const wx = (mx - panRef.current.x) / zoomRef.current;
        const wy = (my - panRef.current.y) / zoomRef.current;
        setZoom(next);
        setPan({ x: mx - wx * next, y: my - wy * next });
        return;
      }
      const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? Math.max(1, viewport.clientHeight) : 1;
      if (event.shiftKey) {
        // 普通鼠标通过 deltaY 提供位移，触控板可能直接提供 deltaX；取主方向避免重复累计。
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        queuePan(-delta * unit, 0);
        return;
      }
      // 将高频滚轮事件合并到下一动画帧，避免每个事件都重绘整张 ER 图。
      queuePan(-event.deltaX * unit, -event.deltaY * unit);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      if (wheelPanFrameRef.current !== null) window.cancelAnimationFrame(wheelPanFrameRef.current);
      wheelPanFrameRef.current = null;
      wheelPanDeltaRef.current = { x: 0, y: 0 };
    };
  // 数据模型加载前 Editor 只渲染 Spinner，此时 viewportRef 为空。
  // 以模型 ID 作为依赖，在真实画布挂载后重新绑定滚轮事件。
  }, [draft?.id]);

  useEffect(() => {
    const queueTableDrag = (tableId: string, x: number, y: number) => {
      pendingTableDragRef.current = { tableId, x, y };
      if (tableDragFrameRef.current !== null) return;
      tableDragFrameRef.current = window.requestAnimationFrame(() => {
        tableDragFrameRef.current = null;
        const pending = pendingTableDragRef.current;
        pendingTableDragRef.current = null;
        if (pending) updateTable(pending.tableId, (table) => ({ ...table, x: pending.x, y: pending.y }));
      });
    };
    const move = (event: PointerEvent) => {
      const active = gesture.current;
      if (active.type === "pan") setPan({ x: active.panX + event.clientX - active.x, y: active.panY + event.clientY - active.y });
      if (active.type === "table") {
        const deltaX = event.clientX - active.x;
        const deltaY = event.clientY - active.y;
        if (!active.moved && Math.hypot(deltaX, deltaY) >= 3) active.moved = true;
        if (active.moved) queueTableDrag(active.tableId, active.tableX + deltaX / zoom, active.tableY + deltaY / zoom);
      }
    };
    const up = () => {
      const active = gesture.current;
      if (active.type === "table" && active.moved) {
        suppressTableClickRef.current = { tableId: active.tableId, until: window.performance.now() + 250 };
      }
      gesture.current = { type: "none" };
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (tableDragFrameRef.current !== null) window.cancelAnimationFrame(tableDragFrameRef.current);
      tableDragFrameRef.current = null;
      pendingTableDragRef.current = null;
    };
  }, [updateTable, zoom]);

  const selected = draft?.tables.find((table) => table.id === selectedTableId) ?? null;
  const focusRootTable = draft?.tables.find((table) => table.id === focusRootTableId) ?? null;
  const relationCounts = useMemo(() => draft ? databaseRelationCounts(draft) : new Map<string, number>(), [draft]);
  const rankedTables = useMemo(() => draft ? rankDatabaseTables(draft) : [], [draft]);
  const keyTables = useMemo(() => rankedTables.slice(0, 4), [rankedTables]);
  const favoriteTables = useMemo(() => favoriteTableIds.map((id) => draft?.tables.find((table) => table.id === id)).filter((table): table is DatabaseTable => Boolean(table)), [draft, favoriteTableIds]);
  const recentTables = useMemo(() => recentTableIds.map((id) => draft?.tables.find((table) => table.id === id)).filter((table): table is DatabaseTable => Boolean(table)).slice(0, 4), [draft, recentTableIds]);
  const filteredTables = useMemo(() => draft ? draft.tables.filter((table) => matchesDatabaseTableQuery(table, tableQuery)).sort((left, right) => left.name.localeCompare(right.name)) : [], [draft, tableQuery]);
  const focusedTableIds = useMemo(() => draft && focusRootTableId ? relatedDatabaseTableIds(draft, focusRootTableId) : new Set<string>(), [draft, focusRootTableId]);
  const visibleTables = useMemo(() => !draft ? [] : viewMode === "overview" ? draft.tables : draft.tables.filter((table) => focusedTableIds.has(table.id)), [draft, focusedTableIds, viewMode]);
  const visibleRelations = useMemo(() => !draft ? [] : viewMode === "overview" ? draft.relations : draft.relations.filter((relation) => relation.sourceTableId === focusRootTableId || relation.targetTableId === focusRootTableId), [draft, focusRootTableId, viewMode]);

  const rememberTable = useCallback((tableId: string) => {
    setRecentTableIds((current) => [tableId, ...current.filter((id) => id !== tableId)].slice(0, 8));
  }, []);
  const focusTable = useCallback((tableId: string) => {
    if (!draft) return;
    setSelectedTableId(tableId);
    setFocusRootTableId(tableId);
    setViewMode("focus");
    setTab("structure");
    rememberTable(tableId);
    revealInspector();
    window.requestAnimationFrame(() => fitTableIdsInView(draft, relatedDatabaseTableIds(draft, tableId)));
  }, [draft, fitTableIdsInView, rememberTable, revealInspector]);
  const selectTable = useCallback((tableId: string) => {
    setSelectedTableId(tableId);
    setTab("structure");
    rememberTable(tableId);
    revealInspector();
  }, [rememberTable, revealInspector]);
  const switchViewMode = useCallback((mode: "focus" | "overview") => {
    if (!draft) return;
    const entryTable = selected ?? rankedTables[0] ?? null;
    setViewMode(mode);
    if (mode === "focus" && entryTable) {
      setSelectedTableId(entryTable.id);
      setFocusRootTableId(entryTable.id);
      rememberTable(entryTable.id);
      window.requestAnimationFrame(() => fitTableIdsInView(draft, relatedDatabaseTableIds(draft, entryTable.id)));
      return;
    }
    window.requestAnimationFrame(() => fitTableIdsInView(draft, new Set(draft.tables.map((table) => table.id))));
  }, [draft, fitTableIdsInView, rankedTables, rememberTable, selected]);
  const fitCurrentView = useCallback(() => {
    if (!draft) return;
    const ids = viewMode === "focus" && focusRootTableId ? relatedDatabaseTableIds(draft, focusRootTableId) : new Set(draft.tables.map((table) => table.id));
    fitTableIdsInView(draft, ids);
  }, [draft, fitTableIdsInView, focusRootTableId, viewMode]);
  useEffect(() => {
    if (!draft) return;
    const frame = window.requestAnimationFrame(fitCurrentView);
    return () => window.cancelAnimationFrame(frame);
  }, [draft?.id, fitCurrentView, navigatorOpen]);
  const toggleFavorite = useCallback((tableId: string) => {
    setFavoriteTableIds((current) => current.includes(tableId) ? current.filter((id) => id !== tableId) : [tableId, ...current]);
  }, []);

  useEffect(() => {
    if (!draft || !model) return;
    const refs = [
      { type: "project" as const, id: draft.projectId },
      { type: "databaseModel" as const, id: draft.id, label: draft.name },
      ...(selected ? [{ type: "databaseTable" as const, id: selected.id, parentId: draft.id, label: selected.name }] : []),
      ...documents.map((document) => ({ type: "designDocument" as const, id: document.id, label: document.title })),
    ];
    const visibleModel = selected ? {
      model: { id: draft.id, name: draft.name, dialect: draft.dialect, updatedAt: model.updatedAt },
      selectedTable: selected,
      relations: draft.relations.filter((relation) => relation.sourceTableId === selected.id || relation.targetTableId === selected.id),
    } : draft;
    const visible = { database: visibleModel, documents };
    setPageContextDetail({
      projectId: draft.projectId,
      pageType: "database",
      title: selected ? `数据库 · ${draft.name} · ${selected.name}` : `数据库 · ${draft.name}`,
      entityRefs: refs,
      selection: { entityRefs: selected ? [refs[2]] : [] },
      draft: dirty ? { dirty: true, baseRevision: model.updatedAt, summary: "当前 visibleContent 是尚未保存的数据库模型草稿；不包含任何数据库连接凭据。" } : null,
      visibleContent: agentVisibleContent(selected ? "databaseTable" : "databaseModel", selected?.name ?? draft.name, visible),
    });
  }, [dirty, documents, draft, model, selected, setPageContextDetail]);
  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);
  useEffect(() => {
    if (!model || lastEntityChange?.value.entityType !== "databaseModel" || lastEntityChange.value.entityId !== model.id) return;
    if (lastEntityChange.value.revision <= model.updatedAt) return;
    if (dirty) {
      setError("Agent 已更新当前数据库模型，但本地还有未保存修改；已保留本地草稿，请保存或刷新后同步。");
      return;
    }
    load();
  }, [dirty, lastEntityChange, load, model]);

  if (!draft || !model) return error ? <ErrorBanner message={error} /> : <Spinner />;
  const foreignFields = new Set(draft.relations.map((relation) => relation.sourceFieldId));

  const save = async (): Promise<DatabaseModel | null> => {
    setBusy(true); setError("");
    try {
      const updated = await api.updateDatabaseModel(draft.id, { name: draft.name, dialect: draft.dialect, tables: draft.tables, relations: draft.relations, expectedUpdatedAt: model.updatedAt });
      setModel(updated); setDraft(updated); setDirty(false); setHint("已保存"); setTimeout(() => setHint(""), 1800); return updated;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; } finally { setBusy(false); }
  };

  const addTable = () => {
    const table = createTable(draft.tables.length + 1);
    const next = { ...draft, tables: [...draft.tables, table] };
    change(next); setSelectedTableId(table.id); setFocusRootTableId(table.id); setViewMode("focus"); setTab("structure"); rememberTable(table.id); revealInspector();
    window.requestAnimationFrame(() => fitTableIdsInView(next, new Set([table.id])));
  };
  const removeTable = (tableId: string) => {
    const nextTables = draft.tables.filter((table) => table.id !== tableId);
    const next = { ...draft, tables: nextTables, relations: draft.relations.filter((relation) => relation.sourceTableId !== tableId && relation.targetTableId !== tableId) };
    const nextSelected = rankDatabaseTables(next)[0] ?? null;
    change(next);
    setSelectedTableId(nextSelected?.id ?? null);
    setFocusRootTableId(nextSelected?.id ?? null);
    setFavoriteTableIds((current) => current.filter((id) => id !== tableId));
    setRecentTableIds((current) => current.filter((id) => id !== tableId));
    if (nextSelected) window.requestAnimationFrame(() => fitTableIdsInView(next, relatedDatabaseTableIds(next, nextSelected.id)));
  };
  const addField = () => selected && updateTable(selected.id, (table) => ({ ...table, fields: [...table.fields, createField(`field_${table.fields.length + 1}`)] }));
  const updateField = (fieldId: string, patch: Partial<DatabaseField>) => selected && updateTable(selected.id, (table) => ({ ...table, fields: table.fields.map((field) => field.id === fieldId ? { ...field, ...patch } : field) }));
  const removeField = (fieldId: string) => selected && change({ ...draft, tables: draft.tables.map((table) => table.id === selected.id ? { ...table, fields: table.fields.filter((field) => field.id !== fieldId), indexes: table.indexes.map((index) => ({ ...index, fieldIds: index.fieldIds.filter((id) => id !== fieldId) })).filter((index) => index.fieldIds.length > 0) } : table), relations: draft.relations.filter((relation) => relation.sourceFieldId !== fieldId && relation.targetFieldId !== fieldId) });
  const addIndex = () => selected?.fields[0] && updateTable(selected.id, (table) => ({ ...table, indexes: [...table.indexes, { id: uid(), name: `idx_${table.name}_${table.indexes.length + 1}`, fieldIds: [table.fields[0].id], unique: false }] }));
  const updateIndex = (indexId: string, patch: Partial<DatabaseIndex>) => selected && updateTable(selected.id, (table) => ({ ...table, indexes: table.indexes.map((index) => index.id === indexId ? { ...index, ...patch } : index) }));

  const addRelation = () => {
    if (draft.tables.length < 2 || !draft.tables[0].fields[0] || !draft.tables[1].fields[0]) { setError("至少需要两张包含字段的表才能建立关系"); return; }
    const source = selected?.fields[0] ? selected : draft.tables[0];
    const targetTable = draft.tables.find((table) => table.id !== source.id && table.fields[0])!;
    const relation: DatabaseRelation = { id: uid(), name: `fk_${source.name}_${targetTable.name}`, type: "one-to-many", sourceTableId: source.id, sourceFieldId: source.fields[0].id, targetTableId: targetTable.id, targetFieldId: targetTable.fields[0].id, onDelete: "NO ACTION" };
    change({ ...draft, relations: [...draft.relations, relation] }); setTab("relations");
  };
  const updateRelation = (relationId: string, patch: Partial<DatabaseRelation>) => change({ ...draft, relations: draft.relations.map((relation) => relation.id === relationId ? { ...relation, ...patch } : relation) });

  const autoLayout = async () => {
    const saved = dirty ? await save() : model;
    if (!saved) return;
    setBusy(true);
    try { const updated = await api.autoLayoutDatabaseModel(saved.id, saved.updatedAt); setModel(updated); setDraft(updated); setDirty(false); setHint("布局已整理"); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const validate = async () => {
    const saved = dirty ? await save() : model;
    if (!saved) return;
    try { const result = await api.validateDatabaseModel(saved.id); setHint(result.ok ? "模型校验通过" : `${result.issues.filter((issue) => issue.severity === "error").length} 个错误`); if (!result.ok) setError(result.issues.map((issue) => issue.message).join("；")); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const generate = async () => {
    const saved = dirty ? await save() : model;
    if (!saved) return;
    try { const result = await api.generateDatabaseCode(saved.id, target); setGenerated(result); setFileIndex(0); if (!result.files.length) setError(result.issues.map((issue) => issue.message).join("；") || "没有可生成的文件"); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const copy = async (text: string, message: string) => { await navigator.clipboard.writeText(text); setHint(message); setTimeout(() => setHint(""), 1600); };
  const openEngineering = (mode: "reverse" | "deploy") => {
    if (!draft) return;
    setEngineeringMode(mode); setEngineeringConnection(connectionDraft(draft.dialect)); setReversePreview(null); setDeployPreview(null); setConfirmation(""); setError("");
  };
  const previewEngineering = async () => {
    if (!model || !engineeringMode) return;
    const saved = dirty ? await save() : model;
    if (!saved) return;
    setBusy(true); setError("");
    try {
      if (engineeringMode === "reverse") setReversePreview(await api.previewDatabaseReverse(saved.id, engineeringConnection));
      else setDeployPreview(await api.previewDatabaseDeploy(saved.id, engineeringConnection));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const applyEngineering = async () => {
    if (!model || !engineeringMode) return;
    setBusy(true); setError("");
    try {
      if (engineeringMode === "reverse") {
        const updated = await api.applyDatabaseReverse(model.id, engineeringConnection, confirmation, model.updatedAt);
        setModel(updated); setDraft(updated); setSelectedTableId(updated.tables[0]?.id ?? null); setFocusRootTableId(updated.tables[0]?.id ?? null); setDirty(false); setHint("数据库结构已导入");
      } else {
        const result = await api.applyDatabaseDeploy(model.id, engineeringConnection, confirmation);
        setHint(`已执行 ${result.executedStatements} 条建表语句`);
      }
      setEngineeringMode(null); setTimeout(() => setHint(""), 2200);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".er-table, button, input, textarea, select")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { type: "pan", x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };
  const renderNavigatorRows = (tables: DatabaseTable[], compact = false) => tables.map((table) => {
    const relationCount = relationCounts.get(table.id) ?? 0;
    const favorite = favoriteTableIds.includes(table.id);
    return <div className={`db-table-nav-row ${selectedTableId === table.id ? "selected" : ""} ${compact ? "compact" : ""}`} key={table.id}>
      <button className="db-table-nav-main" onClick={() => focusTable(table.id)} title={`定位到 ${table.name}`}>
        <span className="db-table-nav-glyph"><Table2 /></span>
        <span className="db-table-nav-copy"><strong>{table.name}</strong><small>{table.displayName || table.comment || `${table.fields.length} 个字段`}</small></span>
        <span className="db-table-nav-metric" title={`${relationCount} 条直接关系`}><GitFork />{relationCount}</span>
      </button>
      <button className={`db-table-favorite ${favorite ? "active" : ""}`} aria-label={`${favorite ? "取消收藏" : "收藏"} ${table.name}`} onClick={() => toggleFavorite(table.id)}><Star /></button>
    </div>;
  });

  return (
    <div className="db-editor-page">
      <div className="db-editor-head">
        <button className="btn btn-ghost" onClick={() => navigate(surface === "canvas" ? "#/canvas?view=database" : `#/projects/${projectId}?tab=database`)}><ChevronLeft /> {surface === "canvas" ? "返回设计工作台" : "返回项目数据库设计"}</button>
        <div className="db-title-block"><input className="db-title-input" value={draft.name} onChange={(event) => change({ ...draft, name: event.target.value })} /><span>{DIALECT_LABEL[draft.dialect]} · {draft.tables.length} 张表 · {draft.relations.length} 条关系</span></div>
        <div className="spacer" />{hint ? <span className="db-save-hint"><Check /> {hint}</span> : null}
        <button className="btn" onClick={() => setDocumentsOpen(true)}><BookOpen /> 文档</button>
        <button className="btn" onClick={() => void validate()}><Check /> 校验</button>
        <button className="btn" onClick={() => void autoLayout()} disabled={busy}><WandSparkles /> 自动布局</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || busy}><Save /> {dirty ? "保存模型" : "已保存"}</button>
      </div>
      {error ? <div className="db-inline-error"><span>{error}</span><button onClick={() => setError("")}><X /></button></div> : null}
      <div className="db-editor-shell">
        {navigatorOpen ? <aside
          ref={navigatorRef}
          className="db-table-navigator"
          onPointerEnter={cancelNavigatorHide}
          onPointerLeave={scheduleNavigatorHide}
          onFocusCapture={cancelNavigatorHide}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleNavigatorHide();
          }}
        >
          <header className="db-table-navigator-head"><div><span>TABLE INDEX</span><strong>表导航</strong></div><b>{draft.tables.length}</b></header>
          <label className="db-table-search"><Search /><input aria-label="搜索数据表或字段" value={tableQuery} onChange={(event) => setTableQuery(event.target.value)} placeholder="搜索表名、说明或字段…" />{tableQuery ? <button aria-label="清除搜索" onClick={() => setTableQuery("")}><X /></button> : null}</label>
          <div className="db-view-switch db-table-view-switch" role="group" aria-label="ER 图查看方式"><button className={viewMode === "focus" ? "active" : ""} disabled={!selected} onClick={() => switchViewMode("focus")}><Focus />聚焦关系</button><button className={viewMode === "overview" ? "active" : ""} onClick={() => switchViewMode("overview")}><LayoutGrid />全局 ER</button></div>
          <div className="db-table-navigator-scroll">
            {!tableQuery && favoriteTables.length ? <section className="db-table-nav-section"><div className="db-table-nav-heading"><span>收藏</span><b>{favoriteTables.length}</b></div>{renderNavigatorRows(favoriteTables, true)}</section> : null}
            {!tableQuery && keyTables.length ? <section className="db-table-nav-section db-table-nav-key"><div className="db-table-nav-heading"><span>建议从这里开始</span><b>按关联度</b></div>{renderNavigatorRows(keyTables, true)}</section> : null}
            {!tableQuery && recentTables.length ? <section className="db-table-nav-section"><div className="db-table-nav-heading"><span>最近查看</span><b>{recentTables.length}</b></div>{renderNavigatorRows(recentTables, true)}</section> : null}
            <section className="db-table-nav-section db-table-nav-all"><div className="db-table-nav-heading"><span>{tableQuery ? "搜索结果" : "全部表"}</span><b>{filteredTables.length}</b></div>{filteredTables.length ? renderNavigatorRows(filteredTables) : <div className="db-table-nav-empty"><Search /><span>没有匹配的表或字段</span></div>}</section>
          </div>
        </aside> : <button className="db-table-navigator-reveal" aria-label="展开表导航" onClick={revealNavigator}><Table2 /><span>表导航</span></button>}
        <section className="db-canvas-panel">
          <div className="db-canvas-toolbar"><button className="btn btn-sm" onClick={addTable}><Plus /> 添加表</button><button className="btn btn-sm" onClick={addRelation}><Link2 /> 添加关系</button><span className="db-toolbar-separator" /><button className="btn btn-sm" onClick={() => openEngineering("reverse")}><RefreshCw /> 同步真库</button><button className="btn btn-sm" onClick={() => openEngineering("deploy")}><Rocket /> 部署真库</button><div className="spacer" /><button className="btn btn-ghost btn-sm" onClick={() => setZoom((value) => Math.max(.35, value - .1))}>−</button><span className="mono">{Math.round(zoom * 100)}%</span><button className="btn btn-ghost btn-sm" onClick={() => setZoom((value) => Math.min(1.8, value + .1))}>+</button><button className="btn btn-ghost btn-sm" onClick={fitCurrentView}><LayoutGrid /> 适配</button></div>
          <div ref={viewportRef} className="db-canvas-viewport" onPointerDown={startPan} onPointerCancel={() => { gesture.current = { type: "none" }; }}>
            <div className="db-canvas-context"><strong>{viewMode === "focus" ? "聚焦关系" : "全局 ER"}</strong><span>{visibleTables.length} / {draft.tables.length} 张表{viewMode === "focus" && focusRootTable ? ` · ${focusRootTable.name}` : ""}</span></div>
            <div className="db-canvas-world" style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}>
              <svg className="db-relation-layer" width="2400" height="1700">
                <defs><marker id="db-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#5b89a8" /></marker></defs>
                {visibleRelations.map((relation) => {
                  const source = draft.tables.find((table) => table.id === relation.sourceTableId), targetTable = draft.tables.find((table) => table.id === relation.targetTableId);
                  if (!source || !targetTable) return null;
                  const sx = source.x + TABLE_WIDTH, sy = source.y + tableHeight(source) / 2, tx = targetTable.x, ty = targetTable.y + tableHeight(targetTable) / 2;
                  const reverse = sx > tx; const x1 = reverse ? source.x : sx, x2 = reverse ? targetTable.x + TABLE_WIDTH : tx; const bend = Math.max(70, Math.abs(x2 - x1) * .45);
                  const path = `M ${x1} ${sy} C ${x1 + (reverse ? -bend : bend)} ${sy}, ${x2 + (reverse ? bend : -bend)} ${ty}, ${x2} ${ty}`;
                  return <g key={relation.id} className="db-relation"><path d={path} markerEnd="url(#db-arrow)" /><text x={(x1 + x2) / 2} y={(sy + ty) / 2 - 7}>{relation.name || relation.type}</text><text x={x1 + (reverse ? -15 : 12)} y={sy - 8}>{relation.type === "one-to-one" ? "1" : "N"}</text><text x={x2 + (reverse ? 12 : -15)} y={ty - 8}>1</text></g>;
                })}
              </svg>
              {visibleTables.map((table) => <article key={table.id} className={`er-table ${selectedTableId === table.id ? "selected" : ""}`} style={{ left: table.x, top: table.y, width: TABLE_WIDTH }} onPointerDown={(event) => event.stopPropagation()} onClick={() => {
                const suppressed = suppressTableClickRef.current;
                if (suppressed?.tableId === table.id && window.performance.now() <= suppressed.until) {
                  suppressTableClickRef.current = null;
                  return;
                }
                suppressTableClickRef.current = null;
                selectTable(table.id);
              }} onDoubleClick={() => focusTable(table.id)}>
                <header onPointerDown={(event) => { event.preventDefault(); gesture.current = { type: "table", tableId: table.id, x: event.clientX, y: event.clientY, tableX: table.x, tableY: table.y, moved: false }; }}><span className="er-table-glyph"><Table2 /></span><div><strong>{table.name}</strong><small>{table.displayName || table.comment || "数据表"}</small></div><span>{table.fields.length}</span></header>
                <div className="er-fields">{table.fields.length ? table.fields.map((field) => <div className={`er-field ${field.comment.trim() ? "has-comment" : ""}`} key={field.id} title={field.comment || undefined}><span className={`er-key ${field.primaryKey ? "pk" : foreignFields.has(field.id) ? "fk" : ""}`}>{field.primaryKey ? "PK" : foreignFields.has(field.id) ? "FK" : "·"}</span><strong>{field.name}</strong><code>{field.type}{field.type === "string" && field.length ? `(${field.length})` : ""}</code>{!field.nullable ? <i>NN</i> : null}{field.unique && !field.primaryKey ? <i>UQ</i> : null}{field.comment.trim() ? <small className="er-field-comment">{field.comment}</small> : null}</div>) : <div className="er-empty">暂无字段</div>}</div>
              </article>)}
              {draft.tables.length === 0 ? <button className="db-empty-canvas" onClick={addTable}><Plus /> 添加第一张表</button> : null}
            </div>
          </div>
        </section>
        {inspectorOpen ? <aside
          ref={inspectorRef}
          className="db-inspector"
          onPointerEnter={cancelInspectorHide}
          onPointerLeave={scheduleInspectorHide}
          onFocusCapture={cancelInspectorHide}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleInspectorHide();
          }}
        >
          <div className="db-inspector-tabs"><button className={tab === "structure" ? "active" : ""} onClick={() => setTab("structure")}><Table2 />结构</button><button className={tab === "relations" ? "active" : ""} onClick={() => setTab("relations")}><GitFork />关系</button><button className={tab === "code" ? "active" : ""} onClick={() => setTab("code")}><Code2 />生成</button></div>
          {tab === "structure" ? <div className="db-inspector-scroll">
            <div className="db-model-settings"><Field label="数据库方言"><select value={draft.dialect} onChange={(event) => change({ ...draft, dialect: event.target.value as DatabaseModel["dialect"] })}>{DATABASE_DIALECTS.map((value) => <option key={value} value={value}>{DIALECT_LABEL[value]}</option>)}</select></Field></div>
            {!selected ? <EmptyState text="选择一张表编辑结构" /> : <>
              <div className="db-inspector-section-title"><div><span>TABLE</span><strong>表定义</strong></div><button className="btn btn-ghost btn-icon btn-danger" onClick={() => removeTable(selected.id)}><Trash2 /></button></div>
              <div className="db-table-meta"><Field label="物理表名"><input value={selected.name} onChange={(event) => updateTable(selected.id, (table) => ({ ...table, name: event.target.value }))} /></Field><Field label="显示名称"><input value={selected.displayName} onChange={(event) => updateTable(selected.id, (table) => ({ ...table, displayName: event.target.value }))} /></Field><Field label="说明" wide><textarea value={selected.comment} onChange={(event) => updateTable(selected.id, (table) => ({ ...table, comment: event.target.value }))} /></Field></div>
              <div className="db-subhead"><strong>字段</strong><button className="btn btn-sm" onClick={addField}><Plus /> 添加字段</button></div>
              <div className="db-field-editor">{selected.fields.map((field) => <div className="db-field-card" key={field.id}><div className="db-field-main"><input aria-label={`${field.name} 字段名`} value={field.name} onChange={(event) => updateField(field.id, { name: event.target.value })} /><select aria-label={`${field.name} 字段类型`} value={field.type} onChange={(event) => updateField(field.id, { type: event.target.value as DatabaseField["type"] })}>{DATABASE_DATA_TYPES.map((value) => <option key={value}>{value}</option>)}</select><button className="btn btn-ghost btn-icon" aria-label={`删除字段 ${field.name}`} onClick={() => removeField(field.id)}><X /></button></div><input className="db-field-comment" aria-label={`${field.name} 字段备注`} value={field.comment} maxLength={1000} placeholder="字段备注 / 业务含义" onChange={(event) => updateField(field.id, { comment: event.target.value })} /><div className="db-field-flags"><label><input type="checkbox" checked={field.primaryKey} onChange={(event) => updateField(field.id, { primaryKey: event.target.checked, nullable: event.target.checked ? false : field.nullable })} />PK</label><label><input type="checkbox" checked={!field.nullable} onChange={(event) => updateField(field.id, { nullable: !event.target.checked })} />非空</label><label><input type="checkbox" checked={field.unique} onChange={(event) => updateField(field.id, { unique: event.target.checked })} />唯一</label><label><input type="checkbox" checked={field.autoIncrement} onChange={(event) => updateField(field.id, { autoIncrement: event.target.checked })} />自增</label></div></div>)}</div>
              <div className="db-subhead"><strong>索引</strong><button className="btn btn-sm" onClick={addIndex} disabled={!selected.fields.length}><Plus /> 添加索引</button></div>
              <div className="db-index-list">{selected.indexes.map((index) => <div className="db-index-row" key={index.id}><input value={index.name} onChange={(event) => updateIndex(index.id, { name: event.target.value })} /><select multiple value={index.fieldIds} onChange={(event) => updateIndex(index.id, { fieldIds: Array.from(event.target.selectedOptions).map((option) => option.value) })}>{selected.fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select><label><input type="checkbox" checked={index.unique} onChange={(event) => updateIndex(index.id, { unique: event.target.checked })} />唯一</label><button className="btn btn-ghost btn-icon" onClick={() => updateTable(selected.id, (table) => ({ ...table, indexes: table.indexes.filter((item) => item.id !== index.id) }))}><X /></button></div>)}</div>
            </>}
          </div> : null}
          {tab === "relations" ? <div className="db-inspector-scroll"><div className="db-inspector-section-title"><div><span>RELATIONS</span><strong>表关系</strong></div><button className="btn btn-sm" onClick={addRelation}><Plus /> 新建</button></div>{draft.relations.length === 0 ? <EmptyState text="尚未建立表关系" /> : <div className="db-relation-editor">{draft.relations.map((relation) => {
            const source = draft.tables.find((table) => table.id === relation.sourceTableId), targetTable = draft.tables.find((table) => table.id === relation.targetTableId);
            return <div className="db-relation-card" key={relation.id}><div className="db-relation-card-head"><input value={relation.name} onChange={(event) => updateRelation(relation.id, { name: event.target.value })} /><button className="btn btn-ghost btn-icon" onClick={() => change({ ...draft, relations: draft.relations.filter((item) => item.id !== relation.id) })}><Trash2 /></button></div><label>从表<select value={relation.sourceTableId} onChange={(event) => { const table = draft.tables.find((item) => item.id === event.target.value); updateRelation(relation.id, { sourceTableId: event.target.value, sourceFieldId: table?.fields[0]?.id ?? "" }); }}>{draft.tables.map((table) => <option key={table.id} value={table.id}>{table.name}</option>)}</select></label><label>外键字段<select value={relation.sourceFieldId} onChange={(event) => updateRelation(relation.id, { sourceFieldId: event.target.value })}>{source?.fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select></label><label>目标表<select value={relation.targetTableId} onChange={(event) => { const table = draft.tables.find((item) => item.id === event.target.value); updateRelation(relation.id, { targetTableId: event.target.value, targetFieldId: table?.fields[0]?.id ?? "" }); }}>{draft.tables.map((table) => <option key={table.id} value={table.id}>{table.name}</option>)}</select></label><label>目标字段<select value={relation.targetFieldId} onChange={(event) => updateRelation(relation.id, { targetFieldId: event.target.value })}>{targetTable?.fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select></label><div className="db-relation-pair"><select value={relation.type} onChange={(event) => updateRelation(relation.id, { type: event.target.value as DatabaseRelation["type"] })}><option value="one-to-one">1 : 1</option><option value="one-to-many">N : 1</option><option value="many-to-many">N : N</option></select><select value={relation.onDelete} onChange={(event) => updateRelation(relation.id, { onDelete: event.target.value as DatabaseRelation["onDelete"] })}><option>NO ACTION</option><option>CASCADE</option><option>SET NULL</option><option>RESTRICT</option></select></div></div>;
          })}</div>}</div> : null}
          {tab === "code" ? <div className="db-code-panel">
            <div className="db-code-actions"><select value={target} onChange={(event) => { setTarget(event.target.value as DatabaseCodeTarget | "ddl"); setGenerated(null); }}>{["ddl", ...DATABASE_CODE_TARGETS].map((value) => <option key={value} value={value}>{TARGET_LABEL[value as DatabaseCodeTarget | "ddl"]}</option>)}</select><button className="btn btn-primary" onClick={() => void generate()}><Braces /> 一键生成</button></div>
            {!generated ? <div className="db-code-empty"><Code2 /><strong>从当前模型生成代码</strong><span>生成后可以复制单个或全部文件，也可以直接下载源码包。</span></div> : generated.files.length ? <>
              <div className="db-code-files">{generated.files.map((file, index) => <button key={file.name} className={fileIndex === index ? "active" : ""} onClick={() => setFileIndex(index)}>{file.name}</button>)}</div>
              <div className="db-code-copy"><span>{generated.files[fileIndex]?.language}</span><button className="btn btn-sm" onClick={() => void copy(generated.files[fileIndex]?.code ?? "", "当前文件已复制")}><Clipboard />复制当前</button><button className="btn btn-sm" onClick={() => void copy(generated.files.map((file) => `// ${file.name}\n${file.code}`).join("\n\n"), "全部代码已复制")}><Clipboard />复制全部</button><button className="btn btn-sm" onClick={() => downloadText(generated.files[fileIndex]?.name ?? "database-code.txt", generated.files[fileIndex]?.code ?? "")}><Download />下载当前</button><button className="btn btn-sm" onClick={() => void downloadBundle(generated)}><Download />下载全部</button></div>
              <pre><code>{generated.files[fileIndex]?.code}</code></pre>
            </> : <EmptyState text="模型存在错误，无法生成代码。" />}
          </div> : null}
        </aside> : <button className="db-inspector-reveal" type="button" title="展开数据库检查器" aria-label="展开数据库检查器" onClick={revealInspector}><Table2 /><span>检查器</span></button>}
      </div>
      {documentsOpen ? <Modal title={`数据库模型文档 · ${draft.name}`} onClose={() => setDocumentsOpen(false)} width={820} footer={<button className="btn" onClick={() => setDocumentsOpen(false)}>关闭</button>}>
        <DocumentReferencePanel
          projectId={draft.projectId}
          targetType="databaseModel"
          targetId={draft.id}
          relationType="defines"
          title="数据库模型设计依据"
          description="数据库模型引用项目文档的固定版本；删除模型只解除引用，不删除系统文档。"
          onLoaded={(nextDocuments) => setDocuments(nextDocuments)}
        />
      </Modal> : null}
      {engineeringMode ? <Modal title={engineeringMode === "reverse" ? "从真实数据库同步模型" : "将模型部署到真实数据库"} onClose={() => setEngineeringMode(null)} footer={<>
        <button className="btn" onClick={() => setEngineeringMode(null)}>取消</button>
        {engineeringMode === "reverse" && reversePreview ? <button className="btn btn-primary" disabled={busy || confirmation !== model.name} onClick={() => void applyEngineering()}>{busy ? "同步中…" : "覆盖当前模型"}</button> : null}
        {engineeringMode === "deploy" && deployPreview ? <button className="btn btn-primary" disabled={busy || !deployPreview.canApply || deployPreview.statements.length === 0 || confirmation !== model.name} onClick={() => void applyEngineering()}>{busy ? "执行中…" : `执行 ${deployPreview.statements.length} 条语句`}</button> : null}
        {!reversePreview && !deployPreview ? <button className="btn btn-primary" disabled={busy} onClick={() => void previewEngineering()}>{busy ? "连接中…" : "连接并预览差异"}</button> : null}
      </>}>
        <div className="db-engineering-modal">
          {error ? <div className="db-modal-error">{error}</div> : null}
          <ConnectionFields dialectLocked={engineeringMode === "deploy"} value={engineeringConnection} onChange={(value) => { setEngineeringConnection(value); setReversePreview(null); setDeployPreview(null); setConfirmation(""); }} />
          {engineeringMode === "reverse" && reversePreview ? <section className="db-engineering-preview"><header><div><span>数据库 → 当前模型</span><strong>{reversePreview.snapshot.databaseName}</strong></div><div><b>{reversePreview.snapshot.tables.length}</b> 张表 <b>{reversePreview.snapshot.relations.length}</b> 条关系</div></header><ChangePreview changes={reversePreview.changes} /></section> : null}
          {engineeringMode === "deploy" && deployPreview ? <section className="db-engineering-preview"><header><div><span>当前模型 → 数据库</span><strong>{deployPreview.target}</strong></div><div><b>{deployPreview.createTableCount}</b> 张新表 <b>{deployPreview.statements.length}</b> 条语句</div></header>{deployPreview.blockingReasons.length ? <div className="db-deploy-blocked"><strong>禁止执行：目标库存在同名表结构冲突</strong>{deployPreview.blockingReasons.map((reason) => <span key={reason}>{reason}</span>)}</div> : null}<ChangePreview changes={deployPreview.changes} />{deployPreview.ddl.trim() ? <details className="db-ddl-preview"><summary>查看将执行的 DDL</summary><pre>{deployPreview.ddl}</pre></details> : null}</section> : null}
          {(reversePreview || deployPreview) ? <div className="db-confirm-operation"><Field label={`输入模型名称“${model.name}”确认`} wide><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field><p>{engineeringMode === "reverse" ? "确认后，当前 ER 模型的表、字段、索引和关系将以数据库为准。" : "这里只执行新建缺失表；已有同名表结构不一致时不会自动修改。"}</p></div> : null}
        </div>
      </Modal> : null}
    </div>
  );
}

export function DatabaseWorkbenchView({ projectId, modelId, embedded, surface = "project" }: { projectId?: string; modelId?: string; embedded?: boolean; surface?: DatabaseSurface }): ReactElement {
  if (modelId) return <Editor key={modelId} projectId={projectId} modelId={modelId} surface={surface} />;
  if (!projectId) return <ErrorBanner message="请先选择一个项目，再进入数据库设计。" />;
  return <ListView projectId={projectId} embedded={embedded} surface={surface} />;
}
