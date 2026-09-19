import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { GripVertical, Search, Shapes } from "lucide-react";
import type { DiagramFlowNodeType, DiagramNodeKind, DiagramType, DiagramUseCaseNodeType, NodeShape } from "../../shared/types";

function ShapeSvg(props: { shape: NodeShape; fill: string; stroke: string }): ReactElement {
  const s = props.stroke, f = props.fill;
  switch (props.shape) {
    case "actor": return <g fill="none" stroke={s} strokeWidth="1.7" strokeLinecap="round"><circle cx="0" cy="-9" r="5" /><line x1="0" y1="-4" x2="0" y2="7" /><line x1="-9" y1="1" x2="9" y2="1" /><line x1="0" y1="7" x2="-8" y2="14" /><line x1="0" y1="7" x2="8" y2="14" /></g>;
    case "boundary": return <rect x="-21" y="-13" width="42" height="26" rx="2" fill="rgba(49,196,219,0.04)" stroke={s} strokeWidth="1.5" strokeDasharray="4 3" />;
    case "ellipse": return <ellipse cx="0" cy="0" rx="19" ry="12" fill={f} stroke={s} strokeWidth="1.5" />;
    case "diamond": return <polygon points="0,-13 20,0 0,13 -20,0" fill={f} stroke={s} strokeWidth="1.5" />;
    case "hexagon": return <polygon points="-13,-11 13,-11 20,0 13,11 -13,11 -20,0" fill={f} stroke={s} strokeWidth="1.5" />;
    case "parallelogram": return <polygon points="-15,-11 21,-11 15,11 -21,11" fill={f} stroke={s} strokeWidth="1.5" />;
    case "cylinder": return <path d="M -19 -4 A 19 8 0 0 1 19 -4 L 19 6 A 19 8 0 0 1 -19 6 Z" fill={f} stroke={s} strokeWidth="1.5" />;
    case "predefined": return <g><rect x="-20" y="-11" width="40" height="22" rx="2" fill={f} stroke={s} strokeWidth="1.5" /><line x1="-14" y1="-11" x2="-14" y2="11" stroke={s} strokeWidth="1.3" /><line x1="14" y1="-11" x2="14" y2="11" stroke={s} strokeWidth="1.3" /></g>;
    case "document": return <path d="M -20 -11 H 20 V 6 C 10 13,-10 1,-20 7 Z" fill={f} stroke={s} strokeWidth="1.5" />;
    case "rect": return <rect x="-20" y="-11" width="40" height="22" rx="3" fill={f} stroke={s} strokeWidth="1.5" />;
    default: return <rect x="-20" y="-11" width="40" height="22" rx="7" fill={f} stroke={s} strokeWidth="1.5" />;
  }
}

interface PaletteEntry {
  label: string;
  kind: DiagramNodeKind;
  shape: NodeShape;
  description: string;
  defaultLabel?: string;
  flowType?: DiagramFlowNodeType;
  useCaseType?: DiagramUseCaseNodeType;
}

const KIND_COLOR: Record<DiagramNodeKind, { fill: string; stroke: string; text: string }> = {
  system: { fill: "rgba(49,196,219,0.16)", stroke: "#31c4db", text: "#d4f8ff" },
  module: { fill: "rgba(77,163,255,0.16)", stroke: "#4da3ff", text: "#cfe4ff" },
  feature: { fill: "rgba(63,185,111,0.16)", stroke: "#3fb96f", text: "#bfe9cf" },
  requirement: { fill: "rgba(226,163,60,0.16)", stroke: "#e2a33c", text: "#f6e2bf" },
  interface: { fill: "rgba(168,120,235,0.16)", stroke: "#a878eb", text: "#e3d4fb" },
  data: { fill: "rgba(86,204,242,0.16)", stroke: "#56ccf2", text: "#cfeffb" },
  note: { fill: "rgba(159,176,191,0.08)", stroke: "#9fb0bf", text: "#cdd8e1" },
};

