import { z } from "zod";

/** Fields shared by every externally callable controlled MCP write. */
export const agentWriteContextSchema = {
  policyAckToken: z.string().min(32).max(300),
  workOrderId: z.string().min(1).max(300),
  leaseToken: z.string().min(1).max(300),
  taskKey: z.string().min(1).max(2000),
  taskRevision: z.string().min(1).max(500),
  workerId: z.string().min(1).max(300),
  agentId: z.string().min(1).max(200),
  role: z.enum(["designer", "builder", "auditor", "approver"]),
  idempotencyKey: z.string().min(1).max(300),
  nonceId: z.string().min(1).max(300),
  connectionId: z.string().min(16).max(300),
  bodyDigest: z.string().length(64),
} as const;

export const AGENT_WRITE_CONTEXT_DESCRIPTION =
  "先调用 claim_next_agent_task 领取当前任务。后续写入必须携带领取结果中的 workOrderId、leaseToken、taskKey、taskRevision、workerId、agentId、role 和稳定 idempotencyKey。";

/** Task-scoped lease fields used by the local-first external Agent mode. */
export const leaseWriteContextSchema = {
  workOrderId: z.string().min(1).max(300),
  leaseToken: z.string().min(1).max(300),
  taskKey: z.string().min(1).max(2000),
  taskRevision: z.string().min(1).max(500),
  workerId: z.string().min(1).max(300),
  agentId: z.string().min(1).max(200),
  role: z.enum(["designer", "builder", "auditor", "approver"]),
  idempotencyKey: z.string().min(1).max(300),
} as const;

/**
 * Same lease fields, but optional at the schema level. Used by the delegable high-risk path:
 * a call without a work order must still reach the tool handler so it can return the
 * unchanged human-only refusal (HIGH_RISK_HUMAN_REQUIRED) instead of a validation error.
 */
export const optionalLeaseWriteContextSchema = {
  workOrderId: z.string().min(1).max(300).optional(),
  leaseToken: z.string().min(1).max(300).optional(),
  taskKey: z.string().min(1).max(2000).optional(),
  taskRevision: z.string().min(1).max(500).optional(),
  workerId: z.string().min(1).max(300).optional(),
  agentId: z.string().min(1).max(200).optional(),
  role: z.enum(["designer", "builder", "auditor", "approver"]).optional(),
  idempotencyKey: z.string().min(1).max(300).optional(),
} as const;

