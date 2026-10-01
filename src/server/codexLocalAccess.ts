import type { FastifyRequest } from "fastify";

/** Loopback + exact browser origin + explicit non-simple header prevent remote/CSRF use. */
export function assertLocalCodexRequest(request: FastifyRequest): void {
  const deny = () => { throw Object.assign(new Error("ChatGPT 登录和使用仅允许本机 ProductDesign 页面操作"), { statusCode: 403 }); };
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip)) deny();
  if (request.headers["x-productdesign-local-auth"] !== "1") deny();
  const body = request.body as Record<string, unknown> | undefined;
  if (request.headers["x-productdesign-actor-type"] || ["policyAckToken", "workOrderId", "leaseToken", "agentId", "workerId"].some((key) => body?.[key] !== undefined)) deny();
  let host: URL;
  try { host = new URL(`${request.protocol}://${request.headers.host}`); } catch { return deny(); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) || host.username || host.password) deny();
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== host.origin) deny();
  if (request.headers["sec-fetch-site"] === "cross-site") deny();
}
