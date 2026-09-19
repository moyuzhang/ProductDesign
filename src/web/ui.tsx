import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { HealthLevel, ProjectStage } from "../shared/types.js";
export {
  formatDateOnly as formatDate,
  formatInstantDateTime as formatDateTime,
  formatInstantTime as formatTime,
} from "../shared/time.js";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "accent" | "muted";

export function Badge(props: { children: ReactNode; tone?: Tone }): ReactElement {
  return <span className={`badge badge-${props.tone ?? "neutral"}`}>{props.children}</span>;
}

const HEALTH_TONE: Record<HealthLevel, Tone> = {
  正常: "good",
  关注: "warn",
  高风险: "bad",
  阻塞: "bad",
};

const STAGE_TONE: Record<ProjectStage, Tone> = {
  探索: "muted",
  规划: "info",
  设计: "accent",
  开发: "good",
  测试: "warn",
  交付: "accent",
  维护: "neutral",
};

export function HealthBadge({ health }: { health: string }): ReactElement {
  return <Badge tone={HEALTH_TONE[health as HealthLevel] ?? "neutral"}>{health}</Badge>;
}

export function StageBadge({ stage }: { stage: string }): ReactElement {
  return <Badge tone={STAGE_TONE[stage as ProjectStage] ?? "neutral"}>{stage}</Badge>;
}

export function ProgressBar({ value }: { value: number }): ReactElement {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="progress">
      <div className="progress-fill" style={{ width: `${clamped}%` }} />
      <span className="progress-text">{clamped}%</span>
    </div>
  );
}

export function StatCard(props: { label: string; value: ReactNode; hint?: string; tone?: Tone }): ReactElement {
  return (
    <div className={`stat-card stat-${props.tone ?? "neutral"}`}>
      <div className="stat-value">{props.value}</div>
      <div className="stat-label">{props.label}</div>
      {props.hint ? <div className="stat-hint">{props.hint}</div> : null}
    </div>
  );
}

export function EmptyState({ text }: { text: string }): ReactElement {
  return <div className="empty-state">{text}</div>;
}

export function Field(props: { label: string; children: ReactNode; wide?: boolean }): ReactElement {
  return (
    <label className={`field ${props.wide ? "field-wide" : ""}`}>
      <span className="field-label">{props.label}</span>
      {props.children}
    </label>
  );
}

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="modal-overlay" onMouseDown={props.onClose}>
      <div
        className="modal"
        style={{ width: props.width ?? 640 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{props.title}</h3>
          <button className="btn btn-ghost btn-icon" onClick={props.onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <div className="modal-footer">{props.footer}</div> : null}
      </div>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }): ReactElement {
  return <div className="error-banner">{message}</div>;
}

export function Spinner(): ReactElement {
  return <div className="spinner">加载中…</div>;
}

export function Pagination(props: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}): ReactElement | null {
  if (props.total <= props.limit && props.offset === 0) return null;
  const page = Math.floor(props.offset / props.limit) + 1;
  const pages = Math.max(1, Math.ceil(props.total / props.limit));
  const start = props.total === 0 ? 0 : props.offset + 1;
  const end = Math.min(props.offset + props.limit, props.total);
  return (
    <nav className="pagination" aria-label="列表分页">
      <span className="pagination-summary">{start}–{end} / 共 {props.total} 条</span>
      <button className="btn btn-ghost" disabled={props.offset === 0} onClick={() => props.onChange(Math.max(0, props.offset - props.limit))}>上一页</button>
      <span className="pagination-page">第 {page} / {pages} 页</span>
      <button className="btn btn-ghost" disabled={props.offset + props.limit >= props.total} onClick={() => props.onChange(props.offset + props.limit)}>下一页</button>
    </nav>
  );
}

export function Select<T extends string>(props: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  width?: number;
  ariaLabel?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const selectedIndex = Math.max(0, props.options.findIndex((option) => option.value === props.value));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const commit = (value: T) => { props.onChange(value); setOpen(false); };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") { setOpen(false); return; }
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault();
        setOpen(true);
        setActive(selectedIndex);
      }
      return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(props.options.length - 1, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(props.options.length - 1); }
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = props.options[active];
      if (option) commit(option.value);
    }
  };

  const label = props.options.find((option) => option.value === props.value)?.label ?? "";
  return (
    <div className="select" ref={rootRef} style={{ width: props.width ?? 170 }}>
      <button
        type="button"
        role="combobox"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={props.ariaLabel}
        onClick={() => { setOpen((current) => !current); setActive(selectedIndex); }}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{label}</span>
        <ChevronDown size={14} className={open ? "open" : ""} />
      </button>
      {open ? (
        <div className="select-menu" id={listId} ref={listRef} role="listbox" aria-label={props.ariaLabel ?? "选择"} onKeyDown={onKeyDown}>
          {props.options.map((option, index) => (
            <div
              key={option.value}
              role="option"
              data-index={index}
              aria-selected={option.value === props.value}
              className={`select-option${option.value === props.value ? " selected" : ""}${active === index ? " active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(option.value)}
            >
              <span>{option.label}</span>
              {option.value === props.value ? <Check size={13} /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
