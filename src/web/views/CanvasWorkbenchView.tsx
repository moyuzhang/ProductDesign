import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { BookOpen, Check, ChevronDown, ChevronLeft, CornerUpLeft, Database, LayoutGrid, Layers, LockKeyhole, PenLine, Pencil, Plus, Search, Shapes, Trash2 } from "lucide-react";
import { DIAGRAM_TYPES, type DesignDoc, type Diagram, type DiagramEdge, type DiagramFlowNodeType, type DiagramGroup, type DiagramLayerState, type DiagramNode, type DiagramNodeKind, type DiagramType, type DiagramUseCaseNodeType, type NodeShape, type PlanItem, type Project } from "../../shared/types";
import { api } from "../api";
import { navigate } from "../App";
import { Badge, EmptyState, ErrorBanner, Field, Modal, Pagination, Spinner, StatCard, formatDateTime } from "../ui";
import { DiagramCanvas, type DiagramCanvasApi, type DiagramPlanSummary } from "./DiagramCanvas";
import { DatabaseWorkbenchView } from "./DatabaseWorkbenchView";
import { ShapePalette } from "./ShapePalette";
import { useWorkspace } from "./workspace";
import { agentVisibleContent, useAgentUiBridge } from "./agentUiBridge";
import { DocumentReferencePanel } from "./DocumentReferencePanel";
import { PrototypeDesigner } from "./PrototypeDesigner";
import { WhiteboardFreeformCanvas } from "./WhiteboardFreeformCanvas";
import { DiagramLayerPanel } from "./DiagramLayerPanel";
import { DiagramComponentLibrary } from "./DiagramComponentLibrary";
import { DiagramTemplateLibrary } from "./DiagramTemplateLibrary";

type CanvasTemplateId = "blank" | "arch" | "flow" | "module" | "usecase";

interface CanvasTemplate {
  id: CanvasTemplateId;
  type: DiagramType;
  name: string;
  desc: string;
  build: () => { nodes: DiagramNode[]; edges: DiagramEdge[] };
}

const uid = (): string => Math.random().toString(36).slice(2, 10);

const DIAGRAM_TYPE_LABELS: Record<DiagramType, string> = {
  main: "系统主画布",
  free: "自由画布",
  functional: "功能架构图",
  flow: "业务流程图",
  deployment: "部署架构图",
  usecase: "用例图",
};

const DIAGRAM_TYPE_DESCRIPTIONS: Record<DiagramType, string> = {
  main: "整个系统的唯一总览与钻取入口",
  free: "自由组织节点与关系",
  functional: "梳理系统、模块与功能层级",
  flow: "表达步骤、判断与流程分支",
  deployment: "描述设备、服务与部署关系",
  usecase: "描述参与者、系统边界、用例及关系",
};

const CANVAS_TEMPLATES: CanvasTemplate[] = [
  { id: "blank", type: "free", name: "自由画布", desc: "不限制元素与连线规则", build: () => ({ nodes: [], edges: [] }) },
  {
    id: "arch",
    type: "deployment",
    name: "部署架构图",
    desc: "节点、服务、组件与存储关系",
    build: () => {
      const nodes: DiagramNode[] = [
        { id: uid(), kind: "system", label: "客户端", x: 80, y: 80, shape: "ellipse" },
        { id: uid(), kind: "module", label: "接入网关", x: 320, y: 80, shape: "rect" },
        { id: uid(), kind: "module", label: "应用服务", x: 560, y: 80, shape: "rect" },
        { id: uid(), kind: "data", label: "数据存储", x: 800, y: 80, shape: "cylinder" },
      ];
      const edges: DiagramEdge[] = [
        { id: uid(), from: nodes[0].id, to: nodes[1].id, style: "ortho" },
        { id: uid(), from: nodes[1].id, to: nodes[2].id, style: "ortho" },
        { id: uid(), from: nodes[2].id, to: nodes[3].id, style: "ortho" },
      ];
      return { nodes, edges };
    },
  },
  {
    id: "flow",
    type: "flow",
    name: "业务流程图",
    desc: "开始 → 处理 → 判断 → 结束",
    build: () => {
      const nodes: DiagramNode[] = [
        { id: uid(), kind: "system", label: "开始", x: 80, y: 80, shape: "ellipse", flowType: "start" },
        { id: uid(), kind: "feature", label: "提交需求", x: 320, y: 80, shape: "rect", flowType: "process" },
        { id: uid(), kind: "requirement", label: "审批通过?", x: 560, y: 80, shape: "diamond", flowType: "decision" },
        { id: uid(), kind: "system", label: "结束", x: 800, y: 80, shape: "ellipse", flowType: "end" },
      ];
      const edges: DiagramEdge[] = [
        { id: uid(), from: nodes[0].id, to: nodes[1].id, label: "发起", style: "ortho" },
        { id: uid(), from: nodes[1].id, to: nodes[2].id, label: "送审", style: "ortho" },
        { id: uid(), from: nodes[2].id, to: nodes[3].id, label: "是", style: "ortho" },
        { id: uid(), from: nodes[2].id, to: nodes[1].id, label: "否", style: "curve" },
      ];
      return { nodes, edges };
    },
  },
  {
    id: "usecase",
    type: "usecase",
    name: "用例图",
    desc: "参与者、系统边界与核心用例",
    build: () => {
      const nodes: DiagramNode[] = [
        { id: uid(), kind: "system", label: "业务系统", x: 470, y: 270, w: 520, h: 390, shape: "boundary", useCaseType: "boundary" },
        { id: uid(), kind: "interface", label: "用户", x: 100, y: 230, w: 90, h: 120, shape: "actor", useCaseType: "actor" },
        { id: uid(), kind: "requirement", label: "登录系统", x: 380, y: 180, w: 180, h: 72, shape: "ellipse", useCaseType: "usecase" },
        { id: uid(), kind: "requirement", label: "查看业务数据", x: 560, y: 310, w: 180, h: 72, shape: "ellipse", useCaseType: "usecase" },
      ];
      const edges: DiagramEdge[] = [
        { id: uid(), from: nodes[1].id, to: nodes[2].id, style: "straight", relationType: "association" },
        { id: uid(), from: nodes[1].id, to: nodes[3].id, style: "straight", relationType: "association" },
      ];
      return { nodes, edges };
    },
  },
  {
    id: "module",
    type: "functional",
    name: "功能架构图",
    desc: "系统 → 模块 → 功能与需求",
    build: () => {
      const nodes: DiagramNode[] = [
        { id: uid(), kind: "module", label: "系统", x: 360, y: 80, shape: "rect" },
        { id: uid(), kind: "feature", label: "模块 A", x: 80, y: 260, shape: "rounded" },
        { id: uid(), kind: "feature", label: "模块 B", x: 360, y: 260, shape: "rounded" },
        { id: uid(), kind: "feature", label: "模块 C", x: 640, y: 260, shape: "rounded" },
      ];
      const edges: DiagramEdge[] = [
        { id: uid(), from: nodes[0].id, to: nodes[1].id, style: "ortho" },
        { id: uid(), from: nodes[0].id, to: nodes[2].id, style: "ortho" },
        { id: uid(), from: nodes[0].id, to: nodes[3].id, style: "ortho" },
      ];
      return { nodes, edges };
    },
  },
];

