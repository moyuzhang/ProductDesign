export const OPEN_DESIGN_ASSISTANT = "productdesign:open-design-assistant";
export interface DesignAssistantRequest { projectId: string; goal: string }
export function designRequestText(goal: string): string {
  return `请作为产品设计助手处理这个目标：${goal.trim() || "请先和我澄清项目目标"}。\n先读取当前项目资料，澄清需求和约束，再用本应用的设计文档与设计工具形成可审阅的方案，检查一致性、边界和遗漏，最后交给我确认。不要编写目标项目代码、执行命令或启动开发任务。`;
}
export function openDesignAssistant(request: DesignAssistantRequest): void {
  window.dispatchEvent(new CustomEvent<DesignAssistantRequest>(OPEN_DESIGN_ASSISTANT, { detail: request }));
}
