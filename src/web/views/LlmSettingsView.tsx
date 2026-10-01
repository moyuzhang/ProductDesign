import { CodexRuntimeSettings } from "./CodexRuntimePanel";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleOff,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  ShieldCheck,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import {
  LLM_PROTOCOLS,
  LLM_REASONING_EFFORTS,
  type LlmConnectionCheck,
  type LlmProfile,
  type LlmProtocol,
  type LlmReasoningEffort,
} from "../../shared/types";
import { api } from "../api";
import { ChatGptAccountPanel, type AccountModel } from "./ChatGptAccountPanel";
import { Badge, ErrorBanner, Field, Modal, Spinner, formatDateTime } from "../ui";

const PROTOCOL_LABELS: Record<LlmProtocol, string> = {
  "openai-responses": "OpenAI Responses",
  "openai-chat": "OpenAI Chat Completions",
  "anthropic-messages": "Anthropic Messages",
};

const REASONING_EFFORT_LABELS: Record<LlmReasoningEffort, string> = {
  none: "关闭",
  low: "低",
  high: "高",
  max: "最大",
};

export interface LlmProviderPreset {
  id: string;
  label: string;
  mark: string;
  description: string;
  protocol: LlmProtocol;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  apiKeyEnv: string;
  reasoningEffort: LlmReasoningEffort;
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  { id: "deepseek", label: "DeepSeek", mark: "DS", description: "V4 Agent 与工具调用", protocol: "openai-chat", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", models: ["deepseek-v4-flash"], apiKeyEnv: "DEEPSEEK_API_KEY", reasoningEffort: "high" },
  { id: "openai", label: "OpenAI", mark: "OA", description: "Responses 原生能力", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.2", models: ["gpt-5.2", "gpt-5-mini"], apiKeyEnv: "OPENAI_API_KEY", reasoningEffort: "none" },
  { id: "anthropic", label: "Anthropic", mark: "AN", description: "Messages 协议", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-5", models: ["claude-sonnet-4-5"], apiKeyEnv: "ANTHROPIC_API_KEY", reasoningEffort: "none" },
  { id: "gemini", label: "Gemini", mark: "GM", description: "OpenAI 兼容入口", protocol: "openai-chat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-flash", models: ["gemini-2.5-flash", "gemini-2.5-pro"], apiKeyEnv: "GEMINI_API_KEY", reasoningEffort: "none" },
  { id: "kimi", label: "Kimi", mark: "KM", description: "Moonshot 兼容接口", protocol: "openai-chat", baseUrl: "https://api.moonshot.cn/v1", defaultModel: "kimi-k2-0711-preview", models: ["kimi-k2-0711-preview"], apiKeyEnv: "MOONSHOT_API_KEY", reasoningEffort: "none" },
  { id: "glm", label: "GLM / 智谱", mark: "GL", description: "BigModel 兼容接口", protocol: "openai-chat", baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.5-flash", models: ["glm-4.5-flash"], apiKeyEnv: "ZHIPU_API_KEY", reasoningEffort: "none" },
  { id: "custom_gateway", label: "自建网关", mark: "GW", description: "自定义兼容服务", protocol: "openai-chat", baseUrl: "", defaultModel: "", models: [], apiKeyEnv: "LLM_GATEWAY_API_KEY", reasoningEffort: "none" },
];

const KNOWN_PRESETS = LLM_PROVIDER_PRESETS.filter((preset) => preset.id !== "custom_gateway");

export interface ProfileFormState {
  authMode?: "api-key" | "chatgpt";
  name: string;
  provider: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKeyEnv: string;
  modelsText: string;
  defaultModel: string;
  enabled: boolean;
  reasoningEffort: LlmReasoningEffort;
  timeoutMs: number;
  apiKey: string;
}

function formFromPreset(preset: LlmProviderPreset): ProfileFormState {
  return {
    authMode: "api-key",
    name: `${preset.label} 默认配置`,
    provider: preset.id,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    apiKeyEnv: preset.apiKeyEnv,
    modelsText: preset.models.join("\n"),
    defaultModel: preset.defaultModel,
    enabled: true,
    reasoningEffort: preset.reasoningEffort,
    timeoutMs: 60_000,
    apiKey: "",
  };
}

const EMPTY_FORM = formFromPreset(KNOWN_PRESETS[0]);

export function formFromProfile(profile: LlmProfile): ProfileFormState {
  return {
    authMode: profile.authMode ?? "api-key",
    name: profile.name,
    provider: profile.provider,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    apiKeyEnv: profile.apiKeyEnv,
    modelsText: profile.models.join("\n"),
    defaultModel: profile.defaultModel,
    enabled: profile.enabled,
    reasoningEffort: profile.reasoningEffort,
    timeoutMs: profile.timeoutMs,
    apiKey: "",
  };
}

export function parseModels(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

export function profilePayloadFromForm(form: ProfileFormState): Omit<ProfileFormState, "modelsText" | "apiKey"> & { models: string[]; apiKey?: string } {
  const defaultModel = form.defaultModel.trim();
  const models = parseModels(form.modelsText);
  if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
  const apiKey = form.apiKey.trim();
  return {
    authMode: form.authMode ?? "api-key",
    name: form.name.trim(),
    provider: form.authMode === "chatgpt" ? "openai" : form.provider.trim(),
    protocol: form.authMode === "chatgpt" ? "openai-responses" : form.protocol,
    baseUrl: form.authMode === "chatgpt" ? "https://api.openai.com/v1" : form.baseUrl.trim(),
    apiKeyEnv: form.authMode === "chatgpt" ? "OPENAI_API_KEY" : form.apiKeyEnv.trim(),
    models,
    defaultModel,
    enabled: form.enabled,
    reasoningEffort: form.reasoningEffort,
    timeoutMs: form.timeoutMs,
    ...(apiKey && form.authMode !== "chatgpt" ? { apiKey } : {}),
  };
}

function presetFor(provider: string): LlmProviderPreset | undefined {
  const value = provider.toLocaleLowerCase();
  return LLM_PROVIDER_PRESETS.find((preset) => preset.id === value || preset.label.toLocaleLowerCase() === value);
}

function checkMeta(checked: LlmConnectionCheck): { label: string; tone: "ok" | "warn" | "fail"; icon: ReactElement } {
  if (!checked.ok) {
    if (checked.status === "missing_credential") return { label: "缺少凭据", tone: "warn", icon: <CircleOff /> };
    return { label: "请求失败", tone: "fail", icon: <XCircle /> };
  }
  return { label: "连接成功", tone: "ok", icon: <CheckCircle2 /> };
}

interface EditTarget {
  id: string | "new";
  preset: LlmProviderPreset;
  credentialConfigured: boolean;
}

function credentialLabel(profile: LlmProfile): string {
  if (profile.authMode === "chatgpt") return "ChatGPT 账户 · 登录状态见账户面板";
  if (profile.credentialSource === "stored") return `密钥已配置 · ${profile.credentialMasked}`;
  if (profile.credentialSource === "environment") return `环境变量 ${profile.apiKeyEnv} 已就绪`;
  return "未配置密钥";
}

export function LlmSettingsView(): ReactElement {
  const [accountModels, setAccountModels] = useState<AccountModel[]>([]);
  const [profiles, setProfiles] = useState<LlmProfile[] | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [initialForm, setInitialForm] = useState<ProfileFormState>(EMPTY_FORM);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState("");
  const [checks, setChecks] = useState<Record<string, LlmConnectionCheck>>({});

  const reload = useCallback(() => api.listLlmProfiles()
    .then((items) => { setProfiles(items); setError(""); return items; })
    .catch((cause: Error) => { setError(cause.message); throw cause; }), []);

  useEffect(() => { reload().catch(() => undefined); }, [reload]);

  const cards = useMemo(() => {
    const items = profiles ?? [];
    return KNOWN_PRESETS.map((preset) => {
      const profile = items.find((item) => item.authMode !== "chatgpt" && (item.provider === preset.id || item.provider.toLocaleLowerCase() === preset.label.toLocaleLowerCase()));
      return { preset, profile };
    });
  }, [profiles]);

  const extras = useMemo(() => {
    const items = profiles ?? [];
    const shown = new Set(cards.map((card) => card.profile?.id));
    return items.filter((item) => !shown.has(item.id));
  }, [profiles, cards]);

  const openEdit = (preset: LlmProviderPreset, profile?: LlmProfile) => {
    setInitialForm(profile ? formFromProfile(profile) : formFromPreset(preset));
    setEditing({ id: profile?.id ?? "new", preset, credentialConfigured: profile?.credentialConfigured ?? false });
    setError("");
    setNotice("");
  };

  const submit = async (form: ProfileFormState) => {
    const payload = profilePayloadFromForm(form);
    if (!payload.defaultModel) { setError("请填写默认模型"); return false; }
    if (payload.models.length === 0) { setError("至少填写一个模型"); return false; }
    if (payload.authMode === "chatgpt" && !accountModels.some((item) => item.model === payload.defaultModel)) { setError("请先登录并刷新账户模型，再选择当前可用模型"); return false; }
    if (!editing) return false;
    setSaving(true);
    setError("");
    try {
      const saved = editing.id === "new"
        ? await api.createLlmProfile(payload)
        : await api.updateLlmProfile(editing.id, payload);
      setProfiles((current) => {
        const items = current ?? [];
        return items.some((item) => item.id === saved.id)
          ? items.map((item) => item.id === saved.id ? saved : item)
          : [...items, saved];
      });
      setEditing(null);
      setNotice(payload.authMode === "chatgpt" ? "ChatGPT 配置已保存。实际可用性受账户权限与额度限制。" : "配置已保存。可在卡片上执行连接测试。");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const testProfile = async (profile: LlmProfile) => {
    setTestingId(profile.id);
    setError("");
    setNotice("");
    try {
      const result = await api.testLlmProfile(profile.id);
      setChecks((current) => ({ ...current, [profile.id]: result }));
    } catch (cause) {
      setChecks((current) => ({
        ...current,
        [profile.id]: { ok: false, status: "request_failed", message: cause instanceof Error ? cause.message : "测试失败", latencyMs: 0, checkedAt: new Date().toISOString() },
      }));
    } finally {
      setTestingId("");
    }
  };

  const toggleEnabled = async (profile: LlmProfile) => {
    try {
      const updated = await api.updateLlmProfile(profile.id, { enabled: !profile.enabled });
      setProfiles((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? [updated]);
      setNotice(updated.enabled ? "配置已启用。" : "配置已停用。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新失败");
    }
  };

  const deleteProfile = async (profile: LlmProfile) => {
    if (!window.confirm(`确认删除 LLM 配置“${profile.name}”？`)) return;
    try {
      await api.deleteLlmProfile(profile.id);
      setProfiles((current) => (current ?? []).filter((item) => item.id !== profile.id));
      setChecks((current) => { const next = { ...current }; delete next[profile.id]; return next; });
      setNotice("配置已删除。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    }
  };

  if (!profiles && !error) return <Spinner />;

  return (
    <div className="llm-settings-page">
      <div className="page-header header-row llm-page-header">
        <div>
          <div className="llm-eyebrow">MODEL CONTROL / DSH FLOW</div>
          <h1>模型</h1>
          <div className="sub">选择 API Key 或 ChatGPT 账户登录。订阅登录走 Codex 支持的账户通道，模型与额度以账户实际权限为准。</div>
        </div>
        <div className="header-actions">
          <button className="btn btn-ghost" onClick={() => reload().catch(() => undefined)}><RefreshCw />刷新</button>
          <button className="btn btn-primary" onClick={() => openEdit(KNOWN_PRESETS[0])}><Plus />添加配置</button>
        </div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}
      {notice ? <div className="llm-notice-bar">{notice}</div> : null}

      <CodexRuntimeSettings />
      <ChatGptAccountPanel onModelsChange={setAccountModels} onAccountChange={() => reload().catch(() => undefined)} />

      <section className="llm-card-list" aria-label="模型提供方">
        {cards.map(({ preset, profile }) => {
          const checked = profile ? checks[profile.id] : undefined;
          return (
            <article className={`llm-card ${profile?.id === editing?.id ? "active" : ""} ${profile ? "" : "empty"}`} key={preset.id}>
              <div className="llm-card-body">
                <span className="llm-card-mark">{preset.mark}</span>
                <div className="llm-card-info">
                  <div className="llm-card-title">
                    <span className={`llm-status-dot ${profile?.credentialConfigured ? "on" : "off"}`} />
                    <strong>{profile?.name ?? preset.label}</strong>
                  </div>
                  <small>{profile ? credentialLabel(profile) : `${preset.description} · 点击编辑填入密钥`}</small>
                </div>
              </div>
              <div className="llm-card-actions">
                {checked ? (
                  <span className={`llm-card-check ${checked.ok ? "ok" : "fail"}`}>
                    {checked.ok ? <CheckCircle2 /> : <CircleOff />}{checked.ok ? `${checked.latencyMs} ms` : "失败"}
                  </span>
                ) : null}
                {profile ? (
                  <button className="btn btn-sm" onClick={() => testProfile(profile)} disabled={testingId === profile.id}>
                    <Zap />{testingId === profile.id ? "测试中…" : "测试"}
                  </button>
                ) : null}
                <button className="btn btn-sm btn-ghost" onClick={() => openEdit(preset, profile)}><Pencil />编辑</button>
                {profile ? (
                  <button className="btn btn-sm btn-ghost btn-danger" aria-label={`删除 ${profile.name}`} onClick={() => deleteProfile(profile)}><Trash2 /></button>
                ) : null}
              </div>
            </article>
          );
        })}
      </section>

      {extras.length > 0 ? (
        <section className="llm-card-list llm-extra" aria-label="自定义配置">
          {extras.map((profile) => {
            const checked = checks[profile.id];
            return (
            <article className={`llm-card ${profile.id === editing?.id ? "active" : ""}`} key={profile.id}>
              <div className="llm-card-body">
                <span className="llm-card-mark">{presetFor(profile.provider)?.mark ?? "GW"}</span>
                <div className="llm-card-info">
                  <div className="llm-card-title">
                    <span className={`llm-status-dot ${profile.credentialConfigured ? "on" : "off"}`} />
                    <strong>{profile.name}</strong>
                  </div>
                  <small>{credentialLabel(profile)}</small>
                </div>
              </div>
              <div className="llm-card-actions">
                {checked ? (
                  <span className={`llm-card-check ${checked.ok ? "ok" : "fail"}`}>
                    {checked.ok ? <CheckCircle2 /> : <CircleOff />}{checked.ok ? `${checked.latencyMs} ms` : "失败"}
                  </span>
                ) : null}
                <button className="btn btn-sm" onClick={() => testProfile(profile)} disabled={testingId === profile.id}>
                  <Zap />{testingId === profile.id ? "测试中…" : "测试"}
                </button>
                <button className="btn btn-sm" onClick={() => openEdit(presetFor(profile.provider) ?? LLM_PROVIDER_PRESETS[6], profile)}><Pencil />编辑</button>
                <button className="btn btn-sm btn-ghost btn-danger" aria-label={`删除 ${profile.name}`} onClick={() => deleteProfile(profile)}><Trash2 /></button>
              </div>
            </article>
          );})}
        </section>
      ) : null}

      <div className="llm-add-row">
        <button className="llm-add-button" onClick={() => openEdit(KNOWN_PRESETS[0])}><Plus />添加提供方</button>
        <button className="llm-add-button" onClick={() => openEdit(LLM_PROVIDER_PRESETS.find((preset) => preset.id === "custom_gateway")!)}><Plus />添加自定义提供方</button>
      </div>

      {editing ? (
        <LlmEditModal
          initial={initialForm}
          accountModels={accountModels}
          title={editing.id === "new" ? `添加配置 · ${editing.preset.label}` : "编辑配置"}
          credentialConfigured={editing.credentialConfigured}
          saving={saving}
          onSave={submit}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

export function LlmEditModal(props: {
  accountModels: AccountModel[];
  initial: ProfileFormState;
  title: string;
  credentialConfigured: boolean;
  saving: boolean;
  onSave: (form: ProfileFormState) => boolean | Promise<boolean>;
  onClose: () => void;
}): ReactElement {
  const [form, setForm] = useState(props.initial);
  const selectedPreset = presetFor(form.provider);
  const chatgpt = form.authMode === "chatgpt";
  const apiDraft = useRef(props.initial.authMode === "chatgpt" ? formFromPreset(KNOWN_PRESETS[1]) : props.initial);
  const submitting = useRef(false);
  const setAuthMode = (authMode: "api-key" | "chatgpt") => {
    if (authMode === "chatgpt" && !chatgpt) apiDraft.current = form;
    const defaultModel = props.accountModels.find((item) => item.isDefault)?.model ?? props.accountModels[0]?.model ?? "";
    setForm((current) => authMode === "chatgpt" ? { ...current, authMode, provider: "openai", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "", apiKeyEnv: "", modelsText: props.accountModels.map((item) => item.model).join("\n"), defaultModel, name: "ChatGPT 账户配置" } : { ...apiDraft.current, authMode });
  };
  const supportsDeepSeekThinking = form.protocol === "openai-chat"
    && (selectedPreset?.id === "deepseek" || form.baseUrl.toLocaleLowerCase().includes("deepseek.com"));

  const applyProvider = (preset: LlmProviderPreset) => {
    setForm((current) => ({
      ...current,
      provider: preset.id,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      apiKeyEnv: preset.apiKeyEnv,
      modelsText: preset.models.join("\n"),
      defaultModel: preset.defaultModel,
      reasoningEffort: preset.reasoningEffort,
      name: selectedPreset && current.name === `${selectedPreset.label} 默认配置` ? `${preset.label} 默认配置` : current.name,
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (props.saving || submitting.current) return;
    submitting.current = true;
    try { await props.onSave(chatgpt ? { ...form, modelsText: props.accountModels.map((item) => item.model).join("\n") } : form); }
    finally { submitting.current = false; }
  };

  return (
    <Modal title={props.title} onClose={props.onClose} width={580}>
      <form className="llm-inline-form llm-edit-form" onSubmit={submit}>
        <fieldset className="llm-auth-choice">
          <legend>认证方式</legend>
          <label><input type="radio" name="auth-mode" checked={!chatgpt} onChange={() => setAuthMode("api-key")} /> API Key</label>
          <label><input type="radio" name="auth-mode" checked={chatgpt} onChange={() => setAuthMode("chatgpt")} /> ChatGPT 登录</label>
        </fieldset>
        {chatgpt ? <p className="llm-cred-hint">在账户面板中完成官方登录，然后刷新可用模型。这里不收集密码、访问令牌或 API Key；保存配置不会开始授权。</p> : <>

        <div className="llm-form-section-head">
          <span>01</span>
          <div><strong>选择供应商</strong><small>选择后自动填充推荐参数</small></div>
        </div>
        <div className="llm-provider-deck" role="radiogroup" aria-label="模型供应商">
          {LLM_PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selectedPreset?.id === preset.id}
              className={selectedPreset?.id === preset.id ? "active" : ""}
              onClick={() => applyProvider(preset)}
            >
              <span className="llm-provider-mark sm">{preset.mark}</span>
              <span className="llm-provider-meta"><strong>{preset.label}</strong><small>{preset.description}</small></span>
              {selectedPreset?.id === preset.id ? <span className="llm-provider-check"><Check /></span> : null}
            </button>
          ))}
        </div>

        <div className="llm-form-section-head compact">
          <span>02</span>
          <div><strong>凭据</strong><small>填入 API 密钥即可使用其模型</small></div>
        </div>
        <div className="form-grid llm-inline-grid">
          <Field label="API 密钥" wide>
            <input
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              placeholder={props.credentialConfigured ? "已配置，输入新密钥可覆盖" : "粘贴 API Key"}
            />
          </Field>
        </div>
        {props.credentialConfigured
          ? <div className="llm-cred-hint"><ShieldCheck />已配置密钥，留空则保持不变；密钥加密存储，接口与审计永不返回明文。</div>
          : <div className="llm-secret-note"><ShieldCheck /><span>密钥加密存储，接口与审计永不返回明文。</span></div>}

        </>}
        <div className="llm-form-section-head compact">
          <span>03</span>
          <div><strong>基础配置</strong><small>完成运行所需的最少信息</small></div>
        </div>
        <div className="form-grid llm-inline-grid">
          <Field label="配置名称"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="如：DeepSeek 默认配置" /></Field>
          <Field label="默认模型">{chatgpt ? <select required value={form.defaultModel} onChange={(event) => setForm({ ...form, defaultModel: event.target.value })}>
            <option value="">请先登录并刷新模型</option>
            {form.defaultModel && !props.accountModels.some((item) => item.model === form.defaultModel) ? <option value={form.defaultModel} disabled>{form.defaultModel}（当前未验证）</option> : null}
            {props.accountModels.map((item) => <option key={item.id} value={item.model}>{item.displayName || item.model}</option>)}
          </select> : <input required value={form.defaultModel} onChange={(event) => setForm({ ...form, defaultModel: event.target.value })} placeholder="如：deepseek-v4-flash" />}</Field>
          <Field label="运行状态"><select value={form.enabled ? "enabled" : "disabled"} onChange={(event) => setForm({ ...form, enabled: event.target.value === "enabled" })}><option value="enabled">启用</option><option value="disabled">停用</option></select></Field>
          {!chatgpt ? <Field label="DeepSeek 思考等级">
            <select
              value={form.reasoningEffort}
              disabled={!supportsDeepSeekThinking}
              onChange={(event) => setForm({ ...form, reasoningEffort: event.target.value as LlmReasoningEffort })}
            >
              {LLM_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{REASONING_EFFORT_LABELS[effort]}</option>)}
            </select>
          </Field>
          : null}
          {!chatgpt ? <Field label="环境变量名（可选回退）"><input value={form.apiKeyEnv} onChange={(event) => setForm({ ...form, apiKeyEnv: event.target.value.toUpperCase() })} placeholder="DEEPSEEK_API_KEY" /></Field> : null}
        </div>

        {!chatgpt ? <details className="llm-advanced-fields">
          <summary><span><ServerCog />高级参数</span><small>协议、服务地址、超时与候选模型</small><ChevronDown /></summary>
          <div className="form-grid llm-advanced-grid">
            <Field label="模型协议">
              <select value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value as LlmProtocol })}>
                {LLM_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{PROTOCOL_LABELS[protocol]}</option>)}
              </select>
            </Field>
            <Field label="单次模型请求超时（毫秒）"><input type="number" min={1000} max={120000} step={1000} required value={form.timeoutMs} onChange={(event) => setForm({ ...form, timeoutMs: Number(event.target.value) })} /></Field>
            <Field label="Base URL" wide><input type="url" required value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></Field>
            <Field label="模型列表（每行一个）" wide><textarea required rows={5} value={form.modelsText} onChange={(event) => setForm({ ...form, modelsText: event.target.value })} placeholder={"deepseek-v4-flash"} /></Field>
          </div>
        </details> : <p className="cell-sub">候选模型来自当前 Codex 账户通道；列出模型不保证当前订阅或剩余额度允许执行。</p>}

        <div className="llm-edit-actions">
          <button type="button" className="btn" onClick={props.onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={props.saving || (chatgpt && !props.accountModels.some((item) => item.model === form.defaultModel))}><Save />{props.saving ? "保存中…" : "保存配置"}</button>
        </div>
      </form>
    </Modal>
  );
}
