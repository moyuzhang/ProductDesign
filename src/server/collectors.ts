import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { EvidenceSource } from "../shared/types.js";

const execFileAsync = promisify(execFile);

export interface CollectedEvidenceInput {
  sourceType: EvidenceSource;
  sourcePath: string;
  command: string;
  resultStatus: "pass" | "warn" | "fail" | "info";
  summary: string;
  details: Record<string, unknown>;
  commitSha: string;
  digest: string;
}

function digestOf(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

async function git(path: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", path, ...args], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Read-only evidence collection from a local git repository.
 */
export async function collectGitEvidence(repositoryPath: string): Promise<CollectedEvidenceInput> {
  try {
    const [branch, logLine, statusOut] = await Promise.all([
      git(repositoryPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(repositoryPath, ["log", "-1", "--pretty=format:%H%x1f%s%x1f%cI"]),
      git(repositoryPath, ["status", "--porcelain"]),
    ]);
    const [commitSha, subject, commitDate] = logLine.split("\x1f");
    const dirtyCount = statusOut ? statusOut.split("\n").length : 0;
    const details = {
      branch,
      commitSha,
      subject: subject ?? "",
      commitDate: commitDate ?? "",
      dirtyFiles: dirtyCount,
    };
    return {
      sourceType: "git" satisfies EvidenceSource,
      sourcePath: repositoryPath,
      command: 'git log -1 / git status --porcelain',
      resultStatus: "info",
      summary: `${branch}@${(commitSha ?? "").slice(0, 7)} ${subject ?? ""}${dirtyCount > 0 ? `（${dirtyCount} 个未提交变更）` : "（工作区干净）"}`,
      details,
      commitSha: commitSha ?? "",
      digest: digestOf(details),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = { error: message.slice(0, 500) };
    return {
      sourceType: "git",
      sourcePath: repositoryPath,
      command: "git log -1 / git status --porcelain",
      resultStatus: repositoryPath ? "warn" : "fail",
      summary: `采集失败：${message.split("\n")[0]?.slice(0, 120) ?? "未知错误"}`,
      details,
      commitSha: "",
      digest: digestOf(details),
    };
  }
}
