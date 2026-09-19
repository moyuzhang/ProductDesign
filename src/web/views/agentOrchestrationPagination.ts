import type { AgentOrchestrationQueueKey } from "../../shared/types";

export const ORCHESTRATION_QUEUE_PAGE_SIZE = 5;

export type OrchestrationQueueOffsets = Record<AgentOrchestrationQueueKey, number>;

export function createOrchestrationQueueOffsets(): OrchestrationQueueOffsets {
  return {
    design: 0,
    development: 0,
    audit: 0,
    approval: 0,
    managerApproval: 0,
  };
}

export function setOrchestrationQueueOffset(
  offsets: OrchestrationQueueOffsets,
  key: AgentOrchestrationQueueKey,
  offset: number,
): OrchestrationQueueOffsets {
  return { ...offsets, [key]: Math.max(0, offset) };
}

export function paginateOrchestrationQueue<T>(
  items: readonly T[],
  requestedOffset: number,
  pageSize = ORCHESTRATION_QUEUE_PAGE_SIZE,
) {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pages = Math.max(1, Math.ceil(items.length / safePageSize));
  const lastOffset = items.length === 0 ? 0 : (pages - 1) * safePageSize;
  const alignedOffset = Math.floor(Math.max(0, requestedOffset) / safePageSize) * safePageSize;
  const offset = Math.min(alignedOffset, lastOffset);
  const visible = items.slice(offset, offset + safePageSize);

  return {
    offset,
    visible,
    total: items.length,
    page: Math.floor(offset / safePageSize) + 1,
    pages,
    start: items.length === 0 ? 0 : offset + 1,
    end: offset + visible.length,
    hasPrevious: offset > 0,
    hasNext: offset + safePageSize < items.length,
  };
}
