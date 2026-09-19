import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { AGENT_ENTITY_REF_LABEL_MAX_LENGTH } from "../../shared/types";
import type {
  AgentApprovalChangedEvent,
  AgentEntityChangedEvent,
  AgentEntityRef,
  AgentNavigationRequestedEvent,
  AgentPageContext,
  AgentPageDraft,
  AgentPageSelection,
  AgentPageType,
  AgentVisibleContent,
  AgentVisibleContentKind,
  AgentUiEvent,
} from "../../shared/types";
import { useWorkspaceContext } from "./workspace";

export interface AgentPageContextDetail {
  projectId?: string | null;
  pageType?: AgentPageType;
  title?: string;
  entityRefs?: AgentEntityRef[];
  selection?: AgentPageSelection;
  draft?: AgentPageDraft | null;
  visibleContent?: AgentVisibleContent | null;
}

interface AgentUiBridgeValue {
  pageContext: AgentPageContext;
  setPageContextDetail: (detail: AgentPageContextDetail | null) => void;
  lastEntityChange: AgentEntityChangedEvent | null;
  lastApprovalChange: AgentApprovalChangedEvent | null;
}

const AgentUiBridgeContext = createContext<AgentUiBridgeValue | null>(null);

function contextId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `context-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const MAX_VISIBLE_CONTENT_LENGTH = 30_000;

export function boundAgentEntityRefs(entityRefs: AgentEntityRef[]): AgentEntityRef[] {
  return entityRefs.map((ref) => {
    if (!ref.label || ref.label.length <= AGENT_ENTITY_REF_LABEL_MAX_LENGTH) return ref;
    const truncated = ref.label.slice(0, AGENT_ENTITY_REF_LABEL_MAX_LENGTH - 1);
    const safeTruncated = /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
    return { ...ref, label: `${safeTruncated}…` };
  });
}

export function agentNavigationRoute(event: AgentNavigationRequestedEvent, context: AgentPageContext): string | null {
  if (event.value.projectId !== context.projectId || event.value.contextId !== context.contextId) return null;
  if (context.draft?.dirty) return null;
  const diagramId = encodeURIComponent(event.value.diagramId);
  const node = event.value.nodeId ? `?node=${encodeURIComponent(event.value.nodeId)}` : "";
  return `#/canvas/${diagramId}${node}`;
}

export function agentVisibleContent(kind: AgentVisibleContentKind, title: string, value: string | unknown): AgentVisibleContent {
  const source = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const truncated = source.length > MAX_VISIBLE_CONTENT_LENGTH;
  return { kind, title, text: truncated ? source.slice(0, MAX_VISIBLE_CONTENT_LENGTH) : source, truncated };
}

