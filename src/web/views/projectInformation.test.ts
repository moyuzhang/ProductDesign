import { describe, expect, it } from "vitest";
import type { DesignDoc } from "../../shared/types";
import { administratorNextStep, groupDesignDocuments, projectPurpose } from "./projectInformation";

function document(category: DesignDoc["category"], title: string): DesignDoc {
  return {
    id: title,
    projectId: "project-one",
    currentRevisionId: "revision-one",
    category,
    title,
    summary: "",
    status: "已批准",
    version: "v1",
    author: "tester",
    sourceUrl: "",
    content: "",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("project administrator information", () => {
  it("does not present an imported or empty summary as a formal project purpose", () => {
    expect(projectPurpose({ summary: "扫描到的仓库", unconfigured: true })).toEqual({ text: "待补充", needsBrief: true });
    expect(projectPurpose({ summary: "自动导入：Node.js 项目", unconfigured: false })).toEqual({ text: "待补充", needsBrief: true });
    expect(projectPurpose({ summary: "  ", unconfigured: false })).toEqual({ text: "待补充", needsBrief: true });
    expect(projectPurpose({ summary: "统一管理产品设计交付", unconfigured: false })).toEqual({ text: "统一管理产品设计交付", needsBrief: false });
  });

  it("does not let a referenced requirement document override the project summary placeholder rule", () => {
    const older = document("需求文档", "旧简报");
    older.summary = "旧项目用途";
    older.updatedAt = "2026-09-01T00:00:00.000Z";
    const current = document("需求文档", "管理者简报");
    current.summary = "面向管理员的正式系统用途";
    current.updatedAt = "2026-09-02T00:00:00.000Z";

    expect(projectPurpose({ summary: "自动导入：Node.js 项目", unconfigured: false }))
      .toEqual({ text: "待补充", needsBrief: true });
    expect([older, current]).toHaveLength(2);
  });

  it("provides a deterministic administrator fallback", () => {
    expect(administratorNextStep({ nextStep: "批准项目简报" })).toBe("批准项目简报");
    expect(administratorNextStep({ nextStep: "" })).toContain("推进流程");
  });
});

describe("document information architecture", () => {
  it("groups every document category into the approved hierarchy", () => {
    const groups = groupDesignDocuments([
      document("验收文档", "验收"),
      document("需求文档", "简报"),
      document("其他", "补充"),
      document("接口文档", "接口"),
      document("功能说明", "功能"),
      document("测试报告", "测试"),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["项目与需求", "模块与技术设计", "测试与验收", "其他资料"]);
    expect(groups.map((group) => group.items.map((item) => item.title))).toEqual([
      ["简报"],
      ["接口", "功能"],
      ["验收", "测试"],
      ["补充"],
    ]);
  });
});
