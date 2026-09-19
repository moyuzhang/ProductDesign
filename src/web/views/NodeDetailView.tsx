import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  FileText,
  GitBranch,
  ListChecks,
  PanelsTopLeft,
  Pencil,
  Plus,
  Save,
  Table2,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  DESIGN_DOC_CATEGORIES,
  DESIGN_DOC_STATUSES,
  DESIGN_STATUSES,
  DIAGRAM_FLOW_NODE_TYPES,
  DIAGRAM_NODE_KINDS,
  NODE_DATABASE_OPERATIONS,
  PRIORITIES,
  REQUIREMENT_STATUSES,
  type DesignDoc,
  type DesignDocCategory,
  type DesignDocStatus,
  type DesignStatus,
  type DesignChangeResult,
  type DatabaseModel,
  type Diagram,
  type DiagramAcceptanceStatus,
  type DiagramDevelopmentStatus,
  type DiagramFlowNodeType,
  type DiagramNode,
  type DiagramNodeKind,
  type Evidence,
  type NodeShape,
  type NodeDatabaseBinding,
  type NodeDatabaseOperation,
  type PlanItem,
  type PlanAgentRole,
  type Priority,
  type Project,
  type ProjectWorkflow,
  type RequirementStatus,
} from "../../shared/types";
import { displayAssignment, normalizeRoleAssignments, roleAssignmentErrors } from "../../shared/planRoles";
import { api } from "../api";
import { navigate } from "../App";
import { Badge, EmptyState, ErrorBanner, Field, Modal, Spinner, formatDateTime } from "../ui";
import { agentVisibleContent, useAgentUiBridge } from "./agentUiBridge";
import { DocumentReferencePanel } from "./DocumentReferencePanel";
import { PlanDeliveryPanel } from "./PlanDeliveryPanel";
import { PLAN_LIFECYCLE_LABELS } from "../../shared/planDelivery";

type DetailTab = "overview" | "development" | "delivery" | "documents" | "relations";
const DETAIL_TABS: DetailTab[] = ["overview", "development", "delivery", "documents", "relations"];
const DELIVERY_DIAGRAM_TYPES = new Set(["main", "functional", "deployment"]);
const DELIVERY_NODE_KINDS = new Set(["module", "feature", "requirement", "interface", "data"]);

const DATABASE_OPERATION_LABEL: Record<NodeDatabaseOperation, string> = {
  read: "查询",
  create: "新增",
  update: "修改",
  delete: "删除",
};

const NODE_KIND_LABELS: Record<DiagramNodeKind, string> = {
  system: "系统",
  module: "模块",
  feature: "功能",
  requirement: "需求",
  interface: "接口",
  data: "数据",
  note: "备注",
};

const FLOW_NODE_META: Record<DiagramFlowNodeType, { label: string; shape: NodeShape; kind: DiagramNodeKind }> = {
  start: { label: "开始", shape: "ellipse", kind: "system" },
  end: { label: "结束", shape: "ellipse", kind: "system" },
  process: { label: "处理 / 流程", shape: "rect", kind: "feature" },
  decision: { label: "判断", shape: "diamond", kind: "requirement" },
  input_output: { label: "输入 / 输出", shape: "parallelogram", kind: "data" },
  subprocess: { label: "预定义流程", shape: "predefined", kind: "interface" },
  document: { label: "文档", shape: "document", kind: "note" },
};

function flowTypeOf(node: DiagramNode): DiagramFlowNodeType {
  if (node.flowType) return node.flowType;
  if (node.shape === "diamond") return "decision";
  if (node.shape === "parallelogram") return "input_output";
  if (node.shape === "predefined" || node.shape === "hexagon") return "subprocess";
  if (node.shape === "document" || node.kind === "note") return "document";
  if (node.shape === "ellipse") return /结束|终止|完成/.test(node.label) ? "end" : "start";
  return "process";
}

// Display-only summary: strip the design-revision boilerplate prefix like
// "固定设计修订 15e13262-6594-4cbe-ac64-c29ad9341e66。" from plan descriptions.
function planSummaryText(description: string): string {
  return description.replace(/^固定设计修订\s*[^。]*。\s*/, "");
}

const DEVELOPMENT_TONE: Record<DiagramDevelopmentStatus, "neutral" | "info" | "warn" | "good" | "bad"> = {
  未开发: "neutral",
  开发中: "info",
  待验收: "warn",
  已完成: "good",
  已阻塞: "bad",
};

const ACCEPTANCE_TONE: Record<DiagramAcceptanceStatus, "neutral" | "accent" | "good" | "bad"> = {
  未验收: "neutral",
  验收中: "accent",
  已通过: "good",
  未通过: "bad",
};

const DOC_STATUS_TONE: Record<DesignDocStatus, "muted" | "warn" | "good" | "neutral"> = {
  草拟: "muted",
  评审中: "warn",
  已批准: "good",
  已废弃: "neutral",
};

const isExternalUrl = (value: string): boolean => /^https?:\/\//i.test(value.trim());

function NodeDetailSkeleton(): ReactElement {
  return (
    <div className="node-detail-page">
      <div className="node-detail-topbar">
        <div className="sk sk-pill" />
        <div className="sk sk-line" style={{ width: 220 }} />
        <div className="header-actions"><div className="sk sk-pill" /><div className="sk sk-pill" /></div>
      </div>
      <section className="node-detail-hero">
        <div className="sk sk-line" style={{ width: 130, marginBottom: 16 }} />
        <div className="sk sk-title" style={{ width: "58%", marginBottom: 12 }} />
        <div className="sk sk-line" style={{ width: "82%" }} />
        <div className="node-detail-statuses">
          <div className="sk sk-pill" /><div className="sk sk-pill" />
          <div className="sk sk-line" style={{ width: 120 }} />
        </div>
        <div className="node-detail-metrics">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <div className="sk sk-title" style={{ height: 18, width: "100%", marginBottom: 6 }} />
              <div className="sk sk-line" style={{ width: "70%" }} />
            </div>
          ))}
        </div>
      </section>
      <nav className="node-detail-tabs">
        {["overview", "development", "delivery", "documents", "relations"].map((t) => (
          <div key={t} className="sk sk-pill" style={{ height: 30 }} />
        ))}
      </nav>
      <div className="node-detail-grid">
        <div className="sk sk-card" style={{ flex: 2 }} />
        <div className="sk sk-card" style={{ flex: 1 }} />
      </div>
    </div>
  );
}

