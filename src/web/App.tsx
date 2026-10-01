import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import {
  DatabaseBackup,
  Bot,
  FolderKanban,
  Gavel,
  LayoutDashboard,
  PenTool,
  BookOpenText,
  ScrollText,
  Shapes,
  Workflow,
} from "lucide-react";
import { WorkspaceProvider, WorkspaceSwitcher, stableProjectAccent, useWorkspaceContext } from "./views/workspace";
import { AgentDock } from "./views/AgentDock";
import { AgentUiBridgeProvider } from "./views/agentUiBridge";

const AuditView = lazy(() => import("./views/AuditView").then((module) => ({ default: module.AuditView })));
const BackupsView = lazy(() => import("./views/BackupsView").then((module) => ({ default: module.BackupsView })));
const CanvasWorkbenchView = lazy(() => import("./views/CanvasWorkbenchView").then((module) => ({ default: module.CanvasWorkbenchView })));
const DashboardView = lazy(() => import("./views/DashboardView").then((module) => ({ default: module.DashboardView })));
const DesignHubView = lazy(() => import("./views/DesignHubView").then((module) => ({ default: module.DesignHubView })));
const DatabaseWorkbenchView = lazy(() => import("./views/DatabaseWorkbenchView").then((module) => ({ default: module.DatabaseWorkbenchView })));
const GovernanceView = lazy(() => import("./views/GovernanceView").then((module) => ({ default: module.GovernanceView })));
const LlmSettingsView = lazy(() => import("./views/LlmSettingsView").then((module) => ({ default: module.LlmSettingsView })));
const NodeDetailView = lazy(() => import("./views/NodeDetailView").then((module) => ({ default: module.NodeDetailView })));
const ProjectDetailView = lazy(() => import("./views/ProjectDetailView").then((module) => ({ default: module.ProjectDetailView })));
const ProjectsView = lazy(() => import("./views/ProjectsView").then((module) => ({ default: module.ProjectsView })));
const AgentOrchestrationView = lazy(() => import("./views/AgentOrchestrationView").then((module) => ({ default: module.AgentOrchestrationView })));
const SystemGuideView = lazy(() => import("./views/SystemGuideView").then((module) => ({ default: module.SystemGuideView })));

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  const currentHash = useRef(hash);
  useEffect(() => {
    const onChange = () => {
      const nextHash = window.location.hash || "#/";
      if (window.__productDesignPrototypeGuard && !window.__productDesignPrototypeGuard()) {
        window.history.replaceState(null, "", currentHash.current);
        return;
      }
      currentHash.current = nextHash;
      setHash(nextHash);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function navigate(path: string): void {
  window.location.hash = path;
}

const NAV_ITEMS = [
  { hash: "#/", label: "总览", icon: LayoutDashboard },
  { hash: "#/projects", label: "项目管理", icon: FolderKanban },
  { hash: "#/orchestration", label: "外部开发 / 工单", icon: Workflow },
  { hash: "#/governance", label: "治理决策", icon: Gavel },
  { hash: "#/llm", label: "LLM 配置", icon: Bot },
  { hash: "#/audit", label: "审计日志", icon: ScrollText },
  { hash: "#/backups", label: "备份", icon: DatabaseBackup },
  { hash: "#/guide", label: "系统说明", icon: BookOpenText },
  { hash: "#/design", label: "设计中枢", icon: PenTool },
  { hash: "#/canvas", label: "画布工作台", icon: Shapes },
];

export function App(): ReactElement {
  const hash = useHashRoute();
  return <WorkspaceProvider hash={hash}><AgentUiBridgeProvider hash={hash}><AppShell hash={hash} /></AgentUiBridgeProvider></WorkspaceProvider>;
}

function AppShell({ hash }: { hash: string }): ReactElement {
  const { workspace } = useWorkspaceContext();
  const projectMatch = hash.match(/^#\/projects\/([^/?]+)/);
  const projectDatabaseModelMatch = hash.match(/^#\/projects\/([^/?]+)\/database\/([^/?]+)/);
  const canvasDatabaseModelMatch = hash.match(/^#\/canvas\/database\/([^/?]+)/);
  const projectQuery = new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "");
  const nodeDetailMatch = hash.match(/^#\/canvas\/([^/?]+)\/node\/([^/?]+)(?:\?([^#]*))?$/);
  const nodeDetailQuery = new URLSearchParams(nodeDetailMatch?.[3] ?? "");
  const canvasMatch = hash.match(/^#\/canvas\/([^/?]+)(?:\?([^#]*))?$/);
  const canvasQuery = new URLSearchParams(canvasMatch?.[2] ?? "");

  useEffect(() => {
    if (hash.startsWith("#/database")) navigate("#/projects");
  }, [hash]);

  let page: ReactElement;
  if (canvasDatabaseModelMatch) {
    page = <DatabaseWorkbenchView modelId={canvasDatabaseModelMatch[1]} surface="canvas" />;
  } else if (nodeDetailMatch) {
    page = <NodeDetailView
      diagramId={nodeDetailMatch[1]}
      nodeId={nodeDetailMatch[2]}
      initialTab={nodeDetailQuery.get("tab") ?? undefined}
      initialPlanId={nodeDetailQuery.get("plan") ?? undefined}
    />;
  } else if (projectDatabaseModelMatch) {
    page = <DatabaseWorkbenchView projectId={projectDatabaseModelMatch[1]} modelId={projectDatabaseModelMatch[2]} />;
  } else if (projectMatch) {
    page = <ProjectDetailView key={projectMatch[1]} projectId={projectMatch[1]} initialTab={projectQuery.get("tab") ?? undefined} />;
  } else if (hash.startsWith("#/orchestration")) {
    page = <AgentOrchestrationView />;
  } else if (hash.startsWith("#/projects")) {
    page = <ProjectsView />;
  } else if (hash.startsWith("#/guide")) {
    page = <SystemGuideView />;
  } else if (hash.startsWith("#/design")) {
    page = <DesignHubView />;
  } else if (hash.startsWith("#/canvas")) {
    page = <CanvasWorkbenchView diagramId={canvasMatch?.[1]} focusNodeId={canvasQuery.get("node") ?? undefined} designView={projectQuery.get("view") === "database" ? "database" : "canvas"} />;
  } else if (hash.startsWith("#/database")) {
    page = <ProjectsView />;
  } else if (hash.startsWith("#/governance")) {
    page = <GovernanceView />;
  } else if (hash.startsWith("#/llm")) {
    page = <LlmSettingsView />;
  } else if (hash.startsWith("#/audit")) {
    page = <AuditView />;
  } else if (hash.startsWith("#/backups")) {
    page = <BackupsView />;
  } else {
    page = <DashboardView />;
  }

  return (
    <div
      className={`app ${workspace ? "has-project-context" : "global-context"}`}
      style={{ "--project-accent": workspace ? stableProjectAccent(workspace) : "#698093" } as CSSProperties}
    >
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">PCS</div>
          <div>
            <div className="brand-title">项目控制台</div>
            <div className="brand-sub">Product Design Surface</div>
          </div>
        </div>
        <div className="sidebar-context"><WorkspaceSwitcher /></div>
        {NAV_ITEMS.filter((item) => !["#/design", "#/canvas"].includes(item.hash)).map((item) => {
          const active =
            item.hash === "#/"
              ? hash === "#" || hash === "#/" || Boolean(projectMatch)
              : item.hash === "#/projects"
                ? hash === "#/projects" || hash.startsWith("#/projects?")
                : hash.startsWith(item.hash);
          const Icon = item.icon;
          return (
            <button
              key={item.hash}
              className={`nav-item ${active ? "active" : ""}`}
              onClick={() => navigate(item.hash === "#/" && workspace ? `#/projects/${workspace}` : item.hash)}
            >
              <Icon />
              {item.label}
            </button>
          );
        })}
        <details className="sidebar-tools" open={hash.startsWith("#/design") || hash.startsWith("#/canvas")}>
          <summary>设计辅助工具</summary>
          {NAV_ITEMS.filter((item) => ["#/design", "#/canvas"].includes(item.hash)).map((item) => {
            const Icon = item.icon;
            return <button key={item.hash} className={`nav-item ${hash.startsWith(item.hash) ? "active" : ""}`} onClick={() => navigate(item.hash)}><Icon />{item.label}</button>;
          })}
        </details>
        <div className="sidebar-footer">
          本地优先 · 数据存储于 data/control-surface.db
        </div>
      </aside>
      <main className="main"><Suspense fallback={<div className="spinner">页面加载中…</div>}>{page}</Suspense></main>
      <AgentDock />
    </div>
  );
}
