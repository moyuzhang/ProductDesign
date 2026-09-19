import type { PlanItem } from "../../shared/types.js";

export function planDeliveryHref(plan: Pick<PlanItem, "id" | "diagramId" | "diagramNodeId">): string | null {
  if (!plan.diagramId || !plan.diagramNodeId) return null;
  return `#/canvas/${plan.diagramId}/node/${plan.diagramNodeId}?tab=development&plan=${encodeURIComponent(plan.id)}`;
}

export function designChangeIdFromBlockedReason(reason: string): string | null {
  return reason.match(/^设计变更处理中\s*·\s*([0-9a-f]{8}-[0-9a-f-]{27})$/i)?.[1] ?? null;
}
