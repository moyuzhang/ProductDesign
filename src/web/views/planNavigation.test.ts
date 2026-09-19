import { describe, expect, it } from "vitest";
import { designChangeIdFromBlockedReason, planDeliveryHref } from "./planNavigation.js";

describe("planDeliveryHref", () => {
  it("opens the bound node development tab with the selected construction plan", () => {
    expect(planDeliveryHref({ id: "plan-1", diagramId: "diagram-1", diagramNodeId: "node-1" }))
      .toBe("#/canvas/diagram-1/node/node-1?tab=development&plan=plan-1");
  });

  it("does not create a construction link for an unbound project plan", () => {
    expect(planDeliveryHref({ id: "plan-1", diagramId: null, diagramNodeId: null })).toBeNull();
  });
});

describe("designChangeIdFromBlockedReason", () => {
  it("extracts a design change id only from the structured blocker message", () => {
    expect(designChangeIdFromBlockedReason("设计变更处理中 · ee8fc339-0d65-45b4-ad9d-901d24f98059"))
      .toBe("ee8fc339-0d65-45b4-ad9d-901d24f98059");
    expect(designChangeIdFromBlockedReason("等待人工确认")) .toBeNull();
  });
});
