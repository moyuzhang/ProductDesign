import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("../web", import.meta.url));
const INSTANT_FIELD = "createdAt|updatedAt|generatedAt|expiresAt|collectedAt|deliveryUpdatedAt|submittedAt|approvedAt|completedAt|auditedAt|managerDecisionAt|revokedAt|claimedAt|leaseExpiresAt|lastSeenAt";
const LOCAL_TIME_API = /\.(?:toLocaleString|toLocaleTimeString|toLocaleDateString)\s*\(/g;
const DIRECT_INSTANT_TRUNCATION = new RegExp(`\\b(?:${INSTANT_FIELD})\\s*(?:\\?\\.|\\.)\\s*(?:slice|substring|substr|replace)\\s*\\(`, "g");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function timePolicyViolations(source: string, path: string): string[] {
  const violations: string[] = [];
  for (const pattern of [LOCAL_TIME_API, DIRECT_INSTANT_TRUNCATION]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const offset = match.index ?? 0;
      const before = source.slice(0, offset);
      const line = before.split(/\r?\n/).length;
      const lastBreak = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
      const column = offset - lastBreak;
      violations.push(`${path}:${line}:${column}: ${match[0].replace(/\s+/g, " ").trim()}`);
    }
  }
  return violations;
}

describe("Web instant-time formatting policy", () => {
  it("catches an instant string truncated through a line-wrapped chain", () => {
    const probe = `const display = item.createdAt\n  .slice(0, 10);`;
    expect(timePolicyViolations(probe, "multiline-probe.ts")).toEqual([
      expect.stringContaining("multiline-probe.ts:1:"),
    ]);
  });

  it("allows shared display formatters, business dates, and UTC sorting", () => {
    const valid = `
      formatDateTime(item.createdAt);
      formatDate(item.startAt);
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    `;
    expect(timePolicyViolations(valid, "valid-probe.ts")).toEqual([]);
  });

  it("does not depend on the device timezone or truncate UTC instant strings", () => {
    const violations = sourceFiles(WEB_ROOT)
      .flatMap((path) => timePolicyViolations(readFileSync(path, "utf8"), path));
    expect(violations).toEqual([]);
  });
});
