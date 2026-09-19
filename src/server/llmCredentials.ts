import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmProfile } from "../shared/types.js";

interface StoredCredential {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface CredentialFile {
  version: 1;
  entries: Record<string, StoredCredential>;
}

function maskCredential(value: string): string {
  return value ? `••••${value.slice(-4)}` : "";
}

export class LlmCredentialVault {
  private readonly keyPath: string;
  private readonly credentialsPath: string;

  constructor(private readonly dataDir: string) {
    this.keyPath = join(dataDir, "llm-credentials.key");
    this.credentialsPath = join(dataDir, "llm-credentials.json");
  }

  resolve(profile: LlmProfile): string | undefined {
    return this.read(profile.id) ?? (process.env[profile.apiKeyEnv]?.trim() || undefined);
  }

  describe(profile: LlmProfile): LlmProfile {
    const stored = this.read(profile.id);
    const environment = process.env[profile.apiKeyEnv]?.trim();
    const credential = stored || environment || "";
    return {
      ...profile,
      credentialConfigured: Boolean(credential),
      credentialMasked: maskCredential(credential),
      credentialSource: stored ? "stored" : environment ? "environment" : "missing",
    };
  }

  set(profileId: string, apiKey: string): void {
    const value = apiKey.trim();
    if (!value) throw new Error("API Key 不能为空");
    const key = this.loadOrCreateKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const file = this.loadFile();
    file.entries[profileId] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64"),
    };
    this.saveFile(file);
  }

  clear(profileId: string): void {
    const file = this.loadFile();
    if (!(profileId in file.entries)) return;
    delete file.entries[profileId];
    this.saveFile(file);
  }

  private read(profileId: string): string | undefined {
    const stored = this.loadFile().entries[profileId];
    if (!stored) return undefined;
    if (!existsSync(this.keyPath)) throw new Error("LLM 凭据密钥文件缺失，无法解密已保存凭据");
    const key = Buffer.from(readFileSync(this.keyPath, "utf8").trim(), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64"));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(stored.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  private loadOrCreateKey(): Buffer {
    mkdirSync(this.dataDir, { recursive: true });
    if (!existsSync(this.keyPath)) {
      writeFileSync(this.keyPath, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
      this.restrict(this.keyPath);
    }
    const key = Buffer.from(readFileSync(this.keyPath, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error("LLM 凭据密钥文件无效");
    return key;
  }

  private loadFile(): CredentialFile {
    if (!existsSync(this.credentialsPath)) return { version: 1, entries: {} };
    const parsed = JSON.parse(readFileSync(this.credentialsPath, "utf8")) as CredentialFile;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      throw new Error("LLM 凭据文件格式无效");
    }
    return parsed;
  }

  private saveFile(file: CredentialFile): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.credentialsPath, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
    this.restrict(this.credentialsPath);
  }

  private restrict(path: string): void {
    try { chmodSync(path, 0o600); } catch { /* Windows ACL is inherited from the user data directory. */ }
  }
}
