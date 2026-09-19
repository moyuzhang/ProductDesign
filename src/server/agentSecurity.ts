import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Store } from "./db.js";

export const AGENT_POLICY_VERSION = "2.3.0";
export const AGENT_POLICY_INSTRUCTIONS = `ProductDesign Agent policy ${AGENT_POLICY_VERSION}
Every Agent must claim an exact work order before controlled writes. Credential-enrolled Agents must also authenticate and acknowledge this exact policy version.
Lease-only local sequence: get_agent_task_package/claim_next_agent_task（任务包内含项目、节点、计划、文档、工作流摘要和租约）-> start_agent_task -> heartbeat_agent_task -> controlled writes -> evidence -> complete transition；仅在终态动作或租约/修订错误后刷新 get_project_workflow。
Credential-enrolled sequence adds begin_agent_auth -> complete_agent_auth -> ack_agent_policy -> issue_agent_write_nonce before each controlled write. Credential registration is human-admin-only.
For every nonce use action=mcp.<toolName>, target=mcp:<toolName>, and the SHA-256 bodyDigest documented by that tool; every write consumes a new nonce.
agent_task_leases.id is workOrderId. Every controlled write must carry workOrderId, leaseToken, taskKey, taskRevision, workerId, agentId, role and idempotencyKey; enrolled identities must additionally carry policyAckToken and one-time nonceId.
Designer submits a frozen documentRevisionId; Builder submits implementationRevision, real test command and evidenceId; Auditor submits independent evidence, verdict and rework conditions.
Main Agent owns design-audit, implementation-audit and routine approval queues, but each stage requires a separate work order and it may never audit or approve its own production identity.
On LEASE_LOST, TOKEN_REPLAYED, POLICY_VERSION_STALE, WORK_ORDER_CONTEXT_INVALID or SELF_AUDIT_FORBIDDEN stop writing immediately.
Real money, irreversible deletion, external publication/deployment, permission expansion, credential/auth-policy changes, backup overwrite and disabling gates are human-only.`;

export type AgentRole = "designer" | "builder" | "auditor" | "approver";

export interface AuthPrincipal {
  principalId: string;
  actorType: "agent";
  authenticationMethod: "hmac-sha256";
  credentialId: string;
  agentId: string;
  workerId: string;
  allowedRoles: AgentRole[];
  allowedProjects: string[];
  connectionId: string;
  issuedAt: string;
  expiresAt: string;
}

export interface WorkOrderContextInput {
  policyAckToken?: string;
  workOrderId?: string;
  leaseToken?: string;
  taskKey?: string;
  taskRevision?: string;
  nonceId?: string;
  idempotencyKey?: string;
  agentId?: string;
  workerId?: string;
  role?: AgentRole;
  projectId: string;
  action: string;
  target: string;
  bodyDigest?: string;
  connectionId?: string;
}

export class AgentSecurityError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

type CredentialRow = {
  credential_id: string; principal_id: string; agent_id: string; worker_id: string;
  secret_hash: string; allowed_roles_json: string; allowed_projects_json: string;
  status: string; expires_at: string; revocation_version: number;
};

