import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildApp } from "./index.js";
import { expectedChallengeResponse } from "./agentSecurity.js";

it("enrolls only through authenticated administration, then authenticates the Worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-auth-"));
  vi.stubEnv("PCS_AGENT_ADMIN_TOKEN", "test-admin-only");
  const app = buildApp({ dbPath: join(dir, "test.db"), dataDir: dir });
  try {
    const payload = { principalId: "test-principal", agentId: "test-agent", workerId: "test-worker",
      allowedRoles: ["builder"], allowedProjects: ["test-project"] };
    const url = "/api/agent-security/credentials";
    for (const authorization of [undefined, "Bearer wrong"]) {
      const denied = await app.inject({ method: "POST", url, payload, headers: authorization ? { authorization } : {} });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe("PERMISSION_DENIED");
    }
    const registered = await app.inject({ method: "POST", url, payload,
      headers: { authorization: "Bearer test-admin-only" } });
    expect(registered.statusCode).toBe(201);
    const credential = registered.json();
    const connectionId = "worker-auth-test-connection";
    const challenge = (await app.inject({ method: "POST", url: "/api/agent-security/auth/challenge",
      payload: { credentialId: credential.credentialId, connectionId } })).json();
    const timestamp = new Date().toISOString();
    const protocolVersion = "2025-03-26";
    const response = expectedChallengeResponse(credential.credentialSecret, challenge.challenge,
      connectionId, credential.credentialId, timestamp, protocolVersion);
    const auth = await app.inject({ method: "POST", url: "/api/agent-security/auth/complete",
      payload: { challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion, response } });
    expect(auth.statusCode).toBe(200);
    expect(auth.json()).toMatchObject({ agentId: payload.agentId, workerId: payload.workerId });
    const revoked = await app.inject({ method: "POST", url: `${url}/${credential.credentialId}/revoke`,
      payload: { agentId: payload.agentId }, headers: { authorization: "Bearer test-admin-only" } });
    expect(revoked.statusCode).toBe(200);
    const denied = await app.inject({ method: "POST", url: "/api/agent-security/auth/challenge",
      payload: { credentialId: credential.credentialId, connectionId } });
    expect(denied.statusCode).toBe(401);
  } finally {
    await app.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
