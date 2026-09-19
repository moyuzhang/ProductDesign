import { describe, expect, it } from "vitest";
import type { PlanItem } from "./types.js";
import { planDeliveryActions, planLifecycleStep } from "./planDelivery.js";

function plan(
  lifecycleStatus: PlanItem["lifecycleStatus"],
  hasFormalTrace = true,
  auditStatus: PlanItem["auditStatus"] = "not_requested",
): Pick<PlanItem, "lifecycleStatus" | "submittedAt" | "approvedAt" | "auditStatus"> {
  return {
    lifecycleStatus,
    auditStatus,
    submittedAt: hasFormalTrace ? "2026-08-30T01:00:00.000Z" : "",
    approvedAt: hasFormalTrace ? "2026-08-30T01:05:00.000Z" : "",
  };
}

describe("plan delivery presentation", () => {
  it("exposes only lifecycle-safe next actions", () => {
    expect(planDeliveryActions(plan("draft")).map((item) => item.action)).toEqual(["submit_plan"]);
    expect(planDeliveryActions(plan("pending_approval", true, "pending")).map((item) => item.action)).toEqual(["pass_design_audit", "fail_design_audit"]);
    expect(planDeliveryActions(plan("pending_approval", true, "passed")).map((item) => item.action)).toEqual(["approve_plan", "reject_plan"]);
    expect(planDeliveryActions(plan("approved")).map((item) => item.action)).toEqual(["start_development"]);
    expect(planDeliveryActions(plan("in_progress")).map((item) => item.action)).toEqual(["complete_development"]);
    expect(planDeliveryActions(plan("pending_audit")).map((item) => item.action)).toEqual(["pass_audit", "fail_audit"]);
    expect(planDeliveryActions(plan("pending_manager")).map((item) => item.action)).toEqual(["approve_acceptance", "reject_acceptance"]);
    expect(planDeliveryActions(plan("accepted"))).toEqual([]);
    expect(planDeliveryActions(plan("in_progress", false)).map((item) => item.action)).toEqual(["submit_plan"]);
  });

  it("keeps rejection and audit failure on their correct recovery path", () => {
    expect(planDeliveryActions(plan("rework")).map((item) => item.action)).toEqual(["submit_plan"]);
    expect(planDeliveryActions(plan("audit_failed")).map((item) => item.action)).toEqual(["reopen_rework"]);
    expect(planLifecycleStep("audit_failed")).toBe(planLifecycleStep("pending_audit"));
    expect(planLifecycleStep("accepted")).toBeGreaterThan(planLifecycleStep("pending_manager"));
  });
});
