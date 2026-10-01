import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function codexCommand(): { executable: string; prefix: string[] } {
  const configured = process.env.PCS_CODEX_BIN?.trim();
  if (configured) return { executable: configured, prefix: [] };
  if (process.platform !== "win32") return { executable: "codex", prefix: [] };
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const root = join(localAppData, "OpenAI", "Codex", "bin");
    if (existsSync(root)) {
      const candidates = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name, "codex.exe"))
        .filter(existsSync)
        .sort()
        .reverse();
      if (candidates[0]) return { executable: candidates[0], prefix: [] };
    }
  }
  return { executable: process.env.ComSpec || "cmd.exe", prefix: ["/d", "/s", "/c", "codex"] };
}

export function chatgptCodexHome(dataDir: string): string { return join(dataDir, "codex-chatgpt"); }
export function chatgptCodexEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  // Subscription mode must never accidentally bill an inherited API credential.
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"]) delete env[key];
  return env;
}
