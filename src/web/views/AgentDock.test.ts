import { describe, expect, it } from "vitest";
import { agentLauncherSideForDrop, clampAgentLauncherPoint } from "./AgentDock.js";

describe("Agent launcher edge snapping", () => {
  it("keeps the launcher inside the viewport", () => {
    expect(clampAgentLauncherPoint(
      { x: -40, y: 900 },
      { width: 104, height: 46 },
      { width: 1200, height: 800 },
      24,
    )).toEqual({ x: 24, y: 730 });
  });

  it("snaps to the nearest horizontal edge", () => {
    expect(agentLauncherSideForDrop(80, 104, 1200)).toBe("left");
    expect(agentLauncherSideForDrop(980, 104, 1200)).toBe("right");
  });
});