const ORDERED_CANVAS_TEMPLATES = (["blank", "module", "flow", "usecase", "arch"] as CanvasTemplateId[])
  .map((id) => CANVAS_TEMPLATES.find((template) => template.id === id)!)
  .filter(Boolean);

function DesignSurfaceBar(props: { active: "canvas" | "database" }): ReactElement {
  return (
    <div className="design-surface-bar">
      <div className="design-surface-brand"><span>DESIGN SURFACE</span><strong>系统设计工作台</strong></div>
      <div className="design-surface-tabs" role="tablist" aria-label="系统设计视图">
        <button type="button" role="tab" aria-selected={props.active === "canvas"} className={props.active === "canvas" ? "active" : ""} onClick={() => navigate("#/canvas")}><Shapes />系统画布</button>
        <button type="button" role="tab" aria-selected={props.active === "database"} className={props.active === "database" ? "active" : ""} onClick={() => navigate("#/canvas?view=database")}><Database />数据库设计</button>
      </div>
      <div className="design-surface-scope-note">项目范围由左侧栏统一控制</div>
    </div>
  );
}

export function CanvasWorkbenchView(props: { diagramId?: string; focusNodeId?: string; designView?: "canvas" | "database" } = {}): ReactElement {
  const limit = 12;
  const [projects, setProjects] = useState<Project[]>([]);
  const [diagrams, setDiagrams] = useState<Diagram[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createProject, setCreateProject] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<Diagram | null>(null);
  const [saved, setSaved] = useState("");
  const [q, setQ] = useState("");
  const [diagramTypeFilter, setDiagramTypeFilter] = useState<"" | DiagramType>("");
  const [ws] = useWorkspace();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const reload = useCallback(() => {
    if (props.diagramId) {
      api.getDiagram(props.diagramId)
        .then(async (target) => {
          const related = await api.listDiagrams(target.projectId);
          setDiagrams(related);
          setTotal(related.length);
          setEditing(target);
          setError("");
        })
        .catch((e) => setError(e.message));
      return;
    }
    api.pageDiagrams({ projectId: ws || undefined, q: q.trim() || undefined, type: diagramTypeFilter || undefined, offset, limit })
      .then((page) => { setDiagrams(page.items); setTotal(page.total); setError(""); })
      .catch((e) => setError(e.message));
  }, [props.diagramId, ws, q, diagramTypeFilter, offset]);
  const reloadProjects = useCallback(() => {
    api.listProjects().then(setProjects).catch(() => undefined);
  }, []);

  useEffect(() => {
    reload();
    reloadProjects();
  }, [reload, reloadProjects]);

  useEffect(() => { setOffset(0); }, [ws]);

  useEffect(() => {
    if (!diagrams) return;
    if (!props.diagramId) {
      setEditing(null);
      return;
    }
    const target = diagrams.find((diagram) => diagram.id === props.diagramId);
    if (target && target.id !== editing?.id) setEditing(target);
  }, [diagrams, editing?.id, props.diagramId]);

  const openCreate = useCallback((projectId?: string) => {
    setCreateProject(projectId || undefined);
    setCreateOpen(true);
  }, []);

  const startRename = useCallback((d: Diagram) => {
    setRenamingId(d.id);
    setRenameValue(d.title);
  }, []);

  const commitRename = useCallback((id: string) => {
    const t = renameValue.trim();
    setRenamingId(null);
    if (!t) return;
    const target = diagrams?.find((d) => d.id === id);
    if (!target || t === target.title) return;
    api.updateDiagram(id, { title: t })
      .then(() => { setSaved("已保存"); reload(); })
      .catch((e) => setError(e.message));
  }, [renameValue, diagrams, reload]);

  const handleExtract = (payload: { nodes: DiagramNode[]; edges: DiagramEdge[]; title: string; sourceNodeIds: string[] }) => {
    if (!editing) return;
    api.createDiagram({ projectId: editing.projectId, title: payload.title, type: editing.type === "main" ? "functional" : editing.type, nodes: payload.nodes, edges: payload.edges, groups: [] })
      .then((newDiag) => {
        const srcSet = new Set(payload.sourceNodeIds ?? []);
        if (srcSet.size === 0) { reload(); setEditing(newDiag); navigate(`#/canvas/${newDiag.id}`); return; }
        const updatedNodes = editing.nodes.map((n) => (srcSet.has(n.id) ? { ...n, linkDiagramIds: [...new Set([...(n.linkDiagramIds ?? []), newDiag.id])] } : n));
        return api.updateDiagram(editing.id, { nodes: updatedNodes })
          .then(() => { reload(); setEditing(newDiag); navigate(`#/canvas/${newDiag.id}`); });
      })
      .catch((e) => setError(e.message));
  };

  if (editing) {
    return (
      <CanvasEditor
        key={`${editing.id}:${editing.updatedAt}`}
        diagram={editing}
        projects={projects}
        allDiagrams={diagrams ?? []}
        focusNodeId={props.focusNodeId}
        onExtractToNewCanvas={handleExtract}
        onOpenDiagram={(id) => {
          const target = diagrams?.find((d) => d.id === id);
          if (!target) {
            window.alert("关联的子画布已被删除，请在节点基本信息中重新关联或清除关联。");
            return;
          }
          setEditing(target);
          navigate(`#/canvas/${target.id}`);
        }}
        onCreateNew={openCreate}
        onCloseCanvas={(id) => {
          if (!window.confirm("确认删除该画布？此操作不可撤销。")) return;
          api.deleteDiagram(id)
            .then(() => {
              reload();
              if (editing && editing.id === id) {
                const remaining = (diagrams ?? []).filter((d) => d.id !== id);
                const next = remaining.find((d) => d.projectId === editing.projectId) ?? remaining[0] ?? null;
                setEditing(next);
                navigate(next ? `#/canvas/${next.id}` : "#/canvas");
              }
            })
            .catch((e) => setError(e.message));
        }}
        onBack={() => { setEditing(null); navigate("#/canvas"); reload(); }}
        onSaved={(title?: string) => {
          setSaved("已保存");
          reload();
          if (title) setEditing((prev) => (prev && prev.title !== title ? { ...prev, title } : prev));
        }}
        onExternalRefresh={reload}
      />
    );
  }

  if (error && !diagrams) return <ErrorBanner message={error} />;
  if (!diagrams) return <Spinner />;
  if (props.diagramId && !editing && !diagrams.some((diagram) => diagram.id === props.diagramId)) {
    return <ErrorBanner message="画布不存在或已被删除" />;
  }
  if (props.diagramId && !editing) return <Spinner />;

  const designView = props.designView ?? "canvas";
  const surfaceBar = <DesignSurfaceBar active={designView} />;

  if (designView === "database") {
    return (
      <div className="canvas-design-hub canvas-database-hub">
        {surfaceBar}
        {ws ? (
          <DatabaseWorkbenchView projectId={ws} embedded surface="canvas" />
        ) : (
          <div className="canvas-database-select-project">
            <span><Database /></span>
            <strong>先选择一个项目</strong>
            <p>数据库模型、表关系和生成代码都必须归属于明确项目。</p>
          </div>
        )}
      </div>
    );
  }

  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const visible = diagrams;
  const byProject = new Map<string, Diagram[]>();
  for (const d of visible) {
    const list = byProject.get(d.projectId) ?? [];
    list.push(d);
    byProject.set(d.projectId, list);
  }
  for (const list of byProject.values()) {
    list.sort((a, b) => Number(b.type === "main") - Number(a.type === "main") || b.updatedAt.localeCompare(a.updatedAt));
  }
  const totalNodes = visible.reduce((n, d) => n + d.nodes.length, 0);
  const totalEdges = visible.reduce((n, d) => n + d.edges.length, 0);

  return (
    <div className="canvas-design-hub">
      {surfaceBar}
      <div className="page-header">
        <h1>画布设计工作台</h1>
      </div>

      <div className="stat-grid">
        <StatCard label="画布总数" value={total} tone="accent" />
        <StatCard label="当前页项目" value={byProject.size} tone="info" />
        <StatCard label="当前页节点" value={totalNodes} tone="good" />
        <StatCard label="当前页连线" value={totalEdges} tone="warn" />
      </div>

      <div className="toolbar">
        <div style={{ position: "relative" }}>
          <Search size={14} style={{ position: "absolute", left: 9, top: 10, color: "var(--text-faint)" }} />
          <input type="text" placeholder="搜索画布标题…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }}
            style={{ paddingLeft: 28, width: 240 }} />
        </div>
        <select
          aria-label="按画布类型筛选"
          value={diagramTypeFilter}
          onChange={(event) => {
            setDiagramTypeFilter(event.target.value as "" | DiagramType);
            setOffset(0);
          }}
        >
          <option value="">全部类型</option>
          {DIAGRAM_TYPES.map((type) => <option key={type} value={type}>{DIAGRAM_TYPE_LABELS[type]}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => openCreate(ws)}>
          <Plus size={14} /> 新建画布
        </button>
        {saved ? <span style={{ color: "var(--good)", fontSize: 12.5 }}>{saved}</span> : null}
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {visible.length === 0 ? (
        <EmptyState text={q || diagramTypeFilter ? "没有匹配的画布。" : (ws ? "当前工作区还没有画布，点「新建画布」开始。" : "还没有画布。点「新建画布」，选择项目后即可开始添加功能节点。")} />
      ) : (
        Array.from(byProject.entries())
          .sort((a, b) => (projectMap.get(a[0])?.name ?? "").localeCompare(projectMap.get(b[0])?.name ?? ""))
          .map(([projectId, list]) => (
            <div className="board-group" key={projectId}>
              <div className="board-group-head">
                <h2>
                  {projectMap.get(projectId)?.name ?? projectId.slice(0, 8)}
                  <span className="count">{list.length}</span>
                </h2>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const p = projectMap.get(projectId);
                    if (p) navigate(`#/projects/${p.id}`);
                  }}
                >
                  打开项目
                </button>
              </div>
              <div className="board-grid">
                {list.map((d) => (
                  <div
                    className={`board-card ${d.type === "main" ? "board-card-main" : ""}`}
                    key={d.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => { setEditing(d); navigate(`#/canvas/${d.id}`); }}
                    onKeyDown={(event) => { if (event.currentTarget === event.target && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setEditing(d); navigate(`#/canvas/${d.id}`); } }}
                  >
                    <div className="board-card-title">
                      {d.type === "main" ? <LockKeyhole size={15} /> : <LayoutGrid size={15} />}
                      {renamingId === d.id ? (
                        <input
                          className="card-rename-input"
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.nativeEvent.isComposing) return;
                            if (e.key === "Enter") commitRename(d.id);
                            else if (e.key === "Escape") setRenamingId(null);
                          }}
                          onBlur={() => commitRename(d.id)}
                        />
                      ) : (
                        <span
                          className="card-rename-span"
                          title="双击重命名"
                          onDoubleClick={(e) => { e.stopPropagation(); startRename(d); }}
                        >{d.title}</span>
                      )}
                    </div>
                    <div className="board-card-meta">
                      <Badge tone={d.type === "main" ? "good" : "accent"}>{DIAGRAM_TYPE_LABELS[d.type]}</Badge>
                      <Badge tone="info">{d.nodes.length} 节点</Badge>
                      <Badge tone="neutral">{d.edges.length} 连线</Badge>
                    </div>
                    <div className="board-card-foot">
                      <span className="cell-sub mono">{formatDateTime(d.updatedAt)}</span>
                      <div className="inline-actions">
                        <button className="btn btn-ghost btn-icon" title="重命名"
                          onClick={(e) => { e.stopPropagation(); startRename(d); }}><PenLine size={13} /></button>
                        <button className="btn btn-ghost btn-icon" title="打开编辑"
                          onClick={(e) => { e.stopPropagation(); setEditing(d); navigate(`#/canvas/${d.id}`); }}><Pencil size={13} /></button>
                        {d.type !== "main" ? (
                          <button className="btn btn-ghost btn-icon btn-danger" title="删除"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`确认删除画布「${d.title}」？`)) {
                                api.deleteDiagram(d.id).then(reload).catch((err) => setError(err.message));
                              }
                            }}><Trash2 size={13} /></button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
      )}
      <Pagination offset={offset} limit={limit} total={total} onChange={setOffset} />

      {createOpen ? (
        <CreateCanvasModal
          projects={projects}
          existing={diagrams}
          defaultProjectId={createProject}
          onClose={() => setCreateOpen(false)}
          onCreated={(d) => {
            setCreateOpen(false);
            setSaved("");
            reload();
            setEditing(d);
            navigate(`#/canvas/${d.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function CanvasEditor(props: {
  diagram: Diagram;
  focusNodeId?: string;
  projects: Project[];
  allDiagrams: Diagram[];
  onExtractToNewCanvas: (payload: { nodes: DiagramNode[]; edges: DiagramEdge[]; title: string; sourceNodeIds: string[] }) => void;
  onOpenDiagram: (id: string) => void;
  onCreateNew: (projectId?: string) => void;
  onCloseCanvas: (id: string) => void;
  onBack: () => void;
  onSaved: (title?: string) => void;
  onExternalRefresh: () => void;
}): ReactElement {
  const [title, setTitle] = useState(props.diagram.title);
  const [diagramType, setDiagramType] = useState<DiagramType>(props.diagram.type);
  const [nodes, setNodes] = useState<DiagramNode[]>(props.diagram.nodes);
  const [edges, setEdges] = useState<DiagramEdge[]>(props.diagram.edges);
  const [groups, setGroups] = useState<DiagramGroup[]>(props.diagram.groups ?? []);
  const [layerState, setLayerState] = useState<DiagramLayerState | null>(props.diagram.layers ?? null);
  const [diagramUpdatedAt, setDiagramUpdatedAt] = useState(props.diagram.updatedAt);
  const [selection, setSelection] = useState<{ nodeIds: string[]; edgeIds: string[]; groupIds: string[] }>({ nodeIds: [], edgeIds: [], groupIds: [] });
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [documents, setDocuments] = useState<DesignDoc[]>([]);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const linkOptions = props.allDiagrams
    .filter((d) => d.projectId === props.diagram.projectId && d.id !== props.diagram.id && d.type !== "main")
    .map((d) => ({ id: d.id, title: d.title, projectId: d.projectId }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteHideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearPaletteHide = () => { if (paletteHideTimer.current) clearTimeout(paletteHideTimer.current); };
  const schedulePaletteHide = () => {
    clearPaletteHide();
    paletteHideTimer.current = setTimeout(() => setPaletteOpen(false), 3000);
  };
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [prototypeOpen, setPrototypeOpen] = useState(false);
  const [freeformOpen, setFreeformOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [renameTab, setRenameTab] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const escapedRef = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typePickerRef = useRef<HTMLDivElement>(null);
  const editorApiRef = useRef<DiagramCanvasApi | null>(null);
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();
  const dirty = useMemo(() => title !== props.diagram.title
    || diagramType !== props.diagram.type
    || JSON.stringify(nodes) !== JSON.stringify(props.diagram.nodes)
    || JSON.stringify(edges) !== JSON.stringify(props.diagram.edges)
    || JSON.stringify(groups) !== JSON.stringify(props.diagram.groups ?? []),
  [diagramType, edges, groups, nodes, props.diagram, title]);

  useEffect(() => {
    const selectedRefs = [
      ...selection.nodeIds.map((id) => ({ type: "diagramNode" as const, id, parentId: props.diagram.id, label: nodes.find((node) => node.id === id)?.label })),
      ...selection.edgeIds.map((id) => ({ type: "diagramEdge" as const, id, parentId: props.diagram.id, label: edges.find((edge) => edge.id === id)?.label })),
    ];
    setPageContextDetail({
      projectId: props.diagram.projectId,
      pageType: "canvas",
      title: `画布 · ${title}`,
      entityRefs: [
        { type: "project", id: props.diagram.projectId },
        { type: "diagram", id: props.diagram.id, label: title },
        ...documents.map((document) => ({ type: "designDocument" as const, id: document.id, label: document.title })),
      ],
      selection: { entityRefs: selectedRefs },
      draft: dirty ? {
        dirty: true,
        baseRevision: props.diagram.updatedAt,
        summary: `画布存在未保存修改；当前选择 ${selection.nodeIds.length} 个节点、${selection.edgeIds.length} 条连线。`,
      } : null,
      visibleContent: agentVisibleContent("documentList", `画布“${title}”及其引用文档`, {
        diagram: { id: props.diagram.id, title, type: diagramType, nodes, edges, updatedAt: props.diagram.updatedAt },
        documents: documents.map((document) => ({ id: document.id, title: document.title, category: document.category, status: document.status, version: document.version, summary: document.summary, content: document.content })),
      }),
    });
  }, [diagramType, dirty, documents, edges, nodes, props.diagram.id, props.diagram.projectId, props.diagram.updatedAt, selection, setPageContextDetail, title]);

  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);

  useEffect(() => {
    if (!lastEntityChange || lastEntityChange.value.entityType !== "diagram" || lastEntityChange.value.entityId !== props.diagram.id) return;
    if (lastEntityChange.value.revision <= props.diagram.updatedAt) return;
    if (dirty) {
      setError("Agent 已更新当前画布，但本地还有未保存修改；已保留本地草稿，请保存或刷新后再同步。");
      return;
    }
    setError("");
    props.onExternalRefresh();
  }, [dirty, lastEntityChange, props.diagram.id, props.diagram.updatedAt, props.onExternalRefresh]);

  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  useEffect(() => {
    if (!typeMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!typePickerRef.current?.contains(event.target as Node)) setTypeMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTypeMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [typeMenuOpen]);

  useEffect(() => {
    let active = true;
    Promise.all([
      api.listPlans(props.diagram.projectId, { diagramId: props.diagram.id }),
      api.listReferencedDesignDocs(props.diagram.projectId, "diagram", props.diagram.id),
    ])
      .then(([items, referencedDocuments]) => { if (active) { setPlans(items); setDocuments(referencedDocuments); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "开发计划加载失败"); });
    return () => { active = false; };
  }, [props.diagram.id, props.diagram.projectId]);

  useEffect(() => {
    let active = true;
    setLayerState(props.diagram.layers ?? null);
    setDiagramUpdatedAt(props.diagram.updatedAt);
    api.getDiagramLayers(props.diagram.id)
      .then((response) => {
        if (!active) return;
        setLayerState({ schemaVersion: response.schemaVersion, layers: response.layers, itemOverrides: response.itemOverrides });
        setDiagramUpdatedAt(response.diagramUpdatedAt);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "图层读取失败"); });
    return () => { active = false; };
  }, [props.diagram.id, props.diagram.layers, props.diagram.updatedAt]);

  const planSummaries = nodes.reduce<Record<string, DiagramPlanSummary>>((summaries, node) => {
    const items = plans
      .filter((plan) => plan.diagramNodeId === node.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (items.length === 0) return summaries;
    const current = items.find((plan) => plan.status === "已阻塞") ?? items.find((plan) => plan.status === "进行中");
    const next = items.find((plan) => plan.status === "未开始");
    summaries[node.id] = {
      total: items.length,
      completed: items.filter((plan) => plan.status === "已完成").length,
      progress: Math.round(items.reduce((sum, plan) => sum + plan.progress, 0) / items.length),
      currentTitle: current?.title,
      nextTitle: next?.title,
    };
    return summaries;
  }, {});

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(""), 1600);
  };

  const canvasTabs = [
    { id: props.diagram.id, title: props.diagram.title },
    ...props.allDiagrams.filter((d) => d.projectId === props.diagram.projectId && d.id !== props.diagram.id),
  ];
  // parent canvas = any canvas with a node pointing to this one
  const parentCanvas = props.allDiagrams.find(
    (d) => d.id !== props.diagram.id && d.nodes.some((n) => (n.linkDiagramIds ?? []).includes(props.diagram.id)),
  );

  const save = () => {
    if (busy) return;
    setBusy(true);
    setError("");
    api.updateDiagram(props.diagram.id, { title: title.trim(), type: diagramType, nodes, edges, groups })
      .then(() => { showHint("已保存"); props.onSaved(); })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const commitTitle = () => {
    const t = title.trim();
    if (!t) { setTitle(props.diagram.title); return; }
    if (t === props.diagram.title) return;
    api.updateDiagram(props.diagram.id, { title: t })
      .then(() => { showHint("已保存"); props.onSaved(t); })
      .catch((e) => setError(e.message));
  };

  const commitTabRename = () => {
    setRenameTab(false);
    const t = renameValue.trim();
    if (!t || t === props.diagram.title) return;
    setTitle(t);
    api.updateDiagram(props.diagram.id, { title: t })
      .then(() => { showHint("已保存"); props.onSaved(t); })
      .catch((e) => setError(e.message));
  };

  const changeDiagramType = (nextType: DiagramType) => {
    if (nextType === diagramType) return;
    if (props.diagram.type === "main") { setError("系统主画布是项目固定入口，不能修改类型"); return; }
    if (nextType === "main") { setError("项目主画布已自动创建，其他画布不能设为主画布"); return; }
    if (nodes.length > 0 && !window.confirm(`切换为「${DIAGRAM_TYPE_LABELS[nextType]}」不会删除现有内容，但会改变元素库和绘图规则。是否继续？`)) return;
    const previous = diagramType;
    setDiagramType(nextType);
    api.updateDiagram(props.diagram.id, { type: nextType })
      .then(() => { showHint("画布类型已更新"); props.onSaved(); })
      .catch((e) => { setDiagramType(previous); setError(e.message); });
  };

  return (
    <div>
      <div className="canvas-head">
        <a className="back-link" href="#/canvas" onClick={(e) => { e.preventDefault(); props.onBack(); }} style={{ marginBottom: 0 }}>
          <ChevronLeft size={15} /> 返回
        </a>
        {parentCanvas ? (
          <button className="btn btn-ghost btn-sm" title="上级画布（相互指向）"
            onClick={() => props.onOpenDiagram(parentCanvas.id)}>
            <CornerUpLeft size={14} /> 上级：{parentCanvas.title}
          </button>
        ) : null}
        <input
          className="canvas-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => { if (escapedRef.current) { escapedRef.current = false; return; } commitTitle(); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); }
            else if (e.key === "Escape") { escapedRef.current = true; setTitle(props.diagram.title); (e.target as HTMLInputElement).blur(); }
          }}
          placeholder="画布标题"
          title="回车保存，Esc 取消"
        />
        <div className="canvas-type-picker" ref={typePickerRef}>
          <button
            type="button"
            className="canvas-type-trigger"
            aria-haspopup="listbox"
            aria-expanded={typeMenuOpen}
            title="切换画布类型"
            onClick={() => setTypeMenuOpen((open) => !open)}
          >
            <span className={`canvas-type-glyph type-${diagramType}`} aria-hidden="true" />
            <span className="canvas-type-trigger-copy">
              <small>画布类型</small>
              <strong>{DIAGRAM_TYPE_LABELS[diagramType]}</strong>
            </span>
            <ChevronDown className={typeMenuOpen ? "open" : ""} size={15} />
          </button>
          {typeMenuOpen ? (
            <div className="canvas-type-menu" role="listbox" aria-label="选择画布类型">
              <div className="canvas-type-menu-label">选择画布类型</div>
              {(Object.keys(DIAGRAM_TYPE_LABELS) as DiagramType[]).map((type) => {
                const active = type === diagramType;
                const disabled = props.diagram.type === "main" ? type !== "main" : type === "main";
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={active ? "active" : ""}
                    disabled={disabled}
                    title={disabled ? (props.diagram.type === "main" ? "系统主画布类型已锁定" : "该项目已自动创建系统主画布") : undefined}
                    key={type}
                    onClick={() => {
                      setTypeMenuOpen(false);
                      changeDiagramType(type);
                    }}
                  >
                    <span className={`canvas-type-glyph type-${type}`} aria-hidden="true" />
                    <span><strong>{DIAGRAM_TYPE_LABELS[type]}</strong><small>{disabled ? (type === "main" ? "项目唯一，由系统自动创建" : "主画布类型已锁定") : DIAGRAM_TYPE_DESCRIPTIONS[type]}</small></span>
                    {active ? <Check size={15} /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => props.onCreateNew(props.diagram.projectId)} title="新建画布">
          <Plus size={14} /> 新建
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setDocumentsOpen(true)} title="查看画布引用的系统文档">
          <BookOpen size={14} /> 文档 {documents.length}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setPrototypeOpen(true)} title="打开应用页面原型设计器">
          <PenLine size={14} /> 页面原型
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setFreeformOpen(true)} title="打开自由创作与富媒体工具（自由元素不进入交付门禁）">
          <Shapes size={14} /> 自由层
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setLayersOpen((open) => !open)} title="图层面板与组件库：命名/排序/锁定/隐藏、批量选择、可复用组件（不进交付门禁）">
          <Layers size={14} /> 图层/组件
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setTemplatesOpen(true)} title="模板库：系统内置与项目级模板（落 diagram_templates）">
          <LayoutGrid size={14} /> 模板
        </button>
        <div className="header-actions">
          {hint ? <span className="save-hint">{hint}</span> : null}
          {props.diagram.type === "main" ? (
            <span className="main-canvas-lock"><LockKeyhole size={13} /> 项目固定主画布</span>
          ) : (
            <button
              className="btn btn-ghost btn-icon btn-danger"
              title="删除画布（不可撤销）"
              onClick={() => props.onCloseCanvas(props.diagram.id)}
            >
              <Trash2 size={15} />
            </button>
          )}
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? "保存中…" : "保存画布"}
          </button>
        </div>
      </div>

      <div className="canvas-tabs">
        {canvasTabs.map((d) => {
          const active = d.id === props.diagram.id;
          return (
            <div
              key={d.id}
              className={`canvas-tab-item ${active ? "active" : ""}`}
              onClick={() => { if (!active) props.onOpenDiagram(d.id); }}
              title={active ? "当前画布（双击标题重命名）" : "点击切换"}
            >
              {active && renameTab ? (
                <input
                  className="canvas-tab-input"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter") commitTabRename();
                    else if (e.key === "Escape") setRenameTab(false);
                  }}
                  onBlur={commitTabRename}
                />
              ) : (
                <span
                  className="canvas-tab-title"
                  onDoubleClick={(e) => {
                    if (active) { e.stopPropagation(); setRenameValue(props.diagram.title); setRenameTab(true); }
                  }}
                >{d.title}</span>
              )}
              {active ? (
                <button
                  className="canvas-tab-x"
                  title="关闭（不删除，返回列表）"
                  onClick={(e) => { e.stopPropagation(); props.onBack(); }}
                >×</button>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      {documentsOpen ? <Modal title={`画布文档 · ${title}`} onClose={() => setDocumentsOpen(false)} width={860} footer={<button className="btn" onClick={() => setDocumentsOpen(false)}>关闭</button>}>
        <DocumentReferencePanel
          projectId={props.diagram.projectId}
          targetType="diagram"
          targetId={props.diagram.id}
          relationType="defines"
          title="画布引用文档"
          description="画布不拥有文档，只引用项目系统文档的固定版本；Agent 会静默读取这些引用文档。"
          createActions={<button className="btn" onClick={() => navigate("#/design")}><Plus size={14} /> 打开系统文档库</button>}
          onLoaded={(nextDocuments) => setDocuments(nextDocuments)}
        />
      </Modal> : null}
      <div className="canvas-editor-body">
        <button
          className={`palette-tab ${paletteOpen ? "open" : ""}`}
          title="元素库（划入显示）"
          onMouseEnter={() => { clearPaletteHide(); setPaletteOpen(true); }}
          onClick={() => { clearPaletteHide(); setPaletteOpen((v) => !v); }}
        >
          <Shapes size={14} /> 元素库
        </button>
        {paletteOpen ? (
          <div className="shape-palette-dock" onMouseEnter={clearPaletteHide} onMouseLeave={schedulePaletteHide}>
            <ShapePalette
              diagramType={diagramType}
              onInsert={(kind, shape, label, flowType, useCaseType) => editorApiRef.current?.insertNode(kind, shape, label, flowType, useCaseType)}
              onHide={() => { clearPaletteHide(); setPaletteOpen(false); }}
            />
          </div>
        ) : null}
        <DiagramCanvas
          initial={{ nodes, edges, groups }}
          diagramType={diagramType}
          planSummaries={planSummaries}
          initialSelectedNodeId={props.focusNodeId}
          viewportKey={props.diagram.id}
          linkOptions={linkOptions}
          onOpenDiagram={props.onOpenDiagram}
          onOpenNodeDetails={(nodeId, tab) => navigate(`#/canvas/${props.diagram.id}/node/${nodeId}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`)}
          titleForExport={title}
          onExtractToNewCanvas={props.onExtractToNewCanvas}
          onRegisterApi={(api) => { editorApiRef.current = api; }}
          onCommit={(n, e, g) => { setNodes(n); setEdges(e); setGroups(g); }}
          onSelectionChange={setSelection}
          layerState={layerState}
          keyboardDisabled={prototypeOpen || freeformOpen}
        />
      </div>
      {prototypeOpen ? <PrototypeDesigner diagramId={props.diagram.id} title={title} onClose={() => setPrototypeOpen(false)} /> : null}
      {freeformOpen ? <WhiteboardFreeformCanvas
        diagramId={props.diagram.id}
        projectId={props.diagram.projectId}
        title={title}
        deliveryNodes={nodes.map((node) => ({ id: node.id, label: node.label }))}
        onClose={() => setFreeformOpen(false)}
      /> : null}
      {layersOpen ? (
        <div className="whiteboard-panel-dock" aria-label="图层与组件面板">
          <DiagramLayerPanel
            diagramId={props.diagram.id}
            diagram={{ nodes, edges }}
            onClose={() => setLayersOpen(false)}
            onSelectionChange={(itemKeys) => editorApiRef.current?.selectItems(itemKeys)}
            onLayersChanged={(state, updatedAt) => { setLayerState(state); setDiagramUpdatedAt(updatedAt); }}
          />
          <DiagramComponentLibrary
            diagramId={props.diagram.id}
            diagramUpdatedAt={diagramUpdatedAt}
            selection={{ nodeIds: selection.nodeIds, edgeIds: selection.edgeIds, freeformIds: [] }}
          />
        </div>
      ) : null}
      {templatesOpen ? (
        <DiagramTemplateLibrary
          projectId={props.diagram.projectId}
          currentDiagram={props.diagram}
          diagrams={props.allDiagrams.filter((diagram) => diagram.projectId === props.diagram.projectId)}
          onClose={() => setTemplatesOpen(false)}
          // 应用成功后不关闭对话框：设计 9.3 要求把“已应用模板…新增 N 节点”的结果提示留给用户阅读；
          // 只刷新画布列表，使目标画布的 updatedAt 成为后续 CAS 基准。
          onApplied={() => { props.onExternalRefresh(); }}
        />
      ) : null}
    </div>
  );
}

function CreateCanvasModal(props: {
  projects: Project[];
  existing: Diagram[];
  defaultProjectId?: string;
  onClose: () => void;
  onCreated: (diagram: Diagram) => void;
}): ReactElement {
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(props.defaultProjectId ?? props.projects[0]?.id ?? "");
  const [templateId, setTemplateId] = useState<CanvasTemplateId>("blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  const t = title.trim();
  const template = CANVAS_TEMPLATES.find((v) => v.id === templateId) ?? CANVAS_TEMPLATES[0];
  const projectName = props.projects.find((p) => p.id === projectId)?.name ?? "";
  const duplicate = t.length > 0 && props.existing.some((d) => d.projectId === projectId && d.title === t);

  const submit = () => {
    if (!t || !projectId || busy) return;
    setBusy(true); setError("");
    const seed = template.build();
    api.createDiagram({ projectId, title: t, type: template.type, nodes: seed.nodes, edges: seed.edges, groups: [] })
      .then((d) => props.onCreated(d))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  if (props.projects.length === 0) {
    return (
      <Modal title="新建画布" onClose={props.onClose} width={560}
        footer={<button className="btn" onClick={props.onClose}>关闭</button>}
      >
        <EmptyState text="还没有任何项目。画布需要挂到项目下，请先创建一个项目。" />
        <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
          <button className="btn btn-primary" onClick={() => { props.onClose(); navigate("#/projects"); }}>
            <Plus size={14} /> 去创建项目
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="新建画布"
      onClose={props.onClose}
      width={620}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={busy || !t || !projectId}
            onClick={submit}
          >
            {busy ? "创建中…" : "创建并编辑"}
          </button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      <div className="form-grid">
        <Field label="画布类型" wide>
          <div className="template-grid">
            {ORDERED_CANVAS_TEMPLATES.map((v) => (
              <button
                type="button"
                key={v.id}
                className={`template-card ${v.id === templateId ? "active" : ""}`}
                onClick={() => setTemplateId(v.id)}
              >
                <div className="template-card-name">{v.name}</div>
                <div className="template-card-desc">{v.desc}</div>
              </button>
            ))}
          </div>
        </Field>
        <Field label="画布标题">
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            placeholder="如 登录模块架构图"
          />
        </Field>
        <Field label="所属项目">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>
      {duplicate ? (
        <div className="form-warn">项目「{projectName}」下已有同名画布，建议换个标题以免混淆。</div>
      ) : null}
    </Modal>
  );
}
