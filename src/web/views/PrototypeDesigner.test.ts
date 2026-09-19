import { describe, expect, it } from "vitest";
import {
  alignPrototypeComponents,
  movePrototypeComponents,
  normalizePrototypeDraft,
  normalizePrototypeStored,
  prototypeFingerprint,
  PROTOTYPE_HISTORY_LIMIT,
} from "../../shared/prototype.js";
import { nextPrototypeScreenId, prototypePreviewTarget } from "./PrototypeDesigner.js";

const draft = normalizePrototypeDraft({
  version: 1,
  updatedAt: "2026-09-17T00:00:00.000Z",
  screens: [{
    id: "home",
    name: "首页",
    components: [
      { id: "first", kind: "button", x: 10, y: 20, w: 100, h: 40, text: "继续" },
      { id: "second", kind: "card", x: 80, y: 100, w: 180, h: 80, text: "内容" },
      { id: "locked", kind: "text", x: 300, y: 300, w: 120, h: 30, text: "锁定", locked: true },
    ],
  }],
});

describe("PrototypeDesigner interaction contract", () => {
  it("cycles page navigation and button preview targets", () => {
    const screens = [
      draft.screens[0],
      { ...draft.screens[0], id: "detail", name: "详情页" },
    ];
    expect(nextPrototypeScreenId(screens, "home")).toBe("detail");
    expect(nextPrototypeScreenId(screens, "detail")).toBe("home");
    expect(prototypePreviewTarget(screens, "home", "button")).toBe("detail");
    expect(prototypePreviewTarget(screens, "home", "card")).toBe("home");
    expect(nextPrototypeScreenId([], "home")).toBe("");
  });

  it.each([
    [0.25, 160],
    [0.5, 80],
    [1, 40],
    [2, 20],
  ])("maps a 40px pointer delta at %s zoom to %s model pixels", (zoom, expected) => {
    const moved = movePrototypeComponents(draft, "home", ["first"], 40 / zoom, 0);
    expect(moved.screens[0].components[0].x).toBe(10 + expected);
    expect(prototypeFingerprint(draft)).not.toBe(prototypeFingerprint(moved));
  });

  it("moves and aligns editable selections without touching locked components", () => {
    const moved = movePrototypeComponents(draft, "home", ["first", "second", "locked"], 15, -5);
    expect(moved.screens[0].components.map(({ x, y }) => [x, y])).toEqual([[25, 15], [95, 95], [300, 300]]);
    const aligned = alignPrototypeComponents(moved, "home", ["first", "second", "locked"], "left");
    expect(aligned.screens[0].components.map(({ x }) => x)).toEqual([25, 25, 300]);
  });

  it("normalizes the legacy JSON shape and exposes the approved 50-step history limit", () => {
    expect(draft.screens[0]).toMatchObject({ width: 640, height: 480, background: "#0f202b" });
    expect(draft.screens[0].components[0]).toMatchObject({ borderRadius: 7, opacity: 1, hidden: false, imageFit: "contain" });
    expect(PROTOTYPE_HISTORY_LIMIT).toBe(50);
    expect(normalizePrototypeStored({ current: draft, versions: [], updatedAt: "2026-09-17T00:00:01.000Z" }).updatedAt)
      .toBe("2026-09-17T00:00:01.000Z");
  });
});