const CATEGORIES: Array<{ id: string; name: string; description: string; entries: PaletteEntry[] }> = [
  {
    id: "architecture",
    name: "功能架构",
    description: "系统功能与需求结构",
    entries: [
      { label: "系统 / 子系统", kind: "system", shape: "rect", description: "顶层系统边界", defaultLabel: "系统" },
      { label: "模块", kind: "module", shape: "rounded", description: "业务模块" },
      { label: "功能", kind: "feature", shape: "rounded", description: "具体功能能力" },
      { label: "需求", kind: "requirement", shape: "rounded", description: "业务需求" },
      { label: "接口", kind: "interface", shape: "hexagon", description: "系统交互接口" },
      { label: "数据", kind: "data", shape: "cylinder", description: "数据对象或表" },
      { label: "备注", kind: "note", shape: "rect", description: "补充说明" },
    ],
  },
  {
    id: "flow",
    name: "流程图",
    description: "标准流程图符号",
    entries: [
      { label: "开始", kind: "system", shape: "ellipse", flowType: "start", description: "流程起点", defaultLabel: "开始" },
      { label: "结束", kind: "system", shape: "ellipse", flowType: "end", description: "流程终点", defaultLabel: "结束" },
      { label: "处理 / 流程", kind: "feature", shape: "rect", flowType: "process", description: "执行步骤", defaultLabel: "处理" },
      { label: "判断", kind: "requirement", shape: "diamond", flowType: "decision", description: "条件与分支", defaultLabel: "判断条件" },
      { label: "输入 / 输出", kind: "data", shape: "parallelogram", flowType: "input_output", description: "数据输入或输出", defaultLabel: "输入 / 输出" },
      { label: "预定义流程", kind: "interface", shape: "predefined", flowType: "subprocess", description: "复用的子流程", defaultLabel: "子流程" },
      { label: "文档", kind: "note", shape: "document", flowType: "document", description: "文档或报表", defaultLabel: "文档" },
    ],
  },
  {
    id: "usecase",
    name: "用例图",
    description: "UML 参与者与用例",
    entries: [
      { label: "参与者", kind: "interface", shape: "actor", useCaseType: "actor", description: "与系统交互的人或外部系统", defaultLabel: "参与者" },
      { label: "用例", kind: "requirement", shape: "ellipse", useCaseType: "usecase", description: "系统向参与者提供的能力", defaultLabel: "用例" },
      { label: "系统边界", kind: "system", shape: "boundary", useCaseType: "boundary", description: "界定系统范围并容纳用例", defaultLabel: "系统边界" },
    ],
  },
  {
    id: "deployment",
    name: "部署图",
    description: "运行节点与服务关系",
    entries: [
      { label: "设备 / 节点", kind: "system", shape: "rect", description: "服务器或设备" },
      { label: "服务", kind: "feature", shape: "rounded", description: "可部署服务" },
      { label: "组件", kind: "module", shape: "rect", description: "应用组件" },
      { label: "数据存储", kind: "data", shape: "cylinder", description: "数据库或存储" },
      { label: "外部接口", kind: "interface", shape: "hexagon", description: "外部服务连接" },
    ],
  },
];

const CATEGORY_BY_DIAGRAM_TYPE: Record<Exclude<DiagramType, "free" | "main">, string> = {
  functional: "architecture",
  flow: "flow",
  deployment: "deployment",
  usecase: "usecase",
};

function initialCategoryId(type: DiagramType): string {
  return type === "free" || type === "main" ? CATEGORIES[0].id : CATEGORY_BY_DIAGRAM_TYPE[type];
}

