import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "./db.js";
import { AgentTaskLeaseError } from "./agentTaskLeases.js";
import { listAgentTaskRetryCandidates, requestAgentTaskRetry } from "./agentTaskRetry.js";

const requestSchema = z.object({
  taskKey: z.string().trim().min(1).max(2000), taskRevision: z.string().trim().min(1).max(2000),
  failedWorkOrderId: z.string().trim().min(1).max(300), expectedAttempt: z.number().int().min(1),
  reason: z.string().trim().min(1).max(4000), remediation: z.string().trim().min(1).max(4000),
  idempotencyKey: z.string().trim().min(1).max(300),
}).strict();

export function registerAgentTaskRetryApi(app: FastifyInstance, store: Store): void {
  app.get("/api/projects/:id/agent-task-retry-candidates", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", message: "项目不存在" });
    return listAgentTaskRetryCandidates(store, id);
  });
  app.post("/api/projects/:id/agent-task-retry-requests", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", message: "项目不存在" });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "RETRY_REQUEST_INVALID", message: "请提供精确失败工单、原因、修复措施和幂等键" });
    try { return requestAgentTaskRetry(store, { ...parsed.data, projectId: id }); }
    catch (cause) {
      if (cause instanceof AgentTaskLeaseError) return reply.code(cause.statusCode).send({ code: cause.code, message: cause.message });
      throw cause;
    }
  });
}
