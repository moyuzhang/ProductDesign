import { CustomEventSchema } from "@ag-ui/core";
import { describe, expect, it, vi } from "vitest";
import { AgentUiEventBus } from "./agentUiEvents.js";

describe("AgentUiEventBus", () => {
  it("publishes AG-UI compatible entity change events and supports replay", () => {
    const bus = new AgentUiEventBus();
    const subscriber = vi.fn();
    const unsubscribe = bus.subscribe("project-1", subscriber);
    const item = bus.publishEntityChanged({
      projectId: "project-1",
      entityType: "diagram",
      entityId: "diagram-1",
      changedEntityIds: ["node-1"],
      revision: "2026-08-27T09:00:00.000Z",
      source: "agent",
      sessionId: "session-1",
    });

    expect(CustomEventSchema.safeParse(item.event).success).toBe(true);
    expect(item.event).toMatchObject({
      type: "CUSTOM",
      name: "productdesign.entity.changed",
      value: { entityId: "diagram-1", changedEntityIds: ["node-1"] },
    });
    expect(subscriber).toHaveBeenCalledWith(item);
    expect(bus.since("project-1", 0)).toEqual([item]);
    expect(bus.since("project-1", item.id)).toEqual([]);
    unsubscribe();
  });

  it("publishes approval changes without exposing transport request ids", () => {
    const bus = new AgentUiEventBus();
    const item = bus.publishApprovalChanged({
      id: "approval-1",
      projectId: "project-1",
      sessionId: "session-1",
      kind: "command",
      title: "Agent 请求执行命令",
      summary: "npm test",
      details: { command: "npm test" },
      status: "pending",
      decision: null,
      expiresAt: "2026-08-27T09:02:00.000Z",
      createdAt: "2026-08-27T09:00:00.000Z",
      resolvedAt: "",
    });

    expect(CustomEventSchema.safeParse(item.event).success).toBe(true);
    expect(item.event).toMatchObject({
      type: "CUSTOM",
      name: "productdesign.approval.changed",
      value: { sessionId: "session-1", approval: { id: "approval-1", status: "pending" } },
    });
    expect(JSON.stringify(item.event)).not.toContain("requestId");
  });

  it("publishes a context-targeted silent navigation event", () => {
    const bus = new AgentUiEventBus();
    const item = bus.publishNavigationRequested({
      projectId: "project-1",
      sessionId: "session-1",
      contextId: "context-1",
      diagramId: "diagram-1",
      nodeId: "node-1",
      silent: true,
      source: "agent",
    });

    expect(CustomEventSchema.safeParse(item.event).success).toBe(true);
    expect(item.event).toMatchObject({
      type: "CUSTOM",
      name: "productdesign.navigation.requested",
      value: { contextId: "context-1", diagramId: "diagram-1", nodeId: "node-1", silent: true },
    });
  });
});
