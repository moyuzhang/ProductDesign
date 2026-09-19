import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { Briefcase, Check, ChevronDown, Globe2, Search, Star } from "lucide-react";
import type { Project } from "../../shared/types";
import { api } from "../api";

const KEY = "pcs.workspace";
const RECENT_KEY = "pcs.workspace.recents";
const PINNED_KEY = "pcs.workspace.pinned";
const RECENT_LIMIT = 6;
const PROJECT_ACCENTS = ["#56ccf2", "#6fd69a", "#f2c66d", "#f28c6d", "#bd8cf2", "#72a7ff", "#e977a8", "#69d1c5"];

interface WorkspaceContextValue {
  workspace: string;
  projects: Project[];
  projectsLoading: boolean;
  recentIds: string[];
  pinnedIds: string[];
  setWorkspace: (id: string) => void;
  togglePinned: (id: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function readStoredId(): string {
  try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; }
}

function readStoredList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function storeList(key: string, value: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

export function setWorkspaceSelection(id: string): void {
  try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
}

export function stableProjectAccent(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  return PROJECT_ACCENTS[Math.abs(hash) % PROJECT_ACCENTS.length];
}

export function explicitProjectIdFromHash(hash: string): string {
  return decodeURIComponent(hash.match(/^#\/projects\/([^/?]+)/)?.[1] ?? "");
}

function diagramIdFromHash(hash: string): string {
  if (/^#\/canvas\/database\//.test(hash)) return "";
  return decodeURIComponent(hash.match(/^#\/canvas\/([^/?]+)/)?.[1] ?? "");
}

function databaseModelIdFromHash(hash: string): string {
  return decodeURIComponent(hash.match(/^#\/canvas\/database\/([^/?]+)/)?.[1] ?? "");
}

function isWorkspaceCollection(hash: string): boolean {
  return hash.startsWith("#/design") || hash.startsWith("#/orchestration") || /^#\/canvas(?:\?|$)/.test(hash);
}

export function preservesWorkspaceContext(hash: string): boolean {
  return isWorkspaceCollection(hash) || hash.startsWith("#/guide") || hash.startsWith("#/projects");
}

export function projectSwitchTarget(hash: string, projectId: string, mainDiagramId?: string): string {
  if (!projectId) {
    if (hash.startsWith("#/design")) return hash;
    if (hash.startsWith("#/orchestration")) return hash;
    if (/^#\/canvas\/database\//.test(hash)) return "#/canvas?view=database";
    if (/^#\/canvas\//.test(hash)) return "#/canvas";
    if (hash.startsWith("#/canvas")) return hash;
    if (hash.startsWith("#/projects/")) return "#/projects";
    return hash;
  }

  const query = hash.includes("?") ? hash.slice(hash.indexOf("?")) : "";
  if (/^#\/projects\/[^/?]+\/database\//.test(hash)) return `#/projects/${projectId}?tab=database`;
  if (/^#\/projects\/[^/?]+/.test(hash)) return `#/projects/${projectId}${query}`;
  if (/^#\/canvas\/database\//.test(hash)) return "#/canvas?view=database";
  if (/^#\/canvas\/[^/?]+/.test(hash)) return mainDiagramId ? `#/canvas/${mainDiagramId}` : `#/projects/${projectId}`;
  if (isWorkspaceCollection(hash)) return hash;
  return `#/projects/${projectId}`;
}

export function WorkspaceProvider(props: { hash: string; children: ReactNode }): ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [preferred, setPreferred] = useState(readStoredId);
  const [recentIds, setRecentIds] = useState<string[]>(() => readStoredList(RECENT_KEY));
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readStoredList(PINNED_KEY));
  const [resolvedEntity, setResolvedEntity] = useState<{ hash: string; projectId: string }>({ hash: "", projectId: "" });

  useEffect(() => {
    let active = true;
    api.listProjects()
      .then((items) => { if (active) setProjects(items); })
      .catch(() => { if (active) setProjects([]); })
      .finally(() => { if (active) setProjectsLoading(false); });
    return () => { active = false; };
  }, []);

  const remember = useCallback((id: string) => {
    if (!id) return;
    setRecentIds((current) => {
      const next = [id, ...current.filter((item) => item !== id)].slice(0, RECENT_LIMIT);
      storeList(RECENT_KEY, next);
      return next;
    });
  }, []);

  useEffect(() => {
    const explicit = explicitProjectIdFromHash(props.hash);
    if (explicit) {
      setPreferred(explicit);
      setWorkspaceSelection(explicit);
      remember(explicit);
      setResolvedEntity({ hash: props.hash, projectId: explicit });
      return;
    }

    const diagramId = diagramIdFromHash(props.hash);
    const databaseModelId = databaseModelIdFromHash(props.hash);
    if (!diagramId && !databaseModelId) {
      setResolvedEntity({ hash: props.hash, projectId: "" });
      return;
    }

    let active = true;
    setResolvedEntity({ hash: props.hash, projectId: "" });
    const request = diagramId ? api.getDiagram(diagramId) : api.getDatabaseModel(databaseModelId);
    request.then((entity) => {
      if (!active) return;
      setResolvedEntity({ hash: props.hash, projectId: entity.projectId });
      setPreferred(entity.projectId);
      setWorkspaceSelection(entity.projectId);
      remember(entity.projectId);
    }).catch(() => {
      if (active) setResolvedEntity({ hash: props.hash, projectId: "" });
    });
    return () => { active = false; };
  }, [props.hash, remember]);

  useEffect(() => {
    if (projectsLoading || !preferred || explicitProjectIdFromHash(props.hash) || diagramIdFromHash(props.hash) || databaseModelIdFromHash(props.hash)) return;
    if (projects.some((project) => project.id === preferred)) return;
    setPreferred("");
    setWorkspaceSelection("");
  }, [preferred, projects, projectsLoading, props.hash]);

  const explicit = explicitProjectIdFromHash(props.hash);
  const hasEntityRoute = Boolean(diagramIdFromHash(props.hash) || databaseModelIdFromHash(props.hash));
  const workspace = explicit || (hasEntityRoute
    ? (resolvedEntity.hash === props.hash ? resolvedEntity.projectId : "")
    : (preservesWorkspaceContext(props.hash) ? preferred : ""));

  const setWorkspace = useCallback((id: string) => {
    setPreferred(id);
    setWorkspaceSelection(id);
    remember(id);

    const navigateTo = (mainDiagramId?: string) => {
      const target = projectSwitchTarget(props.hash, id, mainDiagramId);
      if (target !== props.hash) window.location.hash = target;
    };

    if (id && /^#\/canvas\/[^/?]+/.test(props.hash) && !/^#\/canvas\/database\//.test(props.hash)) {
      api.getProjectWorkspace(id).then((value) => navigateTo(value.mainDiagram?.id)).catch(() => navigateTo());
      return;
    }
    navigateTo();
  }, [props.hash, remember]);

  const togglePinned = useCallback((id: string) => {
    setPinnedIds((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [id, ...current];
      storeList(PINNED_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo<WorkspaceContextValue>(() => ({
    workspace,
    projects,
    projectsLoading,
    recentIds,
    pinnedIds,
    setWorkspace,
    togglePinned,
  }), [workspace, projects, projectsLoading, recentIds, pinnedIds, setWorkspace, togglePinned]);

  return <WorkspaceContext.Provider value={value}>{props.children}</WorkspaceContext.Provider>;
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspaceContext 必须在 WorkspaceProvider 内使用");
  return value;
}

export function useWorkspace(): [string, (id: string) => void] {
  const { workspace, setWorkspace } = useWorkspaceContext();
  return [workspace, setWorkspace];
}

export function WorkspaceSwitcher(): ReactElement {
  const { workspace, projects, projectsLoading, recentIds, pinnedIds, setWorkspace, togglePinned } = useWorkspaceContext();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const current = projects.find((project) => project.id === workspace);
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const sorted = useMemo(() => [...projects].sort((a, b) => Number(a.unconfigured) - Number(b.unconfigured) || a.name.localeCompare(b.name)), [projects]);
  const normalizedQuery = q.trim().toLowerCase();
  const matches = useCallback((project: Project) => !normalizedQuery
    || project.name.toLowerCase().includes(normalizedQuery)
    || project.code.toLowerCase().includes(normalizedQuery), [normalizedQuery]);

  const pinned = pinnedIds.map((id) => projectMap.get(id)).filter((project): project is Project => project !== undefined).filter(matches);
  const recent = recentIds.map((id) => projectMap.get(id)).filter((project): project is Project => project !== undefined).filter((project) => !pinnedIds.includes(project.id) && matches(project));
  const reserved = new Set([...pinned.map((project) => project.id), ...recent.map((project) => project.id)]);
  const remaining = sorted.filter((project) => !reserved.has(project.id) && matches(project));
  const displayed = normalizedQuery ? sorted.filter(matches) : [...recent, ...pinned, ...remaining];
  const navigationIds = ["", ...displayed.map((project) => project.id)];
  const accent = current ? stableProjectAccent(current.id) : "#698093";

  const choose = useCallback((id: string) => {
    setWorkspace(id);
    setOpen(false);
    setQ("");
  }, [setWorkspace]);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onShortcut = (event: KeyboardEvent) => {
      if (document.body.dataset.prototypeOpen === "true") return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        setQ("");
        setActiveIndex(0);
      }
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onShortcut);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onShortcut);
    };
  }, []);

  useEffect(() => { setActiveIndex(0); }, [q, open]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, navigationIds.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(navigationIds[activeIndex] ?? "");
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  let itemIndex = 1;
  const renderProject = (project: Project) => {
    const index = itemIndex;
    itemIndex += 1;
    const pinnedProject = pinnedIds.includes(project.id);
    return (
      <div className="ws-item-row" key={project.id}>
        <button
          type="button"
          className={`ws-item ${project.id === workspace ? "active" : ""} ${project.unconfigured ? "unconfigured" : ""} ${index === activeIndex ? "keyboard-active" : ""}`}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => choose(project.id)}
        >
          <span className="ws-project-dot" style={{ "--item-accent": stableProjectAccent(project.id) } as CSSProperties} />
          <span className="ws-item-copy">
            <span className="ws-item-name">{project.name}</span>
            <span className="ws-item-meta">
              <span className="ws-stage">{project.stage}</span>
              {project.unconfigured ? <span className="ws-warn">待配置</span> : null}
            </span>
          </span>
          {project.id === workspace ? <Check size={14} /> : null}
        </button>
        <button
          type="button"
          className={`ws-pin ${pinnedProject ? "active" : ""}`}
          title={pinnedProject ? "取消固定" : "固定项目"}
          aria-label={pinnedProject ? `取消固定 ${project.name}` : `固定 ${project.name}`}
          onClick={() => togglePinned(project.id)}
        >
          <Star size={13} fill={pinnedProject ? "currentColor" : "none"} />
        </button>
      </div>
    );
  };

  const renderGroup = (label: string, values: Project[]) => values.length ? (
    <section className="ws-group" key={label}>
      <div className="ws-group-label">{label}<span>{values.length}</span></div>
      {values.map(renderProject)}
    </section>
  ) : null;

  return (
    <div className={`ws ${open ? "open" : ""}`} ref={ref} style={{ "--project-accent": accent } as CSSProperties}>
      <button
        type="button"
        className="ws-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); setQ(""); }}
        title="切换项目（Ctrl+K）"
      >
        <span className="ws-context-mark">{current ? <Briefcase size={17} /> : <Globe2 size={17} />}</span>
        <span className="ws-context-copy">
          <small>{current ? "当前项目" : "全局工作区"}</small>
          <strong>{current?.name ?? "全部项目"}</strong>
          <span>{current ? `${current.code} · ${current.stage}` : "跨项目总览与管理"}</span>
        </span>
        <ChevronDown className={open ? "open" : ""} size={15} />
      </button>

      {open ? (
        <div className="ws-menu" role="dialog" aria-label="切换项目" onKeyDown={onMenuKeyDown}>
          <div className="ws-menu-head"><span>切换项目</span><kbd>Ctrl K</kbd></div>
          <label className="ws-search">
            <Search size={14} />
            <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索名称或编号…" autoFocus />
          </label>
          <button
            type="button"
            className={`ws-item ws-global-item ${!workspace ? "active" : ""} ${activeIndex === 0 ? "keyboard-active" : ""}`}
            onMouseEnter={() => setActiveIndex(0)}
            onClick={() => choose("")}
          >
            <span className="ws-global-dot"><Globe2 size={14} /></span>
            <span className="ws-item-copy"><span className="ws-item-name">全部项目</span><span className="ws-item-meta">返回跨项目视图</span></span>
            {!workspace ? <Check size={14} /> : null}
          </button>
          {projectsLoading ? <div className="ws-empty">正在加载项目…</div> : normalizedQuery ? renderGroup("搜索结果", displayed) : (
            <>
              {renderGroup("最近使用", recent)}
              {renderGroup("已固定", pinned)}
              {renderGroup("其他项目", remaining)}
            </>
          )}
          {!projectsLoading && displayed.length === 0 ? <div className="ws-empty">无匹配项目</div> : null}
          <div className="ws-menu-foot"><span>{projects.length} 个项目</span><span>↑↓ 选择 · Enter 打开 · Esc 关闭</span></div>
        </div>
      ) : null}
    </div>
  );
}