export function NodeDetailView(props: { diagramId: string; nodeId: string; initialTab?: string; initialPlanId?: string }): ReactElement {
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<DiagramNode | null>(null);
  const [documents, setDocuments] = useState<DesignDoc[]>([]);
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [workflow, setWorkflow] = useState<ProjectWorkflow | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [databaseModels, setDatabaseModels] = useState<DatabaseModel[]>([]);
  const [databaseBindings, setDatabaseBindings] = useState<NodeDatabaseBinding[]>([]);
  const [allDiagrams, setAllDiagrams] = useState<Diagram[]>([]);
  const [tab, setTab] = useState<DetailTab>(() => DETAIL_TABS.includes(props.initialTab as DetailTab) ? props.initialTab as DetailTab : "overview");
  const [documentEditor, setDocumentEditor] = useState<{ doc?: DesignDoc; category?: DesignDocCategory } | null>(null);
  const [planEditor, setPlanEditor] = useState<{ plan?: PlanItem } | null>(null);
  const [databaseBindingEditor, setDatabaseBindingEditor] = useState<{ binding?: NodeDatabaseBinding } | null>(null);
  const [evidenceEditor, setEvidenceEditor] = useState<{ plan?: PlanItem } | null>(null);
  const [designChangeOpen, setDesignChangeOpen] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState(props.initialPlanId ?? "");
  const [planBusyId, setPlanBusyId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();

  useEffect(() => {
    setTab(DETAIL_TABS.includes(props.initialTab as DetailTab) ? props.initialTab as DetailTab : "overview");
  }, [props.initialTab]);
  useEffect(() => {
    setSelectedPlanId(props.initialPlanId ?? "");
  }, [props.diagramId, props.initialPlanId, props.nodeId]);

  const loadDocuments = useCallback(async (projectId: string) => {
    setDocuments(await api.listReferencedDesignDocs(projectId, "diagramNode", props.nodeId));
  }, [props.nodeId]);

  const loadPlans = useCallback(async (projectId: string) => {
    setPlans(await api.listPlans(projectId, { diagramId: props.diagramId, diagramNodeId: props.nodeId }));
  }, [props.diagramId, props.nodeId]);

  const loadEvidence = useCallback(async (projectId: string) => {
    setEvidence(await api.listEvidence(projectId, { nodeId: props.nodeId }));
  }, [props.nodeId]);

  const loadDatabaseBindings = useCallback(async () => {
    setDatabaseBindings(await api.listNodeDatabaseBindings({ diagramId: props.diagramId, diagramNodeId: props.nodeId }));
  }, [props.diagramId, props.nodeId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api.getDiagram(props.diagramId)
      .then(async (nextDiagram) => {
        const node = nextDiagram.nodes.find((candidate) => candidate.id === props.nodeId);
        if (!node) throw new Error("节点不存在或已从画布删除");
        const [nextProject, docs, nodePlans, nodeEvidence, models, bindings, nextWorkflow, allDiagrams] = await Promise.all([
          api.getProject(nextDiagram.projectId),
          api.listReferencedDesignDocs(nextDiagram.projectId, "diagramNode", props.nodeId),
          api.listPlans(nextDiagram.projectId, { diagramId: props.diagramId, diagramNodeId: props.nodeId }),
          api.listEvidence(nextDiagram.projectId, { nodeId: props.nodeId }),
          api.listDatabaseModels(nextDiagram.projectId),
          api.listNodeDatabaseBindings({ diagramId: props.diagramId, diagramNodeId: props.nodeId }),
          api.getProjectWorkflow(nextDiagram.projectId),
          api.listDiagrams(nextDiagram.projectId),
        ]);
        if (!active) return;
        setDiagram(nextDiagram);
        setDraft(node);
        setProject(nextProject);
        setDocuments(docs);
        setPlans(nodePlans);
        setEvidence(nodeEvidence);
        setDatabaseModels(models);
        setDatabaseBindings(bindings);
        setWorkflow(nextWorkflow);
        setAllDiagrams(allDiagrams);
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "节点详情加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [props.diagramId, props.nodeId]);

  const dirty = useMemo(() => Boolean(diagram && draft
    && JSON.stringify(draft) !== JSON.stringify(diagram.nodes.find((node) => node.id === props.nodeId))),
  [diagram, draft, props.nodeId]);

  useEffect(() => {
    if (!diagram || !draft) return;
    const relatedRefs = [
      ...documents.slice(0, 30).map((doc) => ({ type: "designDocument" as const, id: doc.id, label: doc.title })),
      ...plans.slice(0, 30).map((plan) => ({ type: "plan" as const, id: plan.id, label: plan.title })),
      ...evidence.slice(0, 30).map((item) => ({ type: "evidence" as const, id: item.id, label: item.summary })),
      ...databaseBindings.slice(0, 15).flatMap((binding) => {
        const model = databaseModels.find((candidate) => candidate.id === binding.databaseModelId);
        const table = model?.tables.find((candidate) => candidate.name.toLocaleLowerCase() === binding.tableName.toLocaleLowerCase());
        return [
          { type: "nodeDatabaseBinding" as const, id: binding.id, label: `${binding.schemaName}.${binding.tableName}` },
          ...(model ? [{ type: "databaseModel" as const, id: model.id, label: model.name }] : []),
          ...(model && table ? [{ type: "databaseTable" as const, id: table.id, parentId: model.id, label: table.name }] : []),
        ];
      }),
    ];
    const visible = tab === "documents" ? documents
      : tab === "development" ? plans
        : tab === "relations" ? { databaseBindings, databaseModels: databaseModels.map((model) => ({ id: model.id, name: model.name, dialect: model.dialect, tables: model.tables.map((table) => ({ id: table.id, name: table.name, displayName: table.displayName })) })) }
          : { node: draft, evidence: tab === "delivery" ? evidence : undefined, diagram: { id: diagram.id, title: diagram.title, type: diagram.type, updatedAt: diagram.updatedAt } };
    const pageType = tab === "documents" ? "document" : tab === "development" ? "plan" : tab === "relations" ? "database" : "node";
    const kind = tab === "documents" ? "documentList" : tab === "development" ? "planList" : "node";
    setPageContextDetail({
      projectId: diagram.projectId,
      pageType,
      title: `节点 · ${draft.label} · ${tab}`,
      entityRefs: [
        { type: "project", id: diagram.projectId },
        { type: "diagram", id: diagram.id, label: diagram.title },
        { type: "diagramNode", id: draft.id, parentId: diagram.id, label: draft.label },
        ...relatedRefs,
      ],
      selection: { entityRefs: [{ type: "diagramNode", id: draft.id, parentId: diagram.id, label: draft.label }] },
      draft: dirty ? { dirty: true, baseRevision: diagram.updatedAt, summary: "当前 visibleContent 含节点详情页中尚未保存的字段。" } : null,
      visibleContent: agentVisibleContent(kind, `${draft.label} · ${tab}`, visible),
    });
  }, [databaseBindings, databaseModels, diagram, dirty, documents, draft, evidence, plans, setPageContextDetail, tab]);
  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);

  useEffect(() => {
    if (!diagram || !lastEntityChange || lastEntityChange.value.projectId !== diagram.projectId) return;
    const change = lastEntityChange.value;
    if (change.entityType === "diagram" && change.entityId === diagram.id && change.revision > diagram.updatedAt) {
      if (dirty) {
        setError("Agent 已更新当前节点，但本地还有未保存修改；已保留本地草稿，请保存或刷新后同步。");
        return;
      }
      api.getDiagram(diagram.id).then((next) => {
        const node = next.nodes.find((candidate) => candidate.id === props.nodeId);
        if (!node) { setError("Agent 更新后当前节点已不存在"); return; }
        setDiagram(next); setDraft(node);
      }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      return;
    }
    if (change.entityType === "designDocument") void loadDocuments(diagram.projectId);
    else if (change.entityType === "plan") void loadPlans(diagram.projectId);
    else if (change.entityType === "evidence") void loadEvidence(diagram.projectId);
    else if (change.entityType === "nodeDatabaseBinding") void loadDatabaseBindings();
    else if (change.entityType === "databaseModel") void api.listDatabaseModels(diagram.projectId).then(setDatabaseModels);
  }, [diagram, dirty, lastEntityChange, loadDatabaseBindings, loadDocuments, loadEvidence, loadPlans, props.nodeId]);

  const updateDraft = <K extends keyof DiagramNode>(key: K, value: DiagramNode[K]) => {
    setSaved("");
    setDraft((current) => current ? { ...current, [key]: value } : current);
  };

  const selectTab = (id: DetailTab) => {
    setTab(id);
    const query = new URLSearchParams({ tab: id });
    if (selectedPlanId) query.set("plan", selectedPlanId);
    window.history.replaceState(null, "", `#/canvas/${props.diagramId}/node/${props.nodeId}?${query.toString()}`);
  };
  const selectPlan = (planId: string) => {
    setSelectedPlanId(planId);
    const query = new URLSearchParams({ tab: "development", plan: planId });
    window.history.replaceState(null, "", `#/canvas/${props.diagramId}/node/${props.nodeId}?${query.toString()}`);
  };
  const onTabKeyDown = (event: React.KeyboardEvent, current: DetailTab) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = DETAIL_TABS.indexOf(current);
    let next = index;
    if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "ArrowRight") next = Math.min(DETAIL_TABS.length - 1, index + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = DETAIL_TABS.length - 1;
    selectTab(DETAIL_TABS[next]);
  };

  const saveNode = () => {
    if (!diagram || !draft || busy) return;
    const label = draft.label.trim();
    if (!label) { setError("节点名称不能为空"); return; }
    if (diagram.nodes.some((node) => node.id !== draft.id && node.label.trim() === label)) {
      setError("当前画布已经存在同名节点");
      return;
    }
    const nextNode = { ...draft, label, deliveryUpdatedAt: new Date().toISOString() };
    const nextNodes = diagram.nodes.map((node) => node.id === nextNode.id ? nextNode : node);
    setBusy(true);
    setError("");
    api.updateDiagram(diagram.id, { nodes: nextNodes })
      .then((nextDiagram) => {
        setDiagram(nextDiagram);
        setDraft(nextDiagram.nodes.find((node) => node.id === nextNode.id) ?? nextNode);
        setSaved("节点信息已保存");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "保存失败"))
      .finally(() => setBusy(false));
  };

  const relations = useMemo(() => {
    if (!diagram) return [];
    return diagram.edges
      .filter((edge) => edge.from === props.nodeId || edge.to === props.nodeId)
      .map((edge) => {
        const outgoing = edge.from === props.nodeId;
        const peerId = outgoing ? edge.to : edge.from;
        return { edge, outgoing, peer: diagram.nodes.find((node) => node.id === peerId) };
      });
  }, [diagram, props.nodeId]);
  const databaseModelById = useMemo(() => new Map(databaseModels.map((model) => [model.id, model])), [databaseModels]);

  // The parent of the current diagram is a node in another diagram whose linkDiagramIds includes this diagram.
  const parentContext = useMemo(() => {
    if (!diagram || allDiagrams.length === 0) return null;
    for (const canvas of allDiagrams) {
      if (canvas.id === diagram.id) continue;
      const parentNode = canvas.nodes.find((n) => (n.linkDiagramIds ?? []).includes(diagram.id));
      if (parentNode) return { parentDiagram: canvas, parentNode };
    }
    return null;
  }, [diagram, allDiagrams]);

  const goBack = () => {
    // Return to the actual source page (project node list, canvas, parent, plan page).
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    navigate(parentContext ? `#/canvas/${parentContext.parentDiagram.id}?node=${parentContext.parentNode.id}` : `#/canvas/${diagram?.id}?node=${draft?.id}`);
  };

  if (loading) return <NodeDetailSkeleton />;
  if (error && (!diagram || !draft)) return <ErrorBanner message={error} />;
  if (!diagram || !draft) return <ErrorBanner message="节点详情不存在" />;

  const developmentStatus = draft.developmentStatus ?? "未开发";
  const acceptanceStatus = draft.acceptanceStatus ?? "未验收";
  const requirementStatus = draft.requirementStatus ?? "待整理";
  const designStatus = draft.designStatus ?? "未开始";
  const documentCount = documents.length;
  const requirementDoc = documents.find((doc) => doc.category === "需求文档");
  const otherDocs = documents.filter((doc) => doc.category !== "需求文档");
  const evidenceCount = evidence.length;
  const planProgress = plans.length === 0 ? 0 : Math.round(plans.reduce((sum, plan) => sum + plan.progress, 0) / plans.length);
  const completedPlanCount = plans.filter((plan) => plan.status === "已完成").length;
  const currentPlan = plans.find((plan) => plan.status === "已阻塞") ?? plans.find((plan) => plan.status === "进行中") ?? null;
  const nextPlan = plans.find((plan) => plan.status === "未开始") ?? null;
  const allPlansCompleted = plans.length > 0 && completedPlanCount === plans.length;
  const deliveryTracked = DELIVERY_DIAGRAM_TYPES.has(diagram.type) && DELIVERY_NODE_KINDS.has(draft.kind);
  const activeTab: DetailTab = !deliveryTracked && (tab === "development" || tab === "delivery") ? "overview" : tab;
  const visibleTabs = deliveryTracked
    ? DETAIL_TABS
    : DETAIL_TABS.filter((item) => item !== "development" && item !== "delivery");
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId)
    ?? plans.find((plan) => plan.lifecycleStatus !== "accepted")
    ?? plans[0]
    ?? null;
  const nodeLayer = workflow?.nodes.find((node) => node.diagramId === diagram.id && node.nodeId === draft.id);
  const layerByPlanId = new Map(workflow?.layerGate.plans.map((state) => [state.planId, state]) ?? []);
  const canRequestDesignChange = deliveryTracked
    && (designStatus === "已批准" || plans.length > 0 || acceptanceStatus === "已通过");

  return (
    <div className="node-detail-page">
      <div className="node-detail-topbar">
        <button className="btn btn-ghost btn-sm" onClick={goBack}>
          <ArrowLeft size={14} /> 返回
        </button>
        <div className="node-detail-breadcrumb">
          <span>{project?.name ?? diagram.projectId}</span>
          <span>/</span>
          {parentContext ? (
            <>
              <button className="crumb-link" onClick={() => navigate(`#/canvas/${parentContext.parentDiagram.id}?node=${parentContext.parentNode.id}`)}>{parentContext.parentNode.label}</button>
              <span>/</span>
            </>
          ) : null}
          <span>{diagram.title}</span>
          <span>/</span>
          <strong>{draft.label}</strong>
        </div>
        <div className="header-actions">
          {saved ? <span className="save-hint">{saved}</span> : null}
          <button className="btn btn-ghost btn-sm" onClick={() => {
            void navigator.clipboard.writeText(window.location.href).then(() => setSaved("详情链接已复制")).catch(() => setError("复制链接失败"));
          }}>
            <Copy size={13} /> 复制链接
          </button>
          {canRequestDesignChange ? <button
            className="btn btn-danger btn-sm"
            disabled={busy || documents.length === 0 || plans.filter((plan) => plan.kind === "task").length === 0}
            title={documents.length === 0 || plans.length === 0 ? "需要至少一份关联文档和一个开发计划" : "冻结当前施工并建立可审计返工基线"}
            onClick={() => setDesignChangeOpen(true)}
          >
            <TriangleAlert size={14} /> 发起设计变更
          </button> : null}
          <button className="btn btn-primary" disabled={busy} onClick={saveNode}>
            <Save size={14} /> {busy ? "保存中…" : "保存节点"}
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <section className="node-detail-hero" data-kind={diagram.type === "flow" ? FLOW_NODE_META[flowTypeOf(draft)].label : NODE_KIND_LABELS[draft.kind]}>
        <div className="node-detail-kind">{diagram.type === "flow" ? FLOW_NODE_META[flowTypeOf(draft)].label : NODE_KIND_LABELS[draft.kind]} · NODE DOSSIER</div>
        <h1>{draft.label}</h1>
        <p title={draft.description?.trim() || undefined}>{draft.description?.trim() || "还没有填写功能说明。"}</p>
        <div className="node-detail-statuses">
          {deliveryTracked ? <>
            <Badge tone={requirementStatus === "已批准" ? "good" : requirementStatus === "已拒绝" ? "bad" : "neutral"}>需求 · {requirementStatus}</Badge>
            <Badge tone={designStatus === "已批准" || designStatus === "不适用" ? "good" : "neutral"}>设计 · {designStatus}</Badge>
            <Badge tone={DEVELOPMENT_TONE[developmentStatus]}>开发 · {developmentStatus}</Badge>
            <Badge tone={ACCEPTANCE_TONE[acceptanceStatus]}>验收 · {acceptanceStatus}</Badge>
            {nodeLayer?.deliveryLayer ? <Badge tone={nodeLayer.layerLocked ? "muted" : "info"}>第 {nodeLayer.deliveryLayer} 层{nodeLayer.layerLocked ? " · 实现依赖未解锁" : " · 当前可推进"}</Badge> : null}
          </> : <Badge tone="info">架构对象 · 不进入施工验收</Badge>}
          <span>{draft.owner?.trim() || "未指定负责人"}</span>
          <span>更新 {formatDateTime(draft.deliveryUpdatedAt ?? diagram.updatedAt)}</span>
        </div>
        {deliveryTracked ? <div className="node-detail-metrics">
          <div><strong>{planProgress}%</strong><span>开发进度</span></div>
          <div><strong>{completedPlanCount}/{plans.length}</strong><span>计划动作</span></div>
          <div><strong>{documentCount}</strong><span>关联文档</span></div>
          <div><strong>{evidenceCount}</strong><span>验收证据</span></div>
        </div> : null}
      </section>

      <nav className="node-detail-tabs" aria-label="节点详情导航">
        <div className="node-detail-tab-list" role="tablist" aria-label="节点详情">
          {([
            ["overview", "功能概览", FileText],
            ["development", `开发计划 ${completedPlanCount}/${plans.length}`, ListChecks],
            ["delivery", "交付与验收", CheckCircle2],
            ["documents", `文档资料 ${documentCount}`, BookOpen],
            ["relations", `关联关系 ${relations.length + databaseBindings.length}`, GitBranch],
          ] as const).filter(([id]) => visibleTabs.includes(id)).map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              id={`nodetab-${id}`}
              aria-selected={activeTab === id}
              aria-controls={`nodepanel-${id}`}
              className={activeTab === id ? "active" : ""}
              onClick={() => selectTab(id)}
              onKeyDown={(event) => onTabKeyDown(event, id)}
            >
              <Icon size={15} /> <span className="node-detail-tab-label">{label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="node-detail-canvas-button"
          aria-label="打开当前画布"
          onClick={() => navigate(`#/canvas/${diagram.id}?node=${draft.id}`)}
        >
          <PanelsTopLeft size={15} /> 画布
        </button>
      </nav>

      <div className="node-detail-content" role="tabpanel" aria-label="节点详情内容">
        {activeTab === "overview" ? (
          <>
            <div className="node-detail-grid">
              <section className="node-detail-card node-detail-card-wide">
                <div className="node-detail-card-heading"><FileText size={16} /><h2>功能定义</h2></div>
                <Field label="节点名称"><input type="text" value={draft.label} onChange={(event) => updateDraft("label", event.target.value)} /></Field>
                <Field label="功能说明"><textarea rows={7} value={draft.description ?? ""} placeholder="这个功能解决什么问题、负责什么、不负责什么" onChange={(event) => updateDraft("description", event.target.value)} /></Field>
                <Field label="补充说明"><textarea rows={5} value={draft.notes ?? ""} placeholder="约束、例外情况、待确认事项" onChange={(event) => updateDraft("notes", event.target.value)} /></Field>
              </section>
              <aside className="node-detail-card">
                <div className="node-detail-card-heading"><GitBranch size={16} /><h2>节点属性</h2></div>
                <Field label="节点类型">
                  {diagram.type === "flow" ? (
                    <select value={flowTypeOf(draft)} onChange={(event) => {
                      const flowType = event.target.value as DiagramFlowNodeType;
                      const meta = FLOW_NODE_META[flowType];
                      setSaved("");
                      setDraft((current) => current ? { ...current, flowType, kind: meta.kind, shape: meta.shape } : current);
                    }}>
                      {DIAGRAM_FLOW_NODE_TYPES.map((type) => <option key={type} value={type}>{FLOW_NODE_META[type].label}</option>)}
                    </select>
                  ) : (
                    <select value={draft.kind} onChange={(event) => updateDraft("kind", event.target.value as DiagramNodeKind)}>
                      {DIAGRAM_NODE_KINDS.map((kind) => <option key={kind} value={kind}>{NODE_KIND_LABELS[kind]}</option>)}
                    </select>
                  )}
                </Field>
                <Field label="负责人"><input type="text" value={draft.owner ?? ""} placeholder="姓名或团队" onChange={(event) => updateDraft("owner", event.target.value)} /></Field>
                <div className="node-detail-readonly">
                  <span>节点 ID</span><code>{draft.id}</code>
                  <span>所属画布</span><strong>{diagram.title}</strong>
                  <span>所属项目</span><strong>{project?.name ?? diagram.projectId}</strong>
                </div>
              </aside>
            </div>

            <section className="node-detail-card node-detail-docs-card">
              <div className="node-detail-doc-header">
                <div>
                  <div className="node-detail-card-heading"><BookOpen size={16} /><h2>功能文档与需求绑定</h2></div>
                  <p>需求、接口、测试与验收资料统一绑定到当前节点；需求文档是进入详设与开发的前提。</p>
                </div>
                <div className="node-detail-doc-actions">
                  <button className="btn btn-ghost" onClick={() => setDocumentEditor({ category: "需求文档" })}><Plus size={14} /> 新建需求文档</button>
                  <button className="btn btn-primary" onClick={() => setDocumentEditor({})}><Plus size={14} /> 新建文档</button>
                </div>
              </div>

              {requirementDoc ? (
                <article className="node-requirement-doc">
                  <span className="node-requirement-doc-mark">需求</span>
                  <div className="node-requirement-doc-main">
                    <strong>{requirementDoc.title}</strong>
                    <span>{requirementDoc.summary || "暂无摘要"}</span>
                  </div>
                  <Badge tone={DOC_STATUS_TONE[requirementDoc.status]}>{requirementDoc.status}</Badge>
                  <button className="btn btn-sm" onClick={() => setDocumentEditor({ doc: requirementDoc, category: requirementDoc.category })}><Pencil size={13} /> 查看</button>
                </article>
              ) : (
                <article className="node-requirement-doc empty">
                  <span className="node-requirement-doc-mark">需求</span>
                  <div className="node-requirement-doc-main">
                    <strong>尚未绑定需求文档</strong>
                    <span>点击右上角「新建需求文档」，把需求说明绑定到该节点。</span>
                  </div>
                  <button className="btn btn-sm btn-primary" onClick={() => setDocumentEditor({ category: "需求文档" })}><Plus size={13} /> 新建需求文档</button>
                </article>
              )}

              <div className="node-document-grid">
                {otherDocs.length === 0 ? (
                  <EmptyState text={documents.length === 0 ? "当前节点还没有文档，创建第一份需求文档吧。" : "暂无其他类别的文档。"} />
                ) : otherDocs.map((doc) => (
                  <article className="node-document-card" key={doc.id}>
                    <div className="node-document-card-top">
                      <span className="node-document-category">{doc.category}</span>
                      <Badge tone={DOC_STATUS_TONE[doc.status]}>{doc.status}</Badge>
                    </div>
                    <h3>{doc.title}</h3>
                    <p>{doc.summary || doc.content.slice(0, 120) || "暂无摘要"}</p>
                    <div className="node-document-meta">
                      <span>{doc.version || "v0.1"}</span>
                      <span>{doc.author || "未署名"}</span>
                      <span>{formatDateTime(doc.updatedAt)}</span>
                    </div>
                    <div className="node-document-actions">
                      {isExternalUrl(doc.sourceUrl) ? <a className="btn btn-ghost btn-sm" href={doc.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> 附件链接</a> : <span />}
                      <button className="btn btn-ghost btn-sm" onClick={() => setDocumentEditor({ doc, category: doc.category })}><Pencil size={13} /> 查看与编辑</button>
                    </div>
                  </article>
                ))}
              </div>

              {documents.length > 0 ? <div className="node-detail-doc-foot"><button className="btn btn-ghost btn-sm" onClick={() => selectTab("documents")}>查看全部文档资料（{documents.length}）→</button></div> : null}
            </section>
          </>
        ) : null}

        {deliveryTracked && activeTab === "development" ? (
          <>
            <section className="node-detail-card development-overview-card">
              <div className="node-detail-card-heading development-overview-heading"><Activity size={16} /><h2>开发总览</h2></div>
              <div className="development-overview-row">
                <div className="development-progress-ring" style={{ "--plan-progress": `${planProgress * 3.6}deg` } as CSSProperties}>
                  <strong>{planProgress}%</strong><span>总体进度</span>
                </div>
                <div className="development-focus-card current">
                  <span>当前开发到哪</span>
                  <strong>{currentPlan?.title ?? (allPlansCompleted ? "全部开发动作已完成" : "尚未开始开发")}</strong>
                  <p>{currentPlan?.description ? planSummaryText(currentPlan.description) : (currentPlan?.status === "已阻塞" ? currentPlan.blockedReason : "开始一个开发动作后在这里显示当前进展")}</p>
                  {currentPlan ? <div><Badge tone={currentPlan.status === "已阻塞" ? "bad" : "warn"}>{currentPlan.status}</Badge><span>{currentPlan.progress}%</span></div> : null}
                </div>
                <div className="development-focus-card next">
                  <span>下一步计划</span>
                  <strong>{nextPlan?.title ?? (allPlansCompleted ? "进入待验收" : "尚未安排下一步")}</strong>
                  <p>{nextPlan?.description ? planSummaryText(nextPlan.description) : (nextPlan?.dueAt ? `计划截止 ${nextPlan.dueAt}` : "新增或调整未开始的计划动作")}</p>
                  {nextPlan ? <div><Badge tone="muted">{nextPlan.priority}</Badge><span>{nextPlan.owner || "未指定负责人"}</span></div> : null}
                </div>
              </div>
              {nodeLayer ? (
                <div className="development-gate-strip">
                  <div className="development-gate-title">
                    <span>节点门禁</span>
                    <strong>{nodeLayer.missing.length === 0 ? "全部门禁条件已满足" : `尚缺 ${nodeLayer.missing.length} 项`}</strong>
                  </div>
                  <div className="development-gate-items">
                    {nodeLayer.missing.length === 0
                      ? <span className="development-gate-ok">全部门禁条件已满足，可推进交付</span>
                      : nodeLayer.missing.map((item) => <span key={item} className="development-gate-chip">{item}</span>)}
                  </div>
                  {nodeLayer.nextAction ? (
                    <button
                      className="btn btn-primary btn-sm"
                      title={nodeLayer.nextAction.description}
                      onClick={() => (nodeLayer.nextAction && nodeLayer.nextAction.entityType === "plan" && nodeLayer.nextAction.entityId)
                        ? selectPlan(nodeLayer.nextAction.entityId)
                        : nodeLayer.nextAction && navigate(nodeLayer.nextAction.href)}
                    >
                      <ArrowRight size={13} /> 定位{nodeLayer.nextAction.entityType === "plan" ? "施工单" : "下一步"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>

            <div className="node-detail-grid development-workspace-grid">
            <section className="node-detail-card development-plan-card">
              <div className="development-plan-header">
                <div>
                  <div className="node-detail-card-heading"><ListChecks size={16} /><h2>开发计划与动作</h2></div>
                  <p>计划与项目管理共用同一数据源，节点只负责展示和执行。</p>
                </div>
                <button className="btn btn-primary" onClick={() => setPlanEditor({})}><Plus size={14} /> 新增开发动作</button>
              </div>
              {plans.length === 0 ? <EmptyState text="还没有开发计划。新增动作后，系统会显示当前进展和下一步。" /> : (
                <div className="development-plan-list-scroll">
                  <div className="development-plan-list">
                    {[...plans].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((plan, index) => (
                    <article className={`development-plan-item status-${plan.status}${selectedPlan?.id === plan.id ? " selected" : ""}`} key={plan.id}>
                      <div className="development-plan-seq">{String(index + 1).padStart(2, "0")}</div>
                      <div className="development-plan-main">
                        <div className="development-plan-title">
                          <strong title={plan.title}>{plan.title}</strong>
                          <div className="development-plan-actions">
                            <button className="btn btn-primary btn-sm" onClick={() => selectPlan(plan.id)}>打开施工单</button>
                            <button className="btn btn-ghost btn-icon" title="编辑计划" onClick={() => setPlanEditor({ plan })}><Pencil size={13} /></button>
                            <button className="btn btn-ghost btn-icon btn-danger" title="删除计划" onClick={() => {
                              if (window.confirm(`确认删除开发动作「${plan.title}」？`)) {
                                setPlanBusyId(plan.id);
                                api.deletePlan(plan.id).then(() => loadPlans(diagram.projectId)).catch((reason) => setError(reason.message)).finally(() => setPlanBusyId(""));
                              }
                            }}><Trash2 size={13} /></button>
                          </div>
                        </div>
                        <div className="development-plan-badges">
                          <Badge tone={plan.status === "已完成" ? "good" : plan.status === "已阻塞" ? "bad" : plan.status === "进行中" ? "warn" : "muted"}>{plan.status}</Badge>
                          <Badge tone={plan.lifecycleStatus === "accepted" ? "good" : plan.lifecycleStatus === "audit_failed" ? "bad" : plan.lifecycleStatus === "in_progress" ? "info" : "neutral"}>{PLAN_LIFECYCLE_LABELS[plan.lifecycleStatus]}</Badge>
                          {layerByPlanId.get(plan.id) ? <Badge tone={layerByPlanId.get(plan.id)?.locked ? "muted" : "info"}>第 {layerByPlanId.get(plan.id)?.layer} 层{layerByPlanId.get(plan.id)?.locked ? " · 未解锁" : ""}</Badge> : null}
                          <div className="development-plan-rail">
                            <span className="development-plan-percent">{plan.progress}%</span>
                            <div className="development-plan-progress"><span style={{ width: `${plan.progress}%` }} /></div>
                          </div>
                        </div>
                        {plan.description ? <p title={plan.description}>{planSummaryText(plan.description)}</p> : null}
                        {plan.blockedReason ? <div className="development-blocked-reason">阻塞：{plan.blockedReason}</div> : null}
                        {layerByPlanId.get(plan.id)?.locked ? <div className="development-blocked-reason">层级门禁：{layerByPlanId.get(plan.id)?.lockReason}</div> : null}
                        <div className="development-plan-meta">
                          <span>{plan.owner || "未指定负责人"}</span><span>{plan.dueAt ? `截止 ${plan.dueAt}` : "未设截止日期"}</span>
                          {plan.completedAt ? <span>完成于 {formatDateTime(plan.completedAt)}</span> : null}
                        </div>
                      </div>
                    </article>
                  ))}
                  </div>
                </div>
              )}
            </section>

            <aside className="node-detail-card development-delivery-card">
              {selectedPlan ? (
                <PlanDeliveryPanel
                  projectId={diagram.projectId}
                  plan={selectedPlan}
                  evidence={evidence}
                  onChanged={async () => {
                    await Promise.all([loadPlans(diagram.projectId), loadEvidence(diagram.projectId)]);
                    const nextDiagram = await api.getDiagram(diagram.id);
                    setDiagram(nextDiagram);
                    setDraft(nextDiagram.nodes.find((node) => node.id === draft.id) ?? draft);
                  }}
                  onAddEvidence={() => setEvidenceEditor({ plan: selectedPlan })}
                  onError={setError}
                />
              ) : (
                <EmptyState text="从左侧选择一个开发计划，打开对应施工单。" />
              )}
            </aside>
            </div>
          </>
        ) : null}

        {deliveryTracked && activeTab === "delivery" ? (
          <div className="node-detail-grid">
            <section className="node-detail-card">
              <div className="node-detail-card-heading"><CheckCircle2 size={16} /><h2>交付状态</h2></div>
              <div className="delivery-status-grid">
                <Field label="需求状态">
                  <select value={requirementStatus} onChange={(event) => updateDraft("requirementStatus", event.target.value as RequirementStatus)}>
                    {REQUIREMENT_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                </Field>
                <Field label="设计状态">
                  <select value={designStatus} onChange={(event) => updateDraft("designStatus", event.target.value as DesignStatus)}>
                    {DESIGN_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                </Field>
              </div>
              <div className="delivery-derived-status">
                <span>开发状态</span><Badge tone={DEVELOPMENT_TONE[developmentStatus]}>{developmentStatus}</Badge>
                <small>由开发计划的正式施工状态自动汇总，不允许手工修改。</small>
              </div>
              <div className="delivery-derived-status">
                <span>验收状态</span><Badge tone={ACCEPTANCE_TONE[acceptanceStatus]}>{acceptanceStatus}</Badge>
                <small>全部施工计划经独立审计并由主 Agent 批准后自动通过。</small>
              </div>
              <label className="workflow-checkbox">
                <input type="checkbox" checked={draft.requiresDatabase ?? draft.kind === "data"} disabled={draft.kind === "data"} onChange={(event) => updateDraft("requiresDatabase", event.target.checked)} />
                <span><strong>该节点需要数据库</strong><small>进入开发前必须关联数据库模型和具体表；数据节点默认必选。</small></span>
              </label>
              <Field label="阻塞原因"><textarea value={draft.blockedReason ?? ""} placeholder="仅在阻塞时填写" onChange={(event) => updateDraft("blockedReason", event.target.value)} /></Field>
              <Field label="验收标准"><textarea rows={8} value={draft.acceptanceCriteria ?? ""} placeholder="逐条写清楚什么结果才算完成" onChange={(event) => updateDraft("acceptanceCriteria", event.target.value)} /></Field>
            </section>
            <section className="node-detail-card">
              <div className="node-detail-card-heading node-detail-card-heading-actions">
                <div><BookOpen size={16} /><h2>验收证据</h2></div>
                <button className="btn btn-ghost btn-sm" onClick={() => setEvidenceEditor({})}><Plus size={13} /> 添加节点证据</button>
              </div>
              {evidence.length === 0 ? <EmptyState text="还没有关联该节点的证据" /> : (
                <div className="node-detail-evidence-list">
                  {evidence.map((item) => {
                    const changeId = typeof item.details.changeId === "string"
                      ? item.details.changeId
                      : item.revokedReason.match(/设计变更\s+([^\s]+)/)?.[1] ?? "";
                    return <div className="node-detail-evidence" key={item.id}>
                      <div className="node-detail-evidence-head">
                        <div><Badge tone={item.resultStatus === "pass" ? "good" : item.resultStatus === "fail" ? "bad" : item.resultStatus === "warn" ? "warn" : "neutral"}>{item.resultStatus}</Badge> <Badge tone="neutral">{item.sourceType}</Badge> <Badge tone={item.status === "active" ? "good" : item.status === "revoked" ? "bad" : "warn"}>{item.status}</Badge></div>
                        <button className="btn btn-ghost btn-icon btn-danger" title="删除证据" onClick={() => {
                          if (!window.confirm(`确认删除证据“${item.summary}”？`)) return;
                          api.deleteEvidence(item.id).then(() => loadEvidence(diagram.projectId)).catch((reason) => setError(reason instanceof Error ? reason.message : "证据删除失败"));
                        }}><Trash2 size={13} /></button>
                      </div>
                      <strong>{item.summary}</strong>
                      {item.sourcePath ? isExternalUrl(item.sourcePath)
                        ? <a href={item.sourcePath} target="_blank" rel="noreferrer"><ExternalLink size={12} /> {item.sourcePath}</a>
                        : <code>{item.sourcePath}</code> : null}
                      {item.command ? <code>{item.command}</code> : null}
                      <small>{formatDateTime(item.collectedAt)}{typeof item.details.note === "string" && item.details.note ? ` · ${item.details.note}` : ""}</small>
                      {item.status === "revoked" ? <small>撤销原因：{item.revokedReason || "未记录"}{changeId ? ` · 变更 ${changeId}` : ""}{item.revokedAt ? ` · ${formatDateTime(item.revokedAt)}` : ""}</small> : null}
                    </div>
                  } )}
                </div>
              )}
            </section>
          </div>
        ) : null}

        {activeTab === "documents" ? (
          <DocumentReferencePanel
            key={documents.map((document) => document.currentRevisionId).join(":")}
            projectId={diagram.projectId}
            targetType="diagramNode"
            targetId={draft.id}
            relationType="defines"
            title="节点引用文档"
            description="文档属于项目系统；当前节点只引用需求、接口、测试或验收文档的固定版本。"
            createActions={<><button className="btn btn-ghost" onClick={() => setDocumentEditor({ category: "需求文档" })}><Plus size={14} /> 新建需求文档</button><button className="btn" onClick={() => setDocumentEditor({})}><Plus size={14} /> 新建文档</button></>}
            onEdit={(doc) => setDocumentEditor({ doc })}
            onLoaded={(nextDocuments) => setDocuments(nextDocuments)}
          />
        ) : null}

        {activeTab === "relations" ? (
          <div className="node-relations-layout">
            <section className="node-detail-card">
              <div className="node-detail-card-heading"><GitBranch size={16} /><h2>上下游关系</h2></div>
              {(draft.linkDiagramIds ?? []).length > 0 ? (
                <div className="node-subcanvas-links">
                  {(draft.linkDiagramIds ?? []).map((id) => (
                    <button key={id} className="node-subcanvas-link" onClick={() => navigate(`#/canvas/${id}`)}>
                      <span>关联子画布</span><strong>打开子画布</strong><ExternalLink size={14} />
                    </button>
                  ))}
                </div>
              ) : null}
              {relations.length === 0 ? <EmptyState text="当前节点还没有连线关系" /> : (
                <div className="node-relation-list">
                  {relations.map(({ edge, outgoing, peer }) => (
                    <button key={edge.id} onClick={() => peer && navigate(`#/canvas/${diagram.id}/node/${peer.id}`)} disabled={!peer}>
                      <span className={outgoing ? "relation-out" : "relation-in"}>{outgoing ? "输出到" : "输入自"}</span>
                      <strong>{peer?.label ?? "节点已删除"}</strong>
                      <span>{edge.label || "未命名关系"}</span>
                      <ExternalLink size={13} />
                    </button>
                  ))}
                </div>
              )}
            </section>

            {diagram.type !== "flow" ? <section className="node-detail-card node-database-card">
              <div className="node-database-heading">
                <div>
                  <div className="node-detail-card-heading"><Database size={16} /><h2>数据库表关联</h2></div>
                  <p>记录该功能实际读写的物理表，并可直接回到 ER 图定位。</p>
                </div>
                <button className="btn btn-primary btn-sm" disabled={databaseModels.length === 0} onClick={() => setDatabaseBindingEditor({})}><Plus size={13} /> 关联数据表</button>
              </div>
              {databaseModels.length === 0 && databaseBindings.length === 0 ? (
                <div className="node-database-empty">
                  <EmptyState text="当前项目还没有数据库模型" />
                  <button className="btn btn-sm" onClick={() => navigate("#/canvas?view=database")}><Database size={13} /> 前往数据库设计</button>
                </div>
              ) : databaseBindings.length === 0 ? <EmptyState text="当前节点还没有关联数据库表" /> : (
                <div className="node-database-list">
                  {databaseModels.length === 0 ? <div className="node-database-stale-notice">原数据库模型已删除，请解除失效关联或先新建模型后重新绑定。</div> : null}
                  {databaseBindings.map((binding) => {
                    const model = databaseModelById.get(binding.databaseModelId);
                    const table = model?.tables.find((item) => item.name.toLocaleLowerCase() === binding.tableName.toLocaleLowerCase());
                    const stale = !model || !table;
                    const qualifiedName = binding.schemaName ? `${binding.schemaName}.${binding.tableName}` : binding.tableName;
                    return (
                      <article className={`node-database-binding ${stale ? "stale" : ""}`} key={binding.id}>
                        <div className="node-database-binding-main">
                          <span className="node-database-table-icon"><Table2 size={17} /></span>
                          <div><strong>{qualifiedName}</strong><span>{model?.name ?? "数据库模型已删除"}</span></div>
                          {stale ? <Badge tone="bad">关联已失效</Badge> : <Badge tone="good">关联有效</Badge>}
                        </div>
                        <div className="node-database-operations">
                          {binding.operations.map((operation) => <span key={operation}>{DATABASE_OPERATION_LABEL[operation]}</span>)}
                        </div>
                        <p>{binding.purpose || "未填写使用说明"}</p>
                        <div className="node-database-actions">
                          {!stale ? <button className="btn btn-ghost btn-sm" onClick={() => navigate(`#/canvas/database/${binding.databaseModelId}?table=${encodeURIComponent(binding.tableName)}`)}><ExternalLink size={13} /> 在 ER 图中打开</button> : <span />}
                          <button className="btn btn-ghost btn-sm" onClick={() => setDatabaseBindingEditor({ binding })}><Pencil size={13} /> 编辑</button>
                          <button className="btn btn-ghost btn-sm btn-danger" onClick={() => {
                            if (!window.confirm(`确认解除与数据表「${qualifiedName}」的关联？`)) return;
                            api.deleteNodeDatabaseBinding(binding.id)
                              .then(loadDatabaseBindings)
                              .catch((reason) => setError(reason instanceof Error ? reason.message : "解除关联失败"));
                          }}><Trash2 size={13} /> 解除</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section> : null}
          </div>
        ) : null}
      </div>

      {documentEditor ? (
        <NodeDocumentModal
          projectId={diagram.projectId}
          nodeId={draft.id}
          doc={documentEditor.doc}
          initialCategory={documentEditor.category}
          onClose={() => setDocumentEditor(null)}
          onSaved={() => {
            setDocumentEditor(null);
            void loadDocuments(diagram.projectId).catch((reason) => setError(reason instanceof Error ? reason.message : "文档刷新失败"));
          }}
        />
      ) : null}
      {planEditor ? (
        <NodePlanModal projectId={diagram.projectId} diagramId={diagram.id} nodeId={draft.id} plan={planEditor.plan}
          onClose={() => setPlanEditor(null)} onSaved={() => {
            setPlanEditor(null);
            void loadPlans(diagram.projectId).catch((reason) => setError(reason instanceof Error ? reason.message : "计划刷新失败"));
          }} />
      ) : null}
      {databaseBindingEditor ? (
        <NodeDatabaseBindingModal
          projectId={diagram.projectId}
          diagramId={diagram.id}
          nodeId={draft.id}
          models={databaseModels}
          binding={databaseBindingEditor.binding}
          onClose={() => setDatabaseBindingEditor(null)}
          onSaved={() => {
            setDatabaseBindingEditor(null);
            void loadDatabaseBindings().catch((reason) => setError(reason instanceof Error ? reason.message : "数据库表关联刷新失败"));
          }}
        />
      ) : null}
      {evidenceEditor ? (
        <NodeEvidenceModal projectId={diagram.projectId} nodeId={draft.id} plan={evidenceEditor.plan} onClose={() => setEvidenceEditor(null)} onSaved={() => {
          setEvidenceEditor(null);
          void loadEvidence(diagram.projectId).catch((reason) => setError(reason instanceof Error ? reason.message : "证据刷新失败"));
        }} />
      ) : null}
      {designChangeOpen ? <DesignChangeModal
        projectId={diagram.projectId}
        diagram={diagram}
        node={draft}
        documents={documents}
        plans={plans.filter((plan) => plan.kind === "task")}
        evidence={evidence}
        onClose={() => setDesignChangeOpen(false)}
        onSaved={async (result) => {
          setDesignChangeOpen(false);
          const [nextDiagram, nextWorkflow] = await Promise.all([
            api.getDiagram(diagram.id),
            api.getProjectWorkflow(diagram.projectId),
            loadDocuments(diagram.projectId),
            loadPlans(diagram.projectId),
            loadEvidence(diagram.projectId),
          ]);
          setDiagram(nextDiagram);
          setDraft(nextDiagram.nodes.find((node) => node.id === draft.id) ?? draft);
          setWorkflow(nextWorkflow);
          selectTab("documents");
          setSaved(`设计变更 ${result.changeId} 已建立；下一步：${result.nextAction?.title ?? "修订文档与计划"}`);
        }}
      /> : null}
    </div>
  );
}

function DesignChangeModal(props: {
  projectId: string;
  diagram: Diagram;
  node: DiagramNode;
  documents: DesignDoc[];
  plans: PlanItem[];
  evidence: Evidence[];
  onClose: () => void;
  onSaved: (result: DesignChangeResult) => Promise<void> | void;
}): ReactElement {
  const [form, setForm] = useState({
    reason: "",
    changeSummary: "",
    requirementImpact: false,
    impactedDocumentIds: props.documents.map((document) => document.id),
    impactedPlanIds: props.plans.map((plan) => plan.id),
    reusableWorkSummary: "",
    reworkScope: "",
    apiImpact: "",
    databaseImpact: "",
    deploymentImpact: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const idempotencyKey = useRef(crypto.randomUUID());
  const toggle = (field: "impactedDocumentIds" | "impactedPlanIds", id: string) => {
    setForm((current) => ({
      ...current,
      [field]: current[field].includes(id) ? current[field].filter((item) => item !== id) : [...current[field], id],
    }));
  };
  const impactedEvidence = props.evidence.filter((item) => item.status === "active"
    && ((item.planItemId && form.impactedPlanIds.includes(item.planItemId))
      || props.documents.some((document) => form.impactedDocumentIds.includes(document.id)
        && item.documentRevisionId === document.currentRevisionId)));
  const valid = form.reason.trim() && form.changeSummary.trim() && form.reworkScope.trim()
    && form.impactedDocumentIds.length > 0 && form.impactedPlanIds.length > 0;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.requestDesignChange(props.projectId, {
        diagramId: props.diagram.id,
        nodeId: props.node.id,
        actor: "当前用户（节点详情）",
        ...form,
        reusableEvidenceIds: [],
        expectedUpdatedAt: props.diagram.updatedAt,
        idempotencyKey: idempotencyKey.current,
        clientId: "node-detail-view",
      });
      await props.onSaved(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发起设计变更失败");
    } finally { setBusy(false); }
  };
  return <Modal
    title={`发起设计变更 · ${props.node.label}`}
    onClose={props.onClose}
    width={900}
    footer={<>
      <button className="btn" disabled={busy} onClick={props.onClose}>取消</button>
      <button className="btn btn-danger" disabled={busy || !valid} onClick={() => void submit()}>
        <TriangleAlert size={14} /> {busy ? "提交中…" : "确认冻结并进入返工"}
      </button>
    </>}
  >
    {error ? <ErrorBanner message={error} /> : null}
    <div className="design-change-form">
      <section>
        <h3>1. 问题说明</h3>
        <div className="form-grid">
          <Field label="错误原因" wide><textarea rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="说明错误在哪里、如何发现以及为什么必须返工" /></Field>
          <Field label="变更摘要" wide><textarea rows={3} value={form.changeSummary} onChange={(event) => setForm({ ...form, changeSummary: event.target.value })} placeholder="说明新设计要改变什么" /></Field>
          <label className="field field-wide design-change-check"><input type="checkbox" checked={form.requirementImpact} onChange={(event) => setForm({ ...form, requirementImpact: event.target.checked })} /><span>影响业务需求或验收标准（需求将退回待评审）</span></label>
        </div>
      </section>
      <section>
        <h3>2. 影响范围</h3>
        <div className="design-change-picker-grid">
          <div><strong>受影响文档</strong>{props.documents.map((document) => <label key={document.id}><input type="checkbox" checked={form.impactedDocumentIds.includes(document.id)} onChange={() => toggle("impactedDocumentIds", document.id)} /><span>{document.title} · {document.version} · {document.status}</span></label>)}</div>
          <div><strong>受影响计划</strong>{props.plans.map((plan) => <label key={plan.id}><input type="checkbox" checked={form.impactedPlanIds.includes(plan.id)} onChange={() => toggle("impactedPlanIds", plan.id)} /><span>{plan.title} · {PLAN_LIFECYCLE_LABELS[plan.lifecycleStatus]}</span></label>)}</div>
        </div>
        <div className="form-grid">
          <Field label="可保留工作" wide><textarea rows={2} value={form.reusableWorkSummary} onChange={(event) => setForm({ ...form, reusableWorkSummary: event.target.value })} placeholder="说明已完成工作中仍可复用的部分；证据默认不复用" /></Field>
          <Field label="必须返工范围" wide><textarea rows={3} value={form.reworkScope} onChange={(event) => setForm({ ...form, reworkScope: event.target.value })} /></Field>
          <Field label="API 影响"><textarea rows={2} value={form.apiImpact} onChange={(event) => setForm({ ...form, apiImpact: event.target.value })} /></Field>
          <Field label="数据库影响"><textarea rows={2} value={form.databaseImpact} onChange={(event) => setForm({ ...form, databaseImpact: event.target.value })} /></Field>
          <Field label="部署与兼容性影响" wide><textarea rows={2} value={form.deploymentImpact} onChange={(event) => setForm({ ...form, deploymentImpact: event.target.value })} /></Field>
        </div>
      </section>
      <section className="design-change-impact-preview">
        <h3>3. 影响预览</h3>
        <ul>
          <li>节点设计退回“进行中”{form.requirementImpact ? "，需求退回“待评审”" : "，已批准需求保持不变"}。</li>
          <li>{form.impactedDocumentIds.length} 份文档建立“评审中”不可变新版本；旧引用保持原版本并显示待刷新。</li>
          <li>{form.impactedPlanIds.length} 个计划失去旧批准并进入返工；已验收计划保留原记录并创建新返工计划。</li>
          <li>{impactedEvidence.length} 条当前证据将保留历史记录但标记失效。</li>
          <li>关联计划的 claimed/running Agent 租约将释放，旧 token 后续写入会被拒绝。</li>
        </ul>
      </section>
    </div>
  </Modal>;
}

function NodeEvidenceModal(props: { projectId: string; nodeId: string; plan?: PlanItem; onClose: () => void; onSaved: () => void }): ReactElement {
  const initialRole: PlanAgentRole = props.plan?.lifecycleStatus === "pending_audit" ? "auditor" : "builder";
  const initialAssignment = props.plan?.roleAssignments[initialRole];
  const [form, setForm] = useState({
    sourceType: "manual" as Evidence["sourceType"],
    resultStatus: "pass" as Evidence["resultStatus"],
    summary: "",
    sourcePath: "",
    command: "",
    kind: "测试报告",
    note: "",
    actorRole: initialRole as PlanAgentRole,
    agentId: initialAssignment?.agentId ?? "",
    actor: initialAssignment?.displayName || initialAssignment?.agentId || "",
    acceptanceCriterionKey: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = () => {
    if (busy || !form.summary.trim()) return;
    setBusy(true);
    setError("");
    api.createManualEvidence({
      projectId: props.projectId,
      nodeId: props.nodeId,
      sourceType: form.sourceType,
      resultStatus: form.resultStatus,
      summary: form.summary.trim(),
      sourcePath: form.sourcePath.trim(),
      command: form.command.trim(),
      commitSha: "",
      details: { kind: form.kind, note: form.note.trim() },
      planItemId: props.plan?.id ?? null,
      correlationId: props.plan?.correlationId || props.plan?.id,
      actor: form.actor.trim() || undefined,
      actorRole: props.plan ? form.actorRole : null,
      agentId: props.plan ? form.agentId.trim() : "",
      acceptanceCriterionKey: form.acceptanceCriterionKey.trim(),
    }).then(props.onSaved).catch((reason) => setError(reason instanceof Error ? reason.message : "证据保存失败")).finally(() => setBusy(false));
  };
  return (
    <Modal title={props.plan ? `添加施工记录 / 证据 · ${props.plan.title}` : "添加节点验收证据"} onClose={props.onClose} width={680}
      footer={<><button className="btn" onClick={props.onClose}>取消</button><button className="btn btn-primary" disabled={busy || !form.summary.trim()} onClick={submit}>{busy ? "保存中…" : "保存证据"}</button></>}
    >
      {error ? <ErrorBanner message={error} /> : null}
      <div className="form-grid">
        <Field label="证据类型"><select value={form.kind} onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value }))}>{["截图", "视频", "接口响应", "测试报告", "文件", "链接"].map((kind) => <option key={kind}>{kind}</option>)}</select></Field>
        <Field label="验证结果"><select value={form.resultStatus} onChange={(event) => setForm((current) => ({ ...current, resultStatus: event.target.value as Evidence["resultStatus"] }))}><option value="pass">通过</option><option value="warn">警告</option><option value="fail">失败</option><option value="info">信息</option></select></Field>
        <Field label="证据名称" wide><input autoFocus value={form.summary} placeholder="例如：登录接口 Playwright 回归通过" onChange={(event) => setForm((current) => ({ ...current, summary: event.target.value }))} /></Field>
        <Field label="链接或文件路径" wide><input value={form.sourcePath} placeholder="https://… 或测试报告路径" onChange={(event) => setForm((current) => ({ ...current, sourcePath: event.target.value }))} /></Field>
        <Field label="执行命令" wide><input value={form.command} placeholder="例如 npm test" onChange={(event) => setForm((current) => ({ ...current, command: event.target.value }))} /></Field>
        {props.plan ? <>
          <Field label="证据角色"><select value={form.actorRole} onChange={(event) => {
            const actorRole = event.target.value as PlanAgentRole;
            const assignment = props.plan!.roleAssignments[actorRole];
            setForm((current) => ({ ...current, actorRole, agentId: assignment.agentId, actor: assignment.displayName || assignment.agentId }));
          }}><option value="designer">设计者</option><option value="builder">施工者</option><option value="auditor">审计者</option></select></Field>
          <Field label="受派 Agent ID"><input readOnly value={form.agentId} placeholder="先在计划中分配角色" /></Field>
          <Field label="记录人"><input value={form.actor} placeholder="实际记录人显示名称" onChange={(event) => setForm((current) => ({ ...current, actor: event.target.value }))} /></Field>
          <Field label="验收条款"><input value={form.acceptanceCriterionKey} placeholder="例如 AC-01" onChange={(event) => setForm((current) => ({ ...current, acceptanceCriterionKey: event.target.value }))} /></Field>
        </> : null}
        <Field label="说明" wide><textarea rows={4} value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} /></Field>
      </div>
    </Modal>
  );
}

function NodeDatabaseBindingModal(props: {
  projectId: string;
  diagramId: string;
  nodeId: string;
  models: DatabaseModel[];
  binding?: NodeDatabaseBinding;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const existing = props.binding;
  const initialModel = props.models.find((model) => model.id === existing?.databaseModelId) ?? props.models[0];
  const initialTable = initialModel?.tables.find((table) => table.name.toLocaleLowerCase() === existing?.tableName.toLocaleLowerCase()) ?? initialModel?.tables[0];
  const [form, setForm] = useState({
    databaseModelId: initialModel?.id ?? "",
    schemaName: existing?.schemaName ?? "",
    tableName: initialTable?.name ?? "",
    operations: existing?.operations ?? (["read"] as NodeDatabaseOperation[]),
    purpose: existing?.purpose ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedModel = props.models.find((model) => model.id === form.databaseModelId);

  const toggleOperation = (operation: NodeDatabaseOperation) => {
    setForm((current) => ({
      ...current,
      operations: current.operations.includes(operation)
        ? current.operations.filter((item) => item !== operation)
        : [...current.operations, operation],
    }));
  };

  const submit = () => {
    if (busy || !selectedModel || !form.tableName || form.operations.length === 0) return;
    setBusy(true);
    setError("");
    const payload = {
      databaseModelId: form.databaseModelId,
      schemaName: form.schemaName,
      tableName: form.tableName,
      operations: form.operations,
      purpose: form.purpose,
    };
    const call = existing
      ? api.updateNodeDatabaseBinding(existing.id, { ...payload, expectedUpdatedAt: existing.updatedAt })
      : api.createNodeDatabaseBinding({ ...payload, projectId: props.projectId, diagramId: props.diagramId, diagramNodeId: props.nodeId });
    call.then(props.onSaved).catch((reason) => setError(reason instanceof Error ? reason.message : "数据库表关联保存失败")).finally(() => setBusy(false));
  };

  return (
    <Modal title={existing ? "编辑数据库表关联" : "关联数据库表"} onClose={props.onClose} width={660}
      footer={<><button className="btn" onClick={props.onClose}>取消</button><button className="btn btn-primary" disabled={busy || !selectedModel || !form.tableName || form.operations.length === 0} onClick={submit}>{busy ? "保存中…" : "保存关联"}</button></>}
    >
      {error ? <ErrorBanner message={error} /> : null}
      {props.models.length === 0 ? <EmptyState text="当前项目没有可用的数据库模型，请先完成数据库设计。" /> : (
        <div className="form-grid">
          <Field label="数据库模型">
            <select value={form.databaseModelId} onChange={(event) => {
              const model = props.models.find((item) => item.id === event.target.value);
              setForm((current) => ({ ...current, databaseModelId: event.target.value, tableName: model?.tables[0]?.name ?? "" }));
            }}>
              {props.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </Field>
          <Field label="物理表">
            <select value={form.tableName} onChange={(event) => setForm((current) => ({ ...current, tableName: event.target.value }))}>
              {(selectedModel?.tables ?? []).map((table) => <option key={table.name} value={table.name}>{table.displayName ? `${table.name} · ${table.displayName}` : table.name}</option>)}
            </select>
          </Field>
          <Field label="Schema（可选）" wide><input value={form.schemaName} placeholder="例如 public；默认使用模型连接的 schema" onChange={(event) => setForm((current) => ({ ...current, schemaName: event.target.value }))} /></Field>
          <Field label="数据操作" wide>
            <div className="node-database-operation-picker">
              {NODE_DATABASE_OPERATIONS.map((operation) => (
                <label key={operation} className={form.operations.includes(operation) ? "active" : ""}>
                  <input type="checkbox" checked={form.operations.includes(operation)} onChange={() => toggleOperation(operation)} />
                  <span>{DATABASE_OPERATION_LABEL[operation]}</span>
                </label>
              ))}
            </div>
          </Field>
          <Field label="使用说明" wide><textarea rows={5} value={form.purpose} placeholder="说明这个功能为什么读写该表，例如：查询管理员账号并更新最后登录时间" onChange={(event) => setForm((current) => ({ ...current, purpose: event.target.value }))} /></Field>
        </div>
      )}
    </Modal>
  );
}

function NodePlanModal(props: {
  projectId: string;
  diagramId: string;
  nodeId: string;
  plan?: PlanItem;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const existing = props.plan;
  const [form, setForm] = useState({
    title: existing?.title ?? "",
    description: existing?.description ?? "",
    priority: existing?.priority ?? ("P2" as Priority),
    owner: existing?.owner ?? "",
    roleAssignments: normalizeRoleAssignments(existing?.roleAssignments),
    versionTag: existing?.versionTag ?? "",
    startAt: existing?.startAt ?? "",
    dueAt: existing?.dueAt ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const setRole = (role: PlanAgentRole, key: "agentId" | "displayName" | "poolId") => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, roleAssignments: { ...current.roleAssignments, [role]: { ...current.roleAssignments[role], [key]: event.target.value } } }));
  const roleErrors = roleAssignmentErrors(form.roleAssignments, false);

  const submit = () => {
    if (busy || !form.title.trim()) return;
    setBusy(true);
    setError("");
    const payload = { ...form, owner: form.roleAssignments.builder.displayName || form.roleAssignments.builder.agentId || form.owner };
    const call = existing
      ? api.updatePlan(existing.id, payload)
      : api.createPlan({
          ...payload,
          projectId: props.projectId,
          diagramId: props.diagramId,
          diagramNodeId: props.nodeId,
          parentId: null,
          kind: "task",
          dependencyIds: [],
          status: "未开始",
          progress: 0,
          blockedReason: "",
          completedAt: "",
        });
    call.then(props.onSaved).catch((reason) => setError(reason instanceof Error ? reason.message : "计划保存失败")).finally(() => setBusy(false));
  };

  return (
    <Modal title={existing ? `编辑开发动作 · ${existing.title}` : "新增开发动作"} onClose={props.onClose} width={720}
      footer={<><button className="btn" onClick={props.onClose}>取消</button><button className="btn btn-primary" disabled={busy || !form.title.trim() || roleErrors.length > 0} onClick={submit}>{busy ? "保存中…" : "保存计划"}</button></>}
    >
      {error ? <ErrorBanner message={error} /> : null}
      <div className="form-grid">
        <Field label="动作名称" wide><input type="text" value={form.title} placeholder="例如：完成登录接口联调" onChange={set("title")} /></Field>
        <div className="delivery-derived-status"><span>施工状态</span><Badge tone="muted">{existing?.lifecycleStatus ?? "计划草拟"}</Badge><small>保存后通过施工交付控制台提交、批准和执行。</small></div>
        <Field label="优先级"><select value={form.priority} onChange={set("priority")}>{PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}</select></Field>
        <div className="form-section">职责分离</div>
        {(["designer", "builder", "auditor"] as const).map((role) => <div className="field-wide form-grid" key={role}>
          <Field label={`${role === "designer" ? "设计者" : role === "builder" ? "施工者" : "审计者"} Agent ID`}><input type="text" value={form.roleAssignments[role].agentId} onChange={setRole(role, "agentId")} /></Field>
          <Field label="显示名称"><input type="text" value={form.roleAssignments[role].displayName} onChange={setRole(role, "displayName")} /></Field>
          {role === "builder" ? <Field label="Worker 池 ID" wide><input type="text" value={form.roleAssignments[role].poolId ?? ""} onChange={setRole(role, "poolId")} placeholder="可选；为空时自动生成兼容池" /></Field> : null}
        </div>)}
        <div className={`form-note field-wide ${roleErrors.length ? "warn" : ""}`}>{roleErrors.length ? roleErrors.join("；") : `当前施工者：${displayAssignment(form.roleAssignments.builder)}。提交计划前必须补齐三个不同身份。`}</div>
        <Field label="版本"><input type="text" value={form.versionTag} placeholder="如 v1.2" onChange={set("versionTag")} /></Field>
        <Field label="开始日期"><input type="date" value={form.startAt.slice(0, 10)} onChange={set("startAt")} /></Field>
        <Field label="截止日期"><input type="date" value={form.dueAt.slice(0, 10)} onChange={set("dueAt")} /></Field>
        <Field label="开发说明 / 当前做到哪" wide><textarea rows={5} value={form.description} placeholder="说明本动作的目标、当前结果和剩余工作" onChange={set("description")} /></Field>
      </div>
    </Modal>
  );
}

function NodeDocumentModal(props: {
  projectId: string;
  nodeId: string;
  doc?: DesignDoc;
  initialCategory?: DesignDocCategory;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const existing = props.doc;
  const [form, setForm] = useState({
    category: existing?.category ?? props.initialCategory ?? ("需求文档" as DesignDocCategory),
    title: existing?.title ?? "",
    summary: existing?.summary ?? "",
    status: existing?.status ?? ("草拟" as DesignDocStatus),
    version: existing?.version ?? "v0.1",
    author: existing?.author ?? "",
    sourceUrl: existing?.sourceUrl ?? "",
    content: existing?.content ?? "",
  });
  const [preview, setPreview] = useState(Boolean(existing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = () => {
    if (busy || !form.title.trim()) return;
    setBusy(true);
    setError("");
    const call = existing
      ? api.updateDesignDoc(existing.id, form)
      : api.createDesignDoc({
          ...form,
          projectId: props.projectId,
          references: [{ targetType: "diagramNode", targetId: props.nodeId, relationType: "defines" }],
        });
    call.then(props.onSaved).catch((reason) => setError(reason instanceof Error ? reason.message : "文档保存失败")).finally(() => setBusy(false));
  };

  const remove = () => {
    if (!existing || !window.confirm(`确认删除文档「${existing.title}」？`)) return;
    setBusy(true);
    api.deleteDesignDoc(existing.id).then(props.onSaved).catch((reason) => setError(reason instanceof Error ? reason.message : "文档删除失败")).finally(() => setBusy(false));
  };

  return (
    <Modal
      title={existing ? `节点文档 · ${existing.title}` : "新建节点文档"}
      onClose={props.onClose}
      width={820}
      footer={
        <>
          {existing ? <button className="btn btn-danger" disabled={busy} onClick={remove}><Trash2 size={13} /> 删除</button> : null}
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn" onClick={() => setPreview((value) => !value)}>{preview ? "编辑" : "预览"}</button>
          <button className="btn btn-primary" disabled={busy || !form.title.trim()} onClick={submit}>{busy ? "保存中…" : "保存文档"}</button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      {preview ? (
        <div className="node-document-preview">
          <div className="node-document-preview-head">
            <div><span>{form.category}</span><h2>{form.title || "未命名文档"}</h2></div>
            <Badge tone={DOC_STATUS_TONE[form.status]}>{form.status}</Badge>
          </div>
          {form.summary ? <p className="node-document-preview-summary">{form.summary}</p> : null}
          <pre>{form.content || "（暂无正文）"}</pre>
          {isExternalUrl(form.sourceUrl) ? <a className="btn btn-ghost btn-sm" href={form.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> 打开附件或外部文档</a> : null}
        </div>
      ) : (
        <div className="form-grid">
          <Field label="文档类型">
            <select value={form.category} onChange={set("category")}>{DESIGN_DOC_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}</select>
          </Field>
          <Field label="状态">
            <select value={form.status} onChange={set("status")}>{DESIGN_DOC_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select>
          </Field>
          <Field label="标题" wide><input type="text" value={form.title} onChange={set("title")} /></Field>
          <Field label="作者"><input type="text" value={form.author} onChange={set("author")} /></Field>
          <Field label="版本"><input type="text" value={form.version} onChange={set("version")} /></Field>
          <Field label="摘要" wide><input type="text" value={form.summary} onChange={set("summary")} /></Field>
          <Field label="附件或外部文档链接" wide><input type="text" value={form.sourceUrl} placeholder="https://…" onChange={set("sourceUrl")} /></Field>
          <Field label="文档正文（Markdown / 纯文本）" wide><textarea rows={15} value={form.content} onChange={set("content")} /></Field>
        </div>
      )}
    </Modal>
  );
}