type TokenRow = {
  token_id: string; token_hash: string; credential_id: string; principal_id: string;
  agent_id: string; worker_id: string; role: string; project_id: string; connection_id: string;
  policy_version: string; expires_at: string; revoked_at: string; revocation_version: number;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const secretHash = (secret: string) => sha256(`productdesign-agent-credential:${secret}`);
const json = <T>(value: string): T => JSON.parse(value) as T;
const expiresIn = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

export function ensureAgentSecuritySchema(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS agent_credentials (
      credential_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      worker_id TEXT NOT NULL, secret_hash TEXT NOT NULL, allowed_roles_json TEXT NOT NULL,
      allowed_projects_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, revoked_at TEXT NOT NULL DEFAULT '', revocation_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS auth_challenges (
      challenge_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      challenge_hash TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_tokens (
      token_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, credential_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, agent_id TEXT NOT NULL, worker_id TEXT NOT NULL, role TEXT NOT NULL,
      project_id TEXT NOT NULL, connection_id TEXT NOT NULL, policy_version TEXT NOT NULL,
      issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT NOT NULL DEFAULT '',
      revocation_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_auth_sessions (
      session_token_hash TEXT PRIMARY KEY, credential_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, worker_id TEXT NOT NULL, allowed_roles_json TEXT NOT NULL,
      allowed_projects_json TEXT NOT NULL, connection_id TEXT NOT NULL, issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, revoked_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS one_time_nonces (
      nonce_id TEXT PRIMARY KEY, token_id TEXT NOT NULL, work_order_id TEXT NOT NULL,
      action TEXT NOT NULL, target TEXT NOT NULL, body_digest TEXT NOT NULL,
      expires_at TEXT NOT NULL, consumed_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS security_audit_events (
      id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, principal_id TEXT NOT NULL DEFAULT '',
      actor_type TEXT NOT NULL, authentication_method TEXT NOT NULL DEFAULT '', credential_id TEXT NOT NULL DEFAULT '',
      connection_id TEXT NOT NULL DEFAULT '', token_id TEXT NOT NULL DEFAULT '', nonce_id TEXT NOT NULL DEFAULT '',
      work_order_id TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, risk_class TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL, error_code TEXT NOT NULL DEFAULT '', details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_credentials_identity
      ON agent_credentials(principal_id, agent_id, worker_id, credential_id);
  `);
}

export function isAgentSecurityEnforced(store: Store, agentId?: string): boolean {
  ensureAgentSecuritySchema(store);
  if (!agentId?.trim()) return false;
  const row = store.db.prepare("SELECT 1 AS present FROM agent_credentials WHERE lower(agent_id)=lower(?) LIMIT 1")
    .get(agentId.trim()) as { present: number } | undefined;
  return Boolean(row);
}

function audit(store: Store, action: string, result: string, fields: Partial<Record<string, string>> = {}): void {
  ensureAgentSecuritySchema(store);
  store.db.prepare(`INSERT INTO security_audit_events
    (id, occurred_at, principal_id, actor_type, authentication_method, credential_id, connection_id,
     token_id, nonce_id, work_order_id, action, risk_class, result, error_code, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), new Date().toISOString(), fields.principalId ?? "", fields.actorType ?? "agent",
      fields.authenticationMethod ?? "", fields.credentialId ?? "", fields.connectionId ?? "",
      fields.tokenId ?? "", fields.nonceId ?? "", fields.workOrderId ?? "", action,
      fields.riskClass ?? "controlled", result, fields.errorCode ?? "", fields.details ?? "{}");
}

/**
 * Records a scope-checked agent write decision (grant or denial) in security_audit_events.
 * Reached from the delegable high-risk path and the scope-guarded controlled-write path in the
 * MCP server; the default refusal for every other high-risk operation does not write here.
 */
export function recordScopedAgentWrite(store: Store, fields: {
  action: string;
  result: "success" | "denied";
  riskClass?: string;
  errorCode?: string;
  workOrderId?: string;
  agentId?: string;
  workerId?: string;
  role?: string;
  details?: Record<string, unknown>;
}): void {
  audit(store, fields.action, fields.result, {
    actorType: "agent",
    riskClass: fields.riskClass ?? "high",
    workOrderId: fields.workOrderId ?? "",
    errorCode: fields.errorCode ?? "",
    details: JSON.stringify({
      agentId: fields.agentId ?? "",
      workerId: fields.workerId ?? "",
      role: fields.role ?? "",
      ...(fields.details ?? {}),
    }),
  });
}

export function registerAgentCredential(store: Store, input: {
  principalId: string; agentId: string; workerId: string; allowedRoles: AgentRole[];
  allowedProjects: string[]; expiresAt?: string;
}): { credentialId: string; credentialSecret: string; expiresAt: string } {
  ensureAgentSecuritySchema(store);
  const credentialId = randomUUID();
  const credentialSecret = randomBytes(32).toString("base64url");
  const issuedAt = new Date().toISOString();
  const expiresAt = input.expiresAt ?? expiresIn(86400 * 90);
  store.db.prepare(`INSERT INTO agent_credentials
    (credential_id, principal_id, agent_id, worker_id, secret_hash, allowed_roles_json,
     allowed_projects_json, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(credentialId, input.principalId, input.agentId, input.workerId, secretHash(credentialSecret),
      JSON.stringify(input.allowedRoles), JSON.stringify(input.allowedProjects), issuedAt, expiresAt);
  audit(store, "credential.register", "success", { credentialId, principalId: input.principalId, actorType: "human" });
  return { credentialId, credentialSecret, expiresAt };
}

export function revokeAgentCredential(store: Store, credentialId: string): void {
  ensureAgentSecuritySchema(store);
  const now = new Date().toISOString();
  store.db.transaction(() => {
    const changed = store.db.prepare(`UPDATE agent_credentials SET status='revoked', revoked_at=?,
      revocation_version=revocation_version+1 WHERE credential_id=? AND status='active'`).run(now, credentialId);
    if (changed.changes !== 1) throw new AgentSecurityError(404, "CREDENTIAL_REJECTED", "Credential is absent or already revoked");
    store.db.prepare("UPDATE agent_tokens SET revoked_at=? WHERE credential_id=? AND revoked_at=''").run(now, credentialId);
  }).immediate();
  audit(store, "credential.revoke", "success", { credentialId, actorType: "human" });
}

export function beginAgentAuth(store: Store, credentialId: string, connectionId: string) {
  ensureAgentSecuritySchema(store);
  const row = store.db.prepare("SELECT * FROM agent_credentials WHERE credential_id=?").get(credentialId) as CredentialRow | undefined;
  const now = new Date().toISOString();
  if (!row || row.status !== "active" || row.expires_at <= now) {
    audit(store, "auth.challenge", "rejected", { credentialId, connectionId, errorCode: "CREDENTIAL_REJECTED" });
    throw new AgentSecurityError(401, "CREDENTIAL_REJECTED", "Credential is unknown, revoked or expired");
  }
  const challengeId = randomUUID();
  const challenge = randomBytes(32).toString("base64url");
  const expiresAt = expiresIn(120);
  store.db.prepare(`INSERT INTO auth_challenges
    (challenge_id, credential_id, connection_id, challenge_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(challengeId, credentialId, connectionId, sha256(challenge), expiresAt, now);
  return { challengeId, challenge, connectionId, expiresAt, algorithm: "HMAC-SHA256" as const };
}

export function expectedChallengeResponse(credentialSecret: string, challenge: string, connectionId: string,
  credentialId: string, timestamp: string, protocolVersion: string): string {
  return createHmac("sha256", secretHash(credentialSecret))
    .update([challenge, connectionId, credentialId, timestamp, protocolVersion].join("\n")).digest("base64url");
}

export function completeAgentAuth(store: Store, input: {
  challengeId: string; challenge: string; connectionId: string; timestamp: string;
  protocolVersion: string; response: string;
}): AuthPrincipal & { authSessionToken: string } {
  ensureAgentSecuritySchema(store);
  return store.db.transaction(() => {
    const challengeRow = store.db.prepare("SELECT * FROM auth_challenges WHERE challenge_id=?")
      .get(input.challengeId) as { credential_id: string; connection_id: string; challenge_hash: string; expires_at: string; consumed_at: string } | undefined;
    const now = new Date().toISOString();
    if (!challengeRow || challengeRow.connection_id !== input.connectionId || challengeRow.challenge_hash !== sha256(input.challenge)
      || challengeRow.expires_at <= now || challengeRow.consumed_at) {
      throw new AgentSecurityError(409, "TOKEN_REPLAYED", "Challenge is invalid, expired or already consumed");
    }
    const consumed = store.db.prepare(`UPDATE auth_challenges SET consumed_at=?
      WHERE challenge_id=? AND consumed_at='' AND expires_at>?`).run(now, input.challengeId, now);
    if (consumed.changes !== 1) throw new AgentSecurityError(409, "TOKEN_REPLAYED", "Challenge was consumed concurrently");
    const credential = store.db.prepare("SELECT * FROM agent_credentials WHERE credential_id=?")
      .get(challengeRow.credential_id) as CredentialRow | undefined;
    if (!credential || credential.status !== "active" || credential.expires_at <= now) {
      throw new AgentSecurityError(401, "CREDENTIAL_REJECTED", "Credential is revoked or expired");
    }
    const expected = createHmac("sha256", credential.secret_hash)
      .update([input.challenge, input.connectionId, credential.credential_id, input.timestamp, input.protocolVersion].join("\n"))
      .digest();
    const actual = Buffer.from(input.response, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AgentSecurityError(401, "CREDENTIAL_REJECTED", "Challenge response signature is invalid");
    }
    const issuedAt = now;
    const authSessionToken = randomBytes(32).toString("base64url");
    const principal: AuthPrincipal = {
      principalId: credential.principal_id, actorType: "agent", authenticationMethod: "hmac-sha256",
      credentialId: credential.credential_id, agentId: credential.agent_id, workerId: credential.worker_id,
      allowedRoles: json<AgentRole[]>(credential.allowed_roles_json), allowedProjects: json<string[]>(credential.allowed_projects_json),
      connectionId: input.connectionId, issuedAt, expiresAt: expiresIn(900),
    };
    store.db.prepare(`INSERT INTO agent_auth_sessions
      (session_token_hash, credential_id, principal_id, agent_id, worker_id, allowed_roles_json,
       allowed_projects_json, connection_id, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256(authSessionToken), principal.credentialId, principal.principalId, principal.agentId,
        principal.workerId, JSON.stringify(principal.allowedRoles), JSON.stringify(principal.allowedProjects),
        principal.connectionId, principal.issuedAt, principal.expiresAt);
    audit(store, "auth.complete", "success", { principalId: principal.principalId, credentialId: principal.credentialId, connectionId: principal.connectionId });
    return { ...principal, authSessionToken };
  }).immediate();
}

export function resolveAuthPrincipal(store: Store, authSessionToken: string): AuthPrincipal {
  ensureAgentSecuritySchema(store);
  const row = store.db.prepare("SELECT * FROM agent_auth_sessions WHERE session_token_hash=?")
    .get(sha256(authSessionToken)) as Record<string, string> | undefined;
  const now = new Date().toISOString();
  if (!row || row.revoked_at || row.expires_at <= now) throw new AgentSecurityError(401, "AUTH_REQUIRED", "Authenticated Agent session is required");
  const credential = store.db.prepare("SELECT status, expires_at FROM agent_credentials WHERE credential_id=?")
    .get(row.credential_id) as { status: string; expires_at: string } | undefined;
  if (!credential || credential.status !== "active" || credential.expires_at <= now) throw new AgentSecurityError(401, "TOKEN_REVOKED", "Credential was revoked or expired");
  return {
    principalId: row.principal_id, actorType: "agent", authenticationMethod: "hmac-sha256",
    credentialId: row.credential_id, agentId: row.agent_id, workerId: row.worker_id,
    allowedRoles: json<AgentRole[]>(row.allowed_roles_json), allowedProjects: json<string[]>(row.allowed_projects_json),
    connectionId: row.connection_id, issuedAt: row.issued_at, expiresAt: row.expires_at,
  };
}

export function acknowledgeAgentPolicy(store: Store, principal: AuthPrincipal, input: {
  role: AgentRole; projectId: string; policyVersion: string;
}): { policyAckToken: string; tokenId: string; expiresAt: string; policyVersion: string } {
  ensureAgentSecuritySchema(store);
  if (input.policyVersion !== AGENT_POLICY_VERSION) throw new AgentSecurityError(409, "POLICY_VERSION_STALE", "Current policy version must be acknowledged");
  if (!principal.allowedRoles.includes(input.role) || !principal.allowedProjects.includes(input.projectId)) {
    throw new AgentSecurityError(403, "PERMISSION_DENIED", "Credential does not allow this role or project");
  }
  const credential = store.db.prepare("SELECT status, expires_at, revocation_version FROM agent_credentials WHERE credential_id=?")
    .get(principal.credentialId) as { status: string; expires_at: string; revocation_version: number } | undefined;
  const now = new Date().toISOString();
  if (!credential || credential.status !== "active" || credential.expires_at <= now) throw new AgentSecurityError(401, "TOKEN_REVOKED", "Credential is no longer active");
  const tokenId = randomUUID();
  const policyAckToken = randomBytes(32).toString("base64url");
  const expiresAt = expiresIn(900);
  store.db.prepare(`INSERT INTO agent_tokens
    (token_id, token_hash, credential_id, principal_id, agent_id, worker_id, role, project_id,
     connection_id, policy_version, issued_at, expires_at, revocation_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(tokenId, sha256(policyAckToken), principal.credentialId, principal.principalId, principal.agentId,
      principal.workerId, input.role, input.projectId, principal.connectionId, input.policyVersion, now, expiresAt,
      credential.revocation_version);
  audit(store, "policy.ack", "success", { principalId: principal.principalId, credentialId: principal.credentialId, connectionId: principal.connectionId, tokenId });
  return { policyAckToken, tokenId, expiresAt, policyVersion: AGENT_POLICY_VERSION };
}

export function issueOneTimeNonce(store: Store, input: {
  policyAckToken: string; workOrderId: string; action: string; target: string; bodyDigest: string;
}): { nonceId: string; expiresAt: string } {
  ensureAgentSecuritySchema(store);
  const token = store.db.prepare("SELECT token_id, expires_at, revoked_at FROM agent_tokens WHERE token_hash=?")
    .get(sha256(input.policyAckToken)) as Pick<TokenRow, "token_id" | "expires_at" | "revoked_at"> | undefined;
  const now = new Date().toISOString();
  if (!token || token.revoked_at || token.expires_at <= now) throw new AgentSecurityError(401, "TOKEN_EXPIRED", "Policy token is invalid or expired");
  const nonceId = randomUUID();
  const expiresAt = expiresIn(120);
  store.db.prepare(`INSERT INTO one_time_nonces
    (nonce_id, token_id, work_order_id, action, target, body_digest, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nonceId, token.token_id, input.workOrderId, input.action, input.target, input.bodyDigest, expiresAt, now);
  return { nonceId, expiresAt };
}

export function assertAgentWorkOrderContext(store: Store, input: WorkOrderContextInput): AuthPrincipal {
  ensureAgentSecuritySchema(store);
  const required = ["policyAckToken", "workOrderId", "leaseToken", "taskKey", "taskRevision", "nonceId",
    "idempotencyKey", "agentId", "workerId", "role", "connectionId"] as const;
  const missing = required.filter((key) => !input[key]?.trim());
  if (missing.length) throw new AgentSecurityError(409, "WORK_ORDER_CONTEXT_INVALID", `Missing: ${missing.join(", ")}`);
  const now = new Date().toISOString();
  return store.db.transaction(() => {
    const token = store.db.prepare("SELECT * FROM agent_tokens WHERE token_hash=?").get(sha256(input.policyAckToken!)) as TokenRow | undefined;
    if (!token) throw new AgentSecurityError(401, "POLICY_ACK_REQUIRED", "Current policy acknowledgment is required");
    if (token.expires_at <= now) throw new AgentSecurityError(401, "TOKEN_EXPIRED", "Policy token expired");
    if (token.revoked_at) throw new AgentSecurityError(401, "TOKEN_REVOKED", "Policy token revoked");
    if (token.policy_version !== AGENT_POLICY_VERSION) throw new AgentSecurityError(409, "POLICY_VERSION_STALE", "Policy token is stale");
    if (token.connection_id !== input.connectionId) throw new AgentSecurityError(409, "TOKEN_AUDIENCE_MISMATCH", "Policy token is bound to another connection");
    if (token.agent_id !== input.agentId || token.worker_id !== input.workerId || token.role !== input.role || token.project_id !== input.projectId) {
      throw new AgentSecurityError(403, "PRINCIPAL_SPOOF_REJECTED", "Declared identity conflicts with authenticated principal");
    }
    const credential = store.db.prepare("SELECT status, expires_at, revocation_version FROM agent_credentials WHERE credential_id=?")
      .get(token.credential_id) as { status: string; expires_at: string; revocation_version: number } | undefined;
    if (!credential || credential.status !== "active" || credential.expires_at <= now || credential.revocation_version !== token.revocation_version) {
      throw new AgentSecurityError(401, "TOKEN_REVOKED", "Credential or token was revoked");
    }
    const lease = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=? AND lease_token=?")
      .get(input.workOrderId, input.leaseToken) as Record<string, string> | undefined;
    if (!lease || !["claimed", "running"].includes(lease.status) || lease.lease_expires_at <= now
      || lease.task_key !== input.taskKey || lease.task_revision !== input.taskRevision
      || lease.project_id !== input.projectId || lease.agent_id !== input.agentId
      || lease.worker_id !== input.workerId || lease.role !== input.role) {
      throw new AgentSecurityError(409, "WORK_ORDER_CONTEXT_INVALID", "Work order, lease, task revision or identity does not match");
    }
    const nonce = store.db.prepare("SELECT * FROM one_time_nonces WHERE nonce_id=?")
      .get(input.nonceId) as Record<string, string> | undefined;
    const bodyDigest = input.bodyDigest ?? "";
    if (!nonce || nonce.token_id !== token.token_id || nonce.work_order_id !== input.workOrderId
      || nonce.action !== input.action || nonce.target !== input.target || nonce.body_digest !== bodyDigest
      || nonce.expires_at <= now || nonce.consumed_at) {
      throw new AgentSecurityError(409, "TOKEN_REPLAYED", "Nonce is invalid, expired, mismatched or already consumed");
    }
    const consumed = store.db.prepare(`UPDATE one_time_nonces SET consumed_at=?
      WHERE nonce_id=? AND consumed_at='' AND expires_at>?`).run(now, input.nonceId, now);
    if (consumed.changes !== 1) throw new AgentSecurityError(409, "TOKEN_REPLAYED", "Nonce was consumed concurrently");
    const principal: AuthPrincipal = {
      principalId: token.principal_id, actorType: "agent", authenticationMethod: "hmac-sha256",
      credentialId: token.credential_id, agentId: token.agent_id, workerId: token.worker_id,
      allowedRoles: [token.role as AgentRole], allowedProjects: [token.project_id], connectionId: token.connection_id,
      issuedAt: now, expiresAt: token.expires_at,
    };
    audit(store, input.action, "success", { principalId: token.principal_id, credentialId: token.credential_id,
      connectionId: token.connection_id, tokenId: token.token_id, nonceId: input.nonceId, workOrderId: input.workOrderId });
    return principal;
  }).immediate();
}

export const HIGH_RISK_ACTIONS = new Set([
  "real_money", "irreversible_delete", "external_publish", "production_deploy", "permission_expand",
  "credential_change", "auth_policy_change", "backup_restore_overwrite", "audit_revoke", "disable_gate",
]);

export function assertHumanForHighRisk(action: string, actorType: "human" | "agent" | "system", knownLowRisk = false): void {
  if ((HIGH_RISK_ACTIONS.has(action) || !knownLowRisk) && actorType !== "human") {
    throw new AgentSecurityError(403, "HIGH_RISK_HUMAN_REQUIRED", "This action requires an authenticated human with recent re-authentication and explicit confirmation");
  }
}
