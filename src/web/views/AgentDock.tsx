import {
  Bot,
  ChevronDown,
  ExternalLink,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Paperclip,
  Send,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactElement } from "react";
import type { AgentApproval, AgentControlMode, AgentMessage, AgentSession, AgentWorkspaceSnapshot, LlmProfile } from "../../shared/types";
import { api } from "../api";
import { formatTime } from "../ui";
import { stableProjectAccent, useWorkspaceContext } from "./workspace";
import { useAgentUiBridge } from "./agentUiBridge";

const CONTROL_MODE_LABELS: Record<AgentControlMode, string> = {
  restricted: "受限模式",
  ask: "操作时询问",
  "project-autonomous": "项目自主",
};

type AgentLauncherSide = "left" | "right";
interface AgentLauncherPlacement { side: AgentLauncherSide; y: number }
interface AgentLauncherPoint { x: number; y: number }

const AGENT_LAUNCHER_STORAGE_KEY = "product-design:agent-launcher-placement";
const AGENT_LAUNCHER_DRAG_THRESHOLD = 5;

export function clampAgentLauncherPoint(
  point: AgentLauncherPoint,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap: number,
): AgentLauncherPoint {
  return {
    x: Math.min(Math.max(gap, point.x), Math.max(gap, viewport.width - size.width - gap)),
    y: Math.min(Math.max(gap, point.y), Math.max(gap, viewport.height - size.height - gap)),
  };
}

export function agentLauncherSideForDrop(x: number, width: number, viewportWidth: number): AgentLauncherSide {
  return x + width / 2 < viewportWidth / 2 ? "left" : "right";
}

function launcherGap(viewportWidth: number): number {
  return viewportWidth <= 720 ? 14 : 24;
}

function launcherSize(viewportWidth: number): { width: number; height: number } {
  return { width: viewportWidth <= 720 ? 48 : 104, height: 46 };
}

function loadLauncherPlacement(): AgentLauncherPlacement {
  const gap = launcherGap(window.innerWidth);
  const fallback = { side: "right" as const, y: Math.max(gap, window.innerHeight - 46 - gap) };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AGENT_LAUNCHER_STORAGE_KEY) ?? "null") as Partial<AgentLauncherPlacement> | null;
    if (!parsed || (parsed.side !== "left" && parsed.side !== "right") || typeof parsed.y !== "number" || !Number.isFinite(parsed.y)) return fallback;
    return { side: parsed.side, y: parsed.y };
  } catch {
    return fallback;
  }
}

function saveLauncherPlacement(placement: AgentLauncherPlacement): void {
  try { window.localStorage.setItem(AGENT_LAUNCHER_STORAGE_KEY, JSON.stringify(placement)); } catch { /* storage may be unavailable */ }
}

