import type { Project, ProjectWorkflow, ProjectWorkflowPhase, ProjectWorkspace } from "../shared/types.js";
import type { Store } from "./db.js";
import { buildProjectWorkflow, loadWorkflowProjectData } from "./workflow.js";

export function projectStageForWorkflowPhase(
  phase: ProjectWorkflowPhase,
  persistedStage: Project["stage"],
): Project["stage"] {
  switch (phase) {
    case "discovery":
      return "探索";
    case "functional-design":
    case "node-definition":
    case "requirement-review":
    case "detailed-design":
      return "设计";
    case "planning":
      return "规划";
    case "development":
      return "开发";
    case "verification":
    case "acceptance":
      return "测试";
    case "completed":
      return persistedStage === "维护" ? "维护" : "交付";
  }
}

/** Public project projection. The workflow's earliest unmet gate is authoritative for stage and next step. */
export function getProjectedProjectWorkspace(
  store: Store,
  projectId: string,
  workflow?: ProjectWorkflow,
): ProjectWorkspace | undefined {
  const data = loadWorkflowProjectData(store, projectId);
  if (!data) return undefined;
  const resolvedWorkflow = workflow ?? buildProjectWorkflow(store, projectId, data);
  const workspace = store.getProjectWorkspace(projectId, data);
  if (!workspace || !resolvedWorkflow) return workspace;
  return {
    ...workspace,
    project: {
      ...workspace.project,
      stage: projectStageForWorkflowPhase(resolvedWorkflow.phase, workspace.project.stage),
      nextStep: resolvedWorkflow.nextAction?.title ?? "项目所有交付节点均已完成开发、证据归档和验收",
    },
  };
}

export function listProjectedProjects(store: Store, projects: Project[] = store.listProjects()): Project[] {
  return projects.map((project) => {
    const data = loadWorkflowProjectData(store, project.id, { project });
    if (!data) return project;
    const workflow = buildProjectWorkflow(store, project.id, data);
    const derived = store.getProjectWorkspaceProject(project.id, data);
    if (!workflow || !derived) return project;
    return {
      ...derived,
      stage: projectStageForWorkflowPhase(workflow.phase, derived.stage),
      nextStep: workflow.nextAction?.title ?? "项目所有交付节点均已完成开发、证据归档和验收",
    };
  });
}