export function ShapePalette(props: { diagramType: DiagramType; onInsert: (kind: DiagramNodeKind, shape?: NodeShape, label?: string, flowType?: DiagramFlowNodeType, useCaseType?: DiagramUseCaseNodeType) => void; onHide?: () => void }): ReactElement {
  const [q, setQ] = useState("");
  const [activeCategoryId, setActiveCategoryId] = useState(() => initialCategoryId(props.diagramType));
  const availableCategories = useMemo(() => props.diagramType === "free" || props.diagramType === "main"
    ? CATEGORIES
    : CATEGORIES.filter((category) => category.id === initialCategoryId(props.diagramType)), [props.diagramType]);

  useEffect(() => {
    if (!availableCategories.some((category) => category.id === activeCategoryId)) {
      setActiveCategoryId(availableCategories[0]?.id ?? CATEGORIES[0].id);
    }
    setQ("");
  }, [activeCategoryId, availableCategories]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const categories = kw ? availableCategories : availableCategories.filter((cat) => cat.id === activeCategoryId);
    return categories.map((cat) => ({
      ...cat,
      entries: cat.entries.filter((e) => !kw || `${e.label} ${e.description}`.toLowerCase().includes(kw)),
    })).filter((cat) => cat.entries.length > 0);
  }, [activeCategoryId, availableCategories, q]);

  return (
    <aside className="shape-palette">
      <div className="shape-palette-head">
        <span className="shape-palette-title"><Shapes size={15} />元素库</span>
        <span className="shape-palette-hint">拖拽添加</span>
        {props.onHide ? (
          <button className="shape-palette-hide" title="隐藏元素库" onClick={props.onHide} aria-label="隐藏元素库">×</button>
        ) : null}
      </div>
      <div className="shape-palette-search">
        <Search size={13} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索元素" aria-label="搜索画布元素" />
      </div>
      <div className={`shape-palette-tabs ${availableCategories.length === 1 ? "single" : ""}`} role="tablist" aria-label="元素分类">
        {availableCategories.map((cat) => (
          <button
            key={cat.id}
            className={cat.id === activeCategoryId ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={cat.id === activeCategoryId}
            onClick={() => { setActiveCategoryId(cat.id); setQ(""); }}
          >
            {cat.name}
          </button>
        ))}
      </div>
      <div className="shape-palette-scroll">
        {filtered.map((cat) => (
          <section key={cat.id} className="shape-palette-section">
            <div className="shape-palette-cat">
              <span>{q ? cat.name : cat.description}</span>
              <span>{cat.entries.length} 种</span>
            </div>
            <div className="shape-palette-grid">
              {cat.entries.map((e) => {
                const color = KIND_COLOR[e.kind];
                const insertLabel = e.defaultLabel ?? e.label;
                return (
                  <button
                    key={`${cat.name}-${e.label}`}
                    className="shape-chip"
                    type="button"
                    title={`${e.label} · ${e.description}`}
                    aria-label={`添加${e.label}`}
                    style={{ "--shape-accent": color.stroke } as CSSProperties}
                    draggable
                    onDragStart={(ev) => {
                      ev.dataTransfer.setData("application/json", JSON.stringify({ kind: e.kind, shape: e.shape, label: insertLabel, flowType: e.flowType, useCaseType: e.useCaseType }));
                      ev.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => props.onInsert(e.kind, e.shape, insertLabel, e.flowType, e.useCaseType)}
                  >
                    <span className="shape-chip-preview">
                      <span className="shape-chip-mark">
                        <svg viewBox="-24 -16 48 32" width="42" height="30" aria-hidden="true">
                        <ShapeSvg shape={e.shape} fill={color.fill} stroke={color.stroke} />
                        </svg>
                      </span>
                      <span className="shape-chip-copy">
                        <span className="shape-chip-label">{e.label}</span>
                        <span className="shape-chip-desc">{e.description}</span>
                      </span>
                      <GripVertical className="shape-chip-grip" size={14} aria-hidden="true" />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {filtered.length === 0 ? <p className="shape-palette-empty">无匹配元素</p> : null}
      </div>
    </aside>
  );
}
