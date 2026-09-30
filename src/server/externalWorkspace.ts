import { z } from "zod";
import { posix, win32 } from "node:path";
import type { ExternalWorkspaceBinding } from "../shared/types.js";

export const externalWorkspaceSchema = z.object({
  repositoryId: z.string().trim().min(1).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/),
  workspaceId: z.string().trim().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/),
  workspacePath: z.string().trim().min(1).max(2000).refine((value) =>
    !/[\x00-\x1f]/.test(value) && (posix.isAbsolute(value) || win32.isAbsolute(value)), "外部工作区必须是绝对路径"),
  workspaceBranch: z.string().trim().min(1).max(500).refine((value) => !/[\x00-\x1f]/.test(value)),
  baselineRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
}).strict();

export function sameExternalWorkspace(left: ExternalWorkspaceBinding | undefined, right: ExternalWorkspaceBinding | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
