import { CustomEventSchema, EventType, type CustomEvent } from "@ag-ui/core";
import type { AgentApproval, AgentApprovalChangedEvent, AgentEntityChangedEvent, AgentEntityChangedValue, AgentNavigationRequestedEvent, AgentNavigationRequestedValue, AgentUiEvent } from "../shared/types.js";

export interface SequencedAgentUiEvent {
  id: number;
  event: AgentUiEvent;
}

export class AgentUiEventBus {
  private sequence = 0;
  private readonly history = new Map<string, SequencedAgentUiEvent[]>();
  private readonly subscribers = new Map<string, Set<(item: SequencedAgentUiEvent) => void>>();

  private publish(projectId: string, event: AgentUiEvent): SequencedAgentUiEvent {
    const item = { id: ++this.sequence, event };
    const projectHistory = [...(this.history.get(projectId) ?? []), item].slice(-100);
    this.history.set(projectId, projectHistory);
    for (const subscriber of this.subscribers.get(projectId) ?? []) subscriber(item);
    return item;
  }

  publishEntityChanged(value: AgentEntityChangedValue): SequencedAgentUiEvent {
    const event = CustomEventSchema.parse({
      type: EventType.CUSTOM,
      name: "productdesign.entity.changed",
      value,
      timestamp: Date.now(),
    } satisfies CustomEvent) as AgentEntityChangedEvent;
    return this.publish(value.projectId, event);
  }

  publishApprovalChanged(approval: AgentApproval): SequencedAgentUiEvent {
    const event = CustomEventSchema.parse({
      type: EventType.CUSTOM,
      name: "productdesign.approval.changed",
      value: { projectId: approval.projectId, sessionId: approval.sessionId, approval },
      timestamp: Date.now(),
    } satisfies CustomEvent) as AgentApprovalChangedEvent;
    return this.publish(approval.projectId, event);
  }

  publishNavigationRequested(value: AgentNavigationRequestedValue): SequencedAgentUiEvent {
    const event = CustomEventSchema.parse({
      type: EventType.CUSTOM,
      name: "productdesign.navigation.requested",
      value,
      timestamp: Date.now(),
    } satisfies CustomEvent) as AgentNavigationRequestedEvent;
    return this.publish(value.projectId, event);
  }

  since(projectId: string, afterId = 0): SequencedAgentUiEvent[] {
    return (this.history.get(projectId) ?? []).filter((item) => item.id > afterId);
  }

  subscribe(projectId: string, subscriber: (item: SequencedAgentUiEvent) => void): () => void {
    const projectSubscribers = this.subscribers.get(projectId) ?? new Set();
    projectSubscribers.add(subscriber);
    this.subscribers.set(projectId, projectSubscribers);
    return () => {
      projectSubscribers.delete(subscriber);
      if (projectSubscribers.size === 0) this.subscribers.delete(projectId);
    };
  }
}
