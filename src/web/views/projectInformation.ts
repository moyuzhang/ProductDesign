import type { DesignDoc, DesignDocCategory, Project } from "../../shared/types";

export interface ProjectPurpose {
  text: string;
  needsBrief: boolean;
}

export interface DocumentGroup {
  key: "project" | "technical" | "acceptance" | "other";
  label: string;
  description: string;
  items: DesignDoc[];
}

const DOCUMENT_GROUPS: ReadonlyArray<Omit<DocumentGroup, "items"> & { categories: readonly DesignDocCategory[] }> = [
  {
    key: "project",
    label: "项目与需求",
    description: "说明项目目标、范围、约束与需求基线。",
    categories: ["需求文档"],
  },
  {
    key: "technical",
    label: "模块与技术设计",
    description: "说明功能行为、模块边界和接口约定。",
    categories: ["功能说明", "接口文档"],
  },
  {
    key: "acceptance",
    label: "测试与验收",
    description: "记录验证结果、测试结论与验收依据。",
    categories: ["测试报告", "验收文档"],
  },
  {
    key: "other",
    label: "其他资料",
    description: "收纳未归入交付主链的补充材料。",
    categories: ["其他"],
  },
];

export function projectPurpose(project: Pick<Project, "summary" | "unconfigured">): ProjectPurpose {
  const summary = project.summary.trim();
  const importedPlaceholder = /^自动导入[：:]/.test(summary);
  if (project.unconfigured || !summary || importedPlaceholder) return { text: "待补充", needsBrief: true };
  return { text: summary, needsBrief: false };
}

export function administratorNextStep(project: Pick<Project, "nextStep">): string {
  return project.nextStep.trim() || "打开“推进流程”，处理当前缺失门禁。";
}

export function groupDesignDocuments(documents: readonly DesignDoc[]): DocumentGroup[] {
  return DOCUMENT_GROUPS.map(({ categories, ...group }) => ({
    ...group,
    items: documents.filter((document) => categories.includes(document.category)),
  }));
}
