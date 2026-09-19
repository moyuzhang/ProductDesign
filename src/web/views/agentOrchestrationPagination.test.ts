import { describe, expect, it } from "vitest";
import {
  createOrchestrationQueueOffsets,
  paginateOrchestrationQueue,
  setOrchestrationQueueOffset,
} from "./agentOrchestrationPagination";

describe("agent orchestration queue pagination", () => {
  it("keeps the last page aligned and reports the exact total", () => {
    const items = Array.from({ length: 13 }, (_, index) => index + 1);
    const page = paginateOrchestrationQueue(items, 10, 5);

    expect(page).toMatchObject({ offset: 10, page: 3, pages: 3, start: 11, end: 13, total: 13 });
    expect(page.visible).toEqual([11, 12, 13]);
    expect(page.hasNext).toBe(false);
  });

  it("clamps a refreshed queue to its new last valid page", () => {
    const refreshed = Array.from({ length: 7 }, (_, index) => index + 1);
    const page = paginateOrchestrationQueue(refreshed, 10, 5);

    expect(page).toMatchObject({ offset: 5, page: 2, pages: 2, start: 6, end: 7, total: 7 });
    expect(page.visible).toEqual([6, 7]);
  });

  it("updates one queue independently and resets all queues for a project switch", () => {
    const initial = createOrchestrationQueueOffsets();
    const changed = setOrchestrationQueueOffset(initial, "development", 10);

    expect(changed).toEqual({ design: 0, development: 10, audit: 0, approval: 0, managerApproval: 0 });
    expect(initial).toEqual(createOrchestrationQueueOffsets());
  });
});
