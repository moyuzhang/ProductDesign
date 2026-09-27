import { useEffect, type ReactElement } from "react";
import {
  ArrowRight,
  BookOpenCheck,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  GitBranch,
  ShieldCheck,
  Users,
} from "lucide-react";

const GOVERNANCE_STEPS = [
  "了解项目",
  "项目简报",
  "系统主画布",
  "模块/功能节点",
  "节点定义与验收标准",
  "需求批准",
  "详细设计",
  "开发计划",
  "开发",
  "测试证据",
  "验收",
];

const MCP_CONFIG = `{
  "mcpServers": {
    "productdesign": {
      "type": "http",
      "url": "http://127.0.0.1:4310/mcp"
    }
  }
}`;

const MCP_HANDSHAKE = [
  ["service_health", "确认 MCP 服务和数据库可用"],
  ["get_control_capabilities", "读取当前可用的业务工具"],
  ["list_projects", "定位 project code 或 id"],
  ["get_project_workflow", "读取阶段、缺失门禁和唯一下一步"],
  ["get_agent_orchestration", "读取双线路队列、容量、资源锁与任务蓝图"],
] as const;

export function SystemGuideView(): ReactElement {
  useEffect(() => {
    if (window.location.hash.includes("section=agent-mcp")) {
      const frame = window.requestAnimationFrame(() => {
        document.getElementById("agent-mcp")?.scrollIntoView({ block: "start" });
      });
      return () => window.cancelAnimationFrame(frame);
    }
  });
  const revealAgentMcp = () => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      document.getElementById("agent-mcp")?.scrollIntoView({ block: "start" });
    }));
  };
  return (
    <div className="system-guide-page">
      <header className="system-guide-hero">
        <div>
          <span className="system-guide-eyebrow">SYSTEM GUIDE · ADMINISTRATOR ENTRY</span>
          <h1>先看懂系统，再推进交付</h1>
          <p>
            ProductDesign 是本地优先的产品设计与交付控制台。它把项目简报、系统画布、功能定义、开发计划、测试证据和最终验收连接成一条可审计的治理链。
          </p>
          <div className="system-guide-actions">
            <a className="btn btn-primary" href="#/projects">进入项目管理 <ArrowRight size={14} /></a>
            <a className="btn" href="#/design">查看设计中枢</a>
            <a className="btn" href="#/guide?section=agent-mcp" onClick={revealAgentMcp}>查看 Agent MCP 接入</a>
          </div>
        </div>
        <div className="system-guide-purpose" aria-label="系统用途">
          <BookOpenCheck />
          <strong>系统解决什么问题</strong>
          <span>让“为什么做、做什么、谁负责、如何验证、谁批准”在同一个项目上下文中可追溯。</span>
        </div>
      </header>

      <section className="system-guide-section">
        <div className="system-guide-section-title">
          <span>01</span>
          <div><h2>角色与职责边界</h2><p>不同角色负责不同判断，不能用一个身份包办整条交付链。</p></div>
        </div>
        <div className="system-guide-role-grid">
          <article><Users /><h3>管理员</h3><p>维护项目目标与关键约束，仅处理 human-only 高风险执行授权。</p></article>
          <article><Bot /><h3>Designer</h3><p>把需求转成可定位的节点定义、详细设计和验收标准，不写实现代码。</p></article>
          <article><GitBranch /><h3>Builder</h3><p>按已批准计划施工，提交真实实现、测试结果和实现修订，不进行自审。</p></article>
          <article><ClipboardCheck /><h3>Auditor</h3><p>独立复核实现与证据，给出审计结论；Main Agent 依据报告和证据执行最终验收。</p></article>
        </div>
      </section>

      <section className="system-guide-section">
        <div className="system-guide-section-title">
          <span>02</span>
          <div><h2>标准治理流程</h2><p>画布功能节点是交付状态的唯一来源，流程图和自由白板只表达设计。</p></div>
        </div>
        <ol className="system-guide-flow">
          {GOVERNANCE_STEPS.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, "0")}</span><strong>{step}</strong></li>)}
        </ol>
      </section>

      <section className="system-guide-section system-guide-admin-section">
        <div className="system-guide-section-title">
          <span>03</span>
          <div><h2>管理员日常怎么用</h2><p>日常交付由主 Agent 自动推进；这里只处理被明确标记为 human-only 的高风险例外。</p></div>
        </div>
        <div className="system-guide-checklist">
          <div><CheckCircle2 /><span><strong>确认项目用途</strong>：自动导入只登记项目；“待补充”表示仍需正式项目简报。</span></div>
          <div><CheckCircle2 /><span><strong>处理唯一下一步</strong>：进入推进流程，先补当前缺失门禁，再开始后续动作。</span></div>
          <div><CheckCircle2 /><span><strong>审阅交付依据</strong>：需求与设计先批准，开发完成后检查独立测试证据。</span></div>
          <div><CheckCircle2 /><span><strong>处理例外</strong>：常规审计通过后由 Main Agent 验收；高风险执行授权交给管理员；证据矛盾由 Main Agent 退回补齐。</span></div>
        </div>
      </section>

      <section className="system-guide-section system-guide-agent-section" id="agent-mcp">
        <div className="system-guide-section-title">
          <span>04</span>
          <div>
            <h2>Agent MCP 接入、双线路编排与工作流程</h2>
            <p>外部主 Agent 负责编排执行 Agent；ProductDesign 提供任务、租约、门禁、资源锁和证据契约，但不在页面内启动 Agent。</p>
          </div>
        </div>

        <div className="system-guide-mcp-grid">
          <article className="system-guide-panel">
            <span className="system-guide-panel-kicker">MCP ENDPOINT</span>
            <h3>1. 配置连接</h3>
            <p>默认 HTTP 地址：<code>http://127.0.0.1:4310/mcp</code></p>
            <pre aria-label="ProductDesign MCP 最小配置"><code>{MCP_CONFIG}</code></pre>
          </article>
          <article className="system-guide-panel">
            <span className="system-guide-panel-kicker">FIRST HANDSHAKE</span>
            <h3>2. 首次握手</h3>
            <ol className="system-guide-command-list">
              {MCP_HANDSHAKE.map(([tool, description]) => <li key={tool}><code>{tool}</code><span>{description}</span></li>)}
            </ol>
          </article>
        </div>

        <article className="system-guide-panel system-guide-orchestrator">
          <span className="system-guide-panel-kicker">MAIN AGENT</span>
          <h3>3. 主 Agent 只负责编排</h3>
          <div className="system-guide-rule-grid">
            <p><strong>读取与派发</strong><span>每个动作前后读取 <code>get_project_workflow</code>，按 <code>activeSlots</code>、<code>roleSlots</code>、交付层和资源锁创建有限执行 Agent；队列条数不等于并发数。</span></p>
            <p><strong>租约与身份</strong><span>Main Agent 先领取父协调租约并派发精确任务；子 Agent 只能凭一次性 <code>dispatchId</code> 领取自己的子租约，禁止自行调用 <code>claim_next_agent_task</code>。</span></p>
            <p><strong>工单提交</strong><span>每个 Designer、Builder 和 Auditor 都必须提交与本人任务绑定的工单，写明 taskKey、taskRevision、实际产出或证据；未提交工单不得交接或宣告完成。</span></p>
            <p><strong>交接与证据</strong><span>保留 taskKey、taskRevision、关联 ID、sessionId、runId、修订和 evidenceId；旧修订与旧证据只失效，不删除。</span></p>
            <p><strong>审批边界</strong><span>主 Agent 使用独立 <code>approval</code> 租约审批，不能复用 Designer、Builder 或 Auditor 身份；<code>managerApproval</code> 始终交给人类。</span></p>
          </div>
        </article>

        <div className="system-guide-track-grid" aria-label="两条 Agent 交付线路">
          <article className="system-guide-track system-guide-track-design">
            <header><span>TRACK 01 · DESIGN</span><h3>设计交付闭环</h3><p>生产者是 Designer，审计对象是固定的 <code>documentRevisionIds</code>。</p></header>
            <ol>
              <li><strong>Main Agent</strong><span>创建 Designer 并交付设计任务包</span></li>
              <li><strong>Designer</strong><span>完成节点定义、验收标准、详细设计和计划，提交固定修订</span></li>
              <li><strong>Main Agent</strong><span>等待 Designer 完成并释放执行槽</span></li>
              <li><strong>Design Auditor</strong><span>由不同 workerId 只读审核当前固定修订</span></li>
              <li><strong>审计失败</strong><span>只回 Designer 返工，产生新文档修订后重新审计</span></li>
              <li><strong>审计通过</strong><span>Main Agent 领取独立 approval 工单，审核计划并批准开工；Auditor 不直接批准</span></li>
            </ol>
          </article>
          <article className="system-guide-track system-guide-track-code">
            <header><span>TRACK 02 · IMPLEMENTATION</span><h3>编码交付闭环</h3><p>生产者是 Builder；Builder 完成的是<strong>编码/施工</strong>，不是设计。</p></header>
            <ol>
              <li><strong>Main Agent</strong><span>在设计审计和计划审核通过后批准开工并创建 Builder</span></li>
              <li><strong>Builder</strong><span>在隔离工作区编码、运行开发者测试并提交 implementationRevision</span></li>
              <li><strong>Main Agent</strong><span>等待 Builder 完成并释放执行槽</span></li>
              <li><strong>Implementation Auditor</strong><span>由不同 workerId 独立复测当前实现修订</span></li>
              <li><strong>审计失败</strong><span>只回 Builder 返工，产生新实现修订后重新审计</span></li>
              <li><strong>审计通过</strong><span>Main Agent 核验证据并批准验收，随后继续领取下一任务；Auditor 不直接验收</span></li>
            </ol>
          </article>
        </div>

        <div className="system-guide-agent-role-grid">
          <article className="system-guide-panel"><h3>Designer</h3><p><strong>任务：</strong>定义行为、边界、状态、失败处理、验收标准和开发计划。</p><p><strong>产出：</strong>不可变设计修订、节点定义、数据库绑定和风险说明。</p><p><strong>禁止：</strong>写业务代码、自审、自批、覆盖旧修订。</p><p><strong>工具：</strong><code>get_design_doc</code> <code>create_design_doc</code> <code>patch_design_doc</code> <code>create_plan_item_full</code> <code>transition_plan_delivery</code></p></article>
          <article className="system-guide-panel"><h3>Builder</h3><p><strong>任务：</strong>按 Main Agent 批准的固定基线编码、处理数据库变更并运行开发者测试。</p><p><strong>产出：</strong>代码、命令结果、变更摘要、implementationRevision 和 evidenceId。</p><p><strong>禁止：</strong>改需求/设计/验收标准、自审、把构建成功冒充测试通过。</p><p><strong>工具：</strong><code>get_plan_item</code> <code>get_design_doc</code> <code>create_evidence</code> <code>patch_plan_item</code> <code>transition_plan_delivery</code></p></article>
          <article className="system-guide-panel"><h3>Auditor（按 auditScope）</h3><p><strong>design：</strong>核验需求覆盖、异常路径、一致性、安全、可实施性和可验证性。</p><p><strong>implementation：</strong>复核实现差异，独立运行测试并逐条核验验收标准。</p><p><strong>禁止：</strong>与 producerWorkerId 相同、修改被审计产物、代替管理员批准。</p><p><strong>工具：</strong><code>list_evidence</code> <code>create_evidence</code> <code>transition_plan_delivery</code></p><p><strong>设计审计动作：</strong><code>transition_plan_delivery(action=pass_design_audit|fail_design_audit)</code></p><p><strong>实现审计动作：</strong><code>transition_plan_delivery(action=pass_audit|fail_audit)</code></p></article>
        </div>

        <article className="system-guide-panel system-guide-lifecycle">
          <span className="system-guide-panel-kicker">TASK LIFECYCLE</span>
          <h3>4. 每个执行任务都遵循同一租约流程</h3>
          <ol>
            <li><code>get_project_workflow</code> 读取当前门禁</li>
            <li><code>get_agent_orchestration</code> 读取队列、容量和交付层</li>
            <li>Main Agent：已有计划用 <code>planId</code>，无计划设计任务用精确 <code>taskKey + taskRevision</code> 领取父租约 → 派发子任务；任务型完成后自动释放，不推进计划阶段</li>
            <li>子 Agent：<code>claim_dispatched_child_task</code>（一次性 <code>dispatchId</code>）</li>
            <li>校验 deliveryTrack、auditScope、taskKey、taskRevision、workScopes、leaseToken 和当前修订</li>
            <li>每个 Designer、Builder 和 Auditor 提交与本人任务绑定的工单；未提交不得交接或完成</li>
            <li><code>start_agent_task</code> 启动；并发 Builder 提交隔离工作区与基线</li>
            <li><code>heartbeat_agent_task</code> 定期续租</li>
            <li><code>create_evidence</code> 绑定当前 documentRevisionId 或 implementationRevision</li>
            <li><code>transition_plan_delivery</code> 推进；失败按线路回到原生产角色</li>
            <li><code>release_agent_task</code> 主动停止；遇到 LEASE_LOST、TASK_ALREADY_CLAIMED、ASSIGNEE_MISMATCH 或 SELF_AUDIT_FORBIDDEN 立即停止写入</li>
            <li>重新读取 workflow；Main Agent 完成 approval 后继续领取下一任务，只有 human-only 高风险事项交给人类</li>
          </ol>
        </article>

        <div className="system-guide-status-row" aria-label="Agent 编排能力状态">
          <span><CheckCircle2 />已实现：双线路任务包、设计/实现审计、返工、修订失效、租约与自审隔离</span>
          <span><CheckCircle2 />待实现：无</span>
          <span><Users />人工门禁：仅 human-only 高风险执行授权</span>
        </div>
      </section>

      <section className="system-guide-boundary">
        <ShieldCheck />
        <div>
          <span>KEY BOUNDARIES</span>
          <h2>关键边界</h2>
          <p>项目简报之前不编码；功能节点之前不先建目标数据模型；没有批准的需求、设计、节点文档、负责人、验收标准和计划不得开发；没有完整计划、通过证据和最新文档不得验收。</p>
        </div>
      </section>
    </div>
  );
}