export function basePageContext(hash: string, workspace: string): Omit<AgentPageContext, "contextId" | "capturedAt"> {
  const route = hash || "#/";
  const node = route.match(/^#\/canvas\/([^/?]+)\/node\/([^/?]+)/);
  const canvasDatabase = route.match(/^#\/canvas\/database\/([^/?]+)/);
  const projectDatabase = route.match(/^#\/projects\/([^/?]+)\/database\/([^/?]+)/);
  const canvas = route.match(/^#\/canvas\/([^/?]+)/);
  const project = route.match(/^#\/projects\/([^/?]+)/);
  const projectId = (projectDatabase?.[1] ?? project?.[1] ?? workspace) || null;
  const entityRefs: AgentEntityRef[] = projectId ? [{ type: "project", id: projectId }] : [];
  let pageType: AgentPageType = "unknown";

  if (node) {
    pageType = "node";
    entityRefs.push({ type: "diagram", id: node[1] }, { type: "diagramNode", id: node[2], parentId: node[1] });
  } else if (canvasDatabase) {
    pageType = "database";
    entityRefs.push({ type: "databaseModel", id: canvasDatabase[1] });
  } else if (projectDatabase) {
    pageType = "database";
    entityRefs.push({ type: "databaseModel", id: projectDatabase[2] });
  } else if (canvas) {
    pageType = "canvas";
    entityRefs.push({ type: "diagram", id: canvas[1] });
  } else if (project) {
    const query = new URLSearchParams(route.includes("?") ? route.slice(route.indexOf("?") + 1) : "");
    const tab = query.get("tab");
    pageType = tab === "plans" ? "plan"
      : tab === "documents" ? "document"
        : tab === "database" ? "database"
          : tab === "evidence" ? "evidence"
            : tab === "governance" ? "governance"
              : "project";
  }
  else if (route.startsWith("#/projects")) pageType = "projects";
  else if (route.startsWith("#/design")) pageType = "design";
  else if (route.startsWith("#/canvas")) pageType = "canvas";
  else if (route.startsWith("#/governance")) pageType = "governance";
  else if (route.startsWith("#/llm")) pageType = "llm";
  else if (route.startsWith("#/audit")) pageType = "audit";
  else if (route.startsWith("#/backups")) pageType = "backups";
  else if (route === "#/" || route === "#") pageType = "dashboard";

  return {
    projectId,
    route,
    title: typeof document === "undefined" ? "ProductDesign" : document.title || "ProductDesign",
    pageType,
    entityRefs,
    selection: { entityRefs: [] },
    draft: null,
    visibleContent: null,
  };
}

export function AgentUiBridgeProvider({ hash, children }: { hash: string; children: ReactNode }): ReactElement {
  const { workspace } = useWorkspaceContext();
  const [detail, setDetail] = useState<AgentPageContextDetail | null>(null);
  const [lastEntityChange, setLastEntityChange] = useState<AgentEntityChangedEvent | null>(null);
  const [lastApprovalChange, setLastApprovalChange] = useState<AgentApprovalChangedEvent | null>(null);
  useEffect(() => setDetail(null), [hash]);

  const pageContext = useMemo<AgentPageContext>(() => {
    const base = basePageContext(hash, workspace);
    const entityRefs = boundAgentEntityRefs(detail?.entityRefs ?? base.entityRefs);
    const selection = detail?.selection ?? base.selection;
    return {
      ...base,
      ...detail,
      entityRefs,
      selection: { entityRefs: boundAgentEntityRefs(selection.entityRefs) },
      draft: detail?.draft === undefined ? base.draft : detail.draft,
      visibleContent: detail?.visibleContent === undefined ? base.visibleContent : detail.visibleContent,
      contextId: contextId(),
      capturedAt: new Date().toISOString(),
    };
  }, [detail, hash, workspace]);
  const pageContextRef = useRef(pageContext);
  pageContextRef.current = pageContext;

  useEffect(() => {
    const projectId = pageContext.projectId;
    if (!projectId) return;
    const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/agent-events`);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as AgentUiEvent;
        if (event.type === "CUSTOM" && event.name === "productdesign.entity.changed") setLastEntityChange(event);
        if (event.type === "CUSTOM" && event.name === "productdesign.approval.changed") setLastApprovalChange(event);
        if (event.type === "CUSTOM" && event.name === "productdesign.navigation.requested") {
          const route = agentNavigationRoute(event, pageContextRef.current);
          if (route && window.location.hash !== route) window.location.hash = route;
        }
      } catch { /* ignore malformed event; EventSource will continue */ }
    };
    return () => source.close();
  }, [pageContext.projectId]);

  const setPageContextDetail = useCallback((next: AgentPageContextDetail | null) => setDetail(next), []);
  const value = useMemo(
    () => ({ pageContext, setPageContextDetail, lastEntityChange, lastApprovalChange }),
    [lastApprovalChange, lastEntityChange, pageContext, setPageContextDetail],
  );
  return <AgentUiBridgeContext.Provider value={value}>{children}</AgentUiBridgeContext.Provider>;
}

export function useAgentUiBridge(): AgentUiBridgeValue {
  const value = useContext(AgentUiBridgeContext);
  if (!value) throw new Error("useAgentUiBridge 必须在 AgentUiBridgeProvider 中使用");
  return value;
}