export function AgentDock(): ReactElement {
  const { workspace, projects } = useWorkspaceContext();
  const { pageContext, lastApprovalChange } = useAgentUiBridge();
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [position, setPosition] = useState(() => ({ x: Math.max(284, window.innerWidth - 516), y: 72 }));
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [launcherPlacement, setLauncherPlacement] = useState<AgentLauncherPlacement>(loadLauncherPlacement);
  const [launcherDragPosition, setLauncherDragPosition] = useState<AgentLauncherPoint | null>(null);
  const launcherDragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; width: number; height: number; moved: boolean } | null>(null);
  const suppressLauncherClickRef = useRef(false);
  const [projectId, setProjectId] = useState("");
  const [snapshot, setSnapshot] = useState<AgentWorkspaceSnapshot | null>(null);
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [decidingApprovalId, setDecidingApprovalId] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const activeSession = snapshot?.sessions.find((item) => item.id === activeSessionId) ?? null;
  const selectedProject = projects.find((item) => item.id === projectId);
  const routeProject = projects.find((item) => item.id === workspace);
  const selectedProfile = profiles.find((item) => item.id === profileId);
  const usableProfiles = profiles.filter((item) => item.enabled);

  const loadWorkspace = useCallback(async (targetProjectId: string, keepSession = true) => {
    if (!targetProjectId) {
      setSnapshot(null);
      setActiveSessionId("");
      return;
    }
    const next = await api.getAgentWorkspace(targetProjectId);
    setSnapshot(next);
    const currentExists = keepSession && next.sessions.some((item) => item.id === activeSessionId);
    const nextSession = currentExists ? next.sessions.find((item) => item.id === activeSessionId) : next.sessions[0];
    setActiveSessionId(nextSession?.id ?? "");
    const preferredProfile = profiles.find((item) => item.id === (nextSession?.profileId ?? next.workspace.defaultProfileId))
      ?? profiles.find((item) => item.enabled);
    setProfileId(preferredProfile?.id ?? "");
    setModel(nextSession?.model ?? preferredProfile?.defaultModel ?? "");
  }, [activeSessionId, profiles]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    Promise.all([api.listLlmProfiles(), api.listProjects()])
      .then(([nextProfiles]) => {
        if (!active) return;
        setProfiles(nextProfiles);
        const target = activeSession?.projectId || projectId || workspace || projects[0]?.id || "";
        setProjectId(target);
      })
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // Opening is the intentional refresh boundary; project state is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !projectId || profiles.length === 0) return;
    let active = true;
    setLoading(true);
    loadWorkspace(projectId, true)
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, projectId, profiles.length, loadWorkspace]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      setApprovals([]);
      return;
    }
    let active = true;
    Promise.all([api.listAgentMessages(activeSessionId), api.listAgentApprovals(activeSessionId, "pending")])
      .then(([items, pendingApprovals]) => {
        if (!active) return;
        setMessages(items);
        setApprovals(pendingApprovals);
      })
      .catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [activeSessionId]);

  useEffect(() => {
    if (!open || !activeSession || activeSession.status !== "running") return;
    const timer = window.setInterval(() => {
      Promise.all([
        api.getAgentWorkspace(activeSession.projectId),
        api.listAgentMessages(activeSession.id),
        api.listAgentApprovals(activeSession.id, "pending"),
      ])
        .then(([next, nextMessages, pendingApprovals]) => {
          setSnapshot(next);
          setMessages(nextMessages);
          setApprovals(pendingApprovals);
        })
        .catch((reason: Error) => setError(reason.message));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, activeSession]);

  useEffect(() => {
    const approval = lastApprovalChange?.value.approval;
    if (!approval || approval.sessionId !== activeSessionId) return;
    setApprovals((current) => approval.status === "pending"
      ? [...current.filter((item) => item.id !== approval.id), approval]
      : current.filter((item) => item.id !== approval.id));
  }, [activeSessionId, lastApprovalChange]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [approvals, messages]);

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      if (dragRef.current && !fullscreen) {
        const nextX = Math.min(Math.max(260, dragRef.current.left + event.clientX - dragRef.current.x), window.innerWidth - 120);
        const nextY = Math.min(Math.max(8, dragRef.current.top + event.clientY - dragRef.current.y), window.innerHeight - 60);
        setPosition({ x: nextX, y: nextY });
      }
      const launcherDrag = launcherDragRef.current;
      if (!launcherDrag || event.pointerId !== launcherDrag.pointerId) return;
      const deltaX = event.clientX - launcherDrag.x;
      const deltaY = event.clientY - launcherDrag.y;
      if (!launcherDrag.moved && Math.hypot(deltaX, deltaY) >= AGENT_LAUNCHER_DRAG_THRESHOLD) launcherDrag.moved = true;
      if (!launcherDrag.moved) return;
      setLauncherDragPosition(clampAgentLauncherPoint(
        { x: launcherDrag.left + deltaX, y: launcherDrag.top + deltaY },
        { width: launcherDrag.width, height: launcherDrag.height },
        { width: window.innerWidth, height: window.innerHeight },
        launcherGap(window.innerWidth),
      ));
    };
    const up = (event: globalThis.PointerEvent) => {
      dragRef.current = null;
      const launcherDrag = launcherDragRef.current;
      if (!launcherDrag || event.pointerId !== launcherDrag.pointerId) return;
      const point = clampAgentLauncherPoint(
        { x: launcherDrag.left + event.clientX - launcherDrag.x, y: launcherDrag.top + event.clientY - launcherDrag.y },
        { width: launcherDrag.width, height: launcherDrag.height },
        { width: window.innerWidth, height: window.innerHeight },
        launcherGap(window.innerWidth),
      );
      if (launcherDrag.moved) {
        const placement = { side: agentLauncherSideForDrop(point.x, launcherDrag.width, window.innerWidth), y: point.y };
        setLauncherPlacement(placement);
        saveLauncherPlacement(placement);
        suppressLauncherClickRef.current = true;
        window.setTimeout(() => { suppressLauncherClickRef.current = false; }, 0);
      }
      launcherDragRef.current = null;
      setLauncherDragPosition(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [fullscreen]);

  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, select, input")) return;
    dragRef.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
  };

  const beginLauncherDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    launcherDragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
    setLauncherDragPosition({ x: rect.left, y: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const changeProject = (nextId: string) => {
    if (activeSession?.status === "running") {
      setError("当前会话运行中，不能切换工作台项目");
      return;
    }
    setProjectId(nextId);
    setActiveSessionId("");
    setMessages([]);
    setError("");
  };

  const changeProfile = async (nextProfileId: string) => {
    const nextProfile = profiles.find((item) => item.id === nextProfileId);
    if (!nextProfile) return;
    setProfileId(nextProfileId);
    setModel(nextProfile.defaultModel);
    if (activeSession) {
      try {
        const next = await api.updateAgentSession(activeSession.id, { profileId: nextProfileId, model: nextProfile.defaultModel });
        setSnapshot((current) => current ? { ...current, sessions: current.sessions.map((item) => item.id === next.id ? next : item) } : current);
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    }
  };

  const changeModel = async (nextModel: string) => {
    setModel(nextModel);
    if (!activeSession) return;
    try {
      const next = await api.updateAgentSession(activeSession.id, { model: nextModel });
      setSnapshot((current) => current ? { ...current, sessions: current.sessions.map((item) => item.id === next.id ? next : item) } : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const changeControlMode = async (controlMode: AgentControlMode) => {
    if (!activeSession) return;
    try {
      const next = await api.updateAgentSession(activeSession.id, { controlMode });
      setSnapshot((current) => current ? { ...current, sessions: current.sessions.map((item) => item.id === next.id ? next : item) } : current);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const decideApproval = async (approval: AgentApproval, decision: "approve_once" | "deny") => {
    setDecidingApprovalId(approval.id);
    setError("");
    try {
      await api.decideAgentApproval(approval.id, approval.sessionId, decision);
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setDecidingApprovalId(""); }
  };

  const createSession = async () => {
    if (!projectId || !selectedProfile || !model) {
      setError("请先选择项目、LLM 配置和模型");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const session = await api.createAgentSession({ projectId, profileId: selectedProfile.id, model, title: "新会话" });
      const next = await api.getAgentWorkspace(projectId);
      setSnapshot(next);
      setActiveSessionId(session.id);
      setMessages([]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };

  const deleteSession = async () => {
    if (!activeSession) return;
    if (activeSession.status === "running" && !window.confirm("Agent 仍在运行。删除会先终止当前执行；已经完成的工具修改不会回滚。确定删除此会话吗？")) return;
    setLoading(true);
    setError("");
    try {
      await api.deleteAgentSession(activeSession.id);
      const next = await api.getAgentWorkspace(activeSession.projectId);
      setSnapshot(next);
      setActiveSessionId(next.sessions[0]?.id ?? "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };

  const sendMessage = async () => {
    const content = input.trim();
    if (!activeSession || !content || activeSession.status === "running") return;
    setError("");
    try {
      if (pageContext.projectId && pageContext.projectId !== activeSession.projectId) {
        setError("当前页面与 Agent 会话不属于同一项目，请切换工作台项目或新建对应项目会话");
        return;
      }
      const response = await api.sendAgentMessage(activeSession.id, content, pageContext);
      setInput("");
      setMessages((current) => [...current, response.userMessage, response.assistantMessage]);
      setSnapshot((current) => current ? {
        ...current,
        sessions: current.sessions.map((item) => item.id === response.session.id ? response.session : item),
      } : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const statusLabel = useMemo(() => {
    if (!activeSession) return "未创建会话";
    if (activeSession.status === "running") return "运行中";
    if (activeSession.status === "failed") return "运行失败";
    return "已就绪";
  }, [activeSession]);

  const floatingSize = launcherSize(viewport.width);
  const floatingGap = launcherGap(viewport.width);
  const settledLauncherPoint = clampAgentLauncherPoint({
    x: launcherPlacement.side === "left" ? floatingGap : viewport.width - floatingSize.width - floatingGap,
    y: launcherPlacement.y,
  }, floatingSize, viewport, floatingGap);
  const launcherPoint = launcherDragPosition ?? settledLauncherPoint;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => window.dispatchEvent(new Event("agent-dock-geometry-change")));
    return () => window.cancelAnimationFrame(frame);
  }, [fullscreen, launcherDragPosition, launcherPlacement, minimized, open, position, viewport]);

  return (
    <>
      <button
        className={`agent-launcher ${open ? "is-open" : ""} ${launcherDragPosition ? "is-dragging" : ""}`}
        style={{ left: launcherPoint.x, top: launcherPoint.y, right: "auto", bottom: "auto" }}
        data-side={launcherPlacement.side}
        onPointerDown={beginLauncherDrag}
        onClick={() => {
          if (suppressLauncherClickRef.current) return;
          setOpen(true);
          setMinimized(false);
        }}
        aria-label="打开项目 Agent 工作台"
        title="拖动可调整位置，点击打开 Agent"
      >
        <Bot size={21} /><span>Agent</span>
      </button>
      {open && (
        <section
          className={`agent-dock ${fullscreen ? "is-fullscreen" : ""} ${minimized ? "is-minimized" : ""}`}
          style={fullscreen ? undefined : { left: position.x, top: position.y }}
          aria-label="项目 Agent 工作台"
        >
          <div className="agent-dock-header" onPointerDown={beginDrag}>
            <div className="agent-dock-identity">
              <span className="agent-dock-mark"><Bot size={18} /></span>
              <div><strong>项目 Agent</strong><span>{selectedProject?.name ?? "选择一个项目"}</span></div>
            </div>
            <div className="agent-dock-actions">
              <button onClick={() => setMinimized((value) => !value)} aria-label={minimized ? "展开" : "最小化"}><Minimize2 size={16} /></button>
              <button onClick={() => { setFullscreen((value) => !value); setMinimized(false); }} aria-label={fullscreen ? "退出全屏" : "全屏"}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
              <button onClick={() => setOpen(false)} aria-label="关闭"><X size={17} /></button>
            </div>
          </div>

          {!minimized && (
            <>
              <div className="agent-dock-context">
                <label>
                  <span>项目工作台</span>
                  <div className="agent-select-wrap">
                    <i style={{ background: projectId ? stableProjectAccent(projectId) : "#698093" }} />
                    <select value={projectId} onChange={(event) => changeProject(event.target.value)} disabled={activeSession?.status === "running"}>
                      <option value="">选择项目</option>
                      {projects.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}
                    </select>
                    <ChevronDown size={14} />
                  </div>
                </label>
                <label>
                  <span>会话</span>
                  <div className="agent-session-row">
                    <div className="agent-select-wrap">
                      <select value={activeSessionId} onChange={(event) => setActiveSessionId(event.target.value)} disabled={!snapshot?.sessions.length}>
                        {!snapshot?.sessions.length && <option value="">暂无会话</option>}
                        {snapshot?.sessions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                      </select>
                      <ChevronDown size={14} />
                    </div>
                    <button onClick={createSession} title="新建会话" disabled={!projectId || !profileId || loading}><MessageSquarePlus size={17} /></button>
                    <button onClick={deleteSession} title={activeSession?.status === "running" ? "终止并删除会话" : "删除会话"} disabled={!activeSession || loading}><Trash2 size={16} /></button>
                  </div>
                </label>
              </div>

              <div className="agent-runtime-bar">
                <div className="agent-runtime-selects">
                  <select value={profileId} onChange={(event) => void changeProfile(event.target.value)} disabled={activeSession?.status === "running"}>
                    <option value="">选择 LLM 配置</option>
                    {usableProfiles.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.protocol}</option>)}
                  </select>
                  <select value={model} onChange={(event) => void changeModel(event.target.value)} disabled={!selectedProfile || activeSession?.status === "running"}>
                    {(selectedProfile?.models ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                  <select
                    aria-label="Agent 控制模式"
                    value={activeSession?.controlMode ?? "restricted"}
                    onChange={(event) => void changeControlMode(event.target.value as AgentControlMode)}
                    disabled={!activeSession || activeSession.status === "running"}
                    title="控制 Agent 对项目目录内命令和文件修改的授权方式"
                  >
                    {(Object.entries(CONTROL_MODE_LABELS) as Array<[AgentControlMode, string]>).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
                <span className={`agent-run-status ${activeSession?.status ?? "idle"}`}><i />{statusLabel}</span>
              </div>

              {routeProject && activeSession && routeProject.id !== activeSession.projectId && (
                <div className="agent-project-warning">当前页面属于“{routeProject.name}”，本会话仍固定在“{selectedProject?.name}”。</div>
              )}
              {error && <div className="agent-error">{error}</div>}

              {activeSession?.controlMode === "project-autonomous" && (
                <div className="agent-control-note"><Shield size={14} />项目自主仅覆盖受管项目目录；跨目录、系统权限和业务高风险动作仍会被拦截。</div>
              )}

              <div className="agent-message-list">
                {!activeSession && (
                  <div className="agent-empty">
                    <Bot size={32} />
                    <strong>创建这个项目的第一条 Agent 会话</strong>
                    <p>会话会固定绑定项目与模型配置，不会因页面切换静默改绑。</p>
                    {usableProfiles.length === 0 ? (
                      <button onClick={() => { window.location.hash = "#/llm"; }}><ExternalLink size={15} />先配置 LLM</button>
                    ) : <button onClick={createSession}><MessageSquarePlus size={15} />新建会话</button>}
                  </div>
                )}
                {approvals.map((approval) => (
                  <article key={approval.id} className="agent-approval-card">
                    <header><span><Shield size={15} />等待授权</span><time>{formatTime(approval.createdAt)}</time></header>
                    <strong>{approval.title}</strong>
                    <p>{approval.summary}</p>
                    <div className="agent-approval-actions">
                      <button
                        className="approve"
                        onClick={() => void decideApproval(approval, "approve_once")}
                        disabled={decidingApprovalId === approval.id}
                      >允许一次</button>
                      <button onClick={() => void decideApproval(approval, "deny")} disabled={decidingApprovalId === approval.id}>拒绝</button>
                    </div>
                  </article>
                ))}
                {messages.map((message) => (
                  <article key={message.id} className={`agent-message ${message.role} ${message.status}`}>
                    <header><span>{message.role === "user" ? "你" : message.role === "assistant" ? "Agent" : "系统"}</span><time>{formatTime(message.updatedAt)}</time></header>
                    {message.pageContext && <div className="agent-message-context"><Paperclip size={13} />{message.pageContext.title} · {message.pageContext.route}</div>}
                    <div className="agent-message-content">{message.content || (message.status === "queued" ? "等待执行…" : "正在思考…")}</div>
                  </article>
                ))}
                <div ref={messageEndRef} />
              </div>

              <div className="agent-composer">
                <div className="agent-composer-tools">
                  <button className="active" disabled title="当前页面和选区会自动作为 AG-UI 上下文发送">
                    <Paperclip size={14} />已关联当前页{pageContext.selection.entityRefs.length ? ` · ${pageContext.selection.entityRefs.length} 项选中` : ""}
                  </button>
                  <span>{activeSession ? `${selectedProject?.code ?? ""} · ${activeSession.model}` : "先新建会话"}</span>
                </div>
                <div className="agent-composer-input">
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
                    }}
                    placeholder="向项目 Agent 说明目标，Enter 发送，Shift+Enter 换行"
                    disabled={!activeSession || activeSession.status === "running"}
                  />
                  <button onClick={() => void sendMessage()} disabled={!activeSession || !input.trim() || activeSession.status === "running"} aria-label="发送"><Send size={18} /></button>
                </div>
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
