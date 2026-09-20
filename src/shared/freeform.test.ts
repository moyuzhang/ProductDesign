import { describe, expect, it } from "vitest";
import {
  applyFreeformAssetSecurityHeaders,
  applyFreeformCommand,
  assertNoDeliveryFieldLeak,
  buildFreeformCommand,
  buildFreeformExportJson,
  buildFreeformSvg,
  copyFreeformElements,
  createFreeformHistory,
  createFreeformMachine,
  duplicateFreeformElements,
  expandFreeformSelection,
  freeformAssetMimeFromMagic,
  freeformAssetUrl,
  freeformDocumentFingerprint,
  freeformElementHitTest,
  freeformElementSchema,
  freeformIdSpaceOf,
  freeformKindIntersectsDeliveryKinds,
  freeformMachine,
  freeformMarqueeHits,
  freeformSaveSchema,
  freeformSelectAllIds,
  freeformToolForShortcut,
  freeformToolCreatesKind,
  groupFreeformElements,
  isDeliveryNodeId,
  isFreeformAssetMimeAllowed,
  isFreeformAssetMimeDenied,
  isFreeformElementId,
  isFreeformGroupId,
  listDeliveryFieldLeaks,
  mapLegacyPrototypeDraft,
  moveFreeformElements,
  normalizeFreeformDocument,
  normalizeFreeformElement,
  pasteFreeformClipboard,
  pushFreeformCommand,
  redoFreeformCommand,
  reorderFreeformElements,
  resizeFreeformElements,
  rotateFreeformElements,
  setFreeformRotation,
  undoFreeformCommand,
  ungroupFreeformElements,
  withElements,
  FREEFORM_ASSET_PLACEHOLDER_ID,
  FREEFORM_ELEMENT_ID_PREFIX,
  FREEFORM_GROUP_ID_PREFIX,
  FREEFORM_HISTORY_LIMIT,
  FREEFORM_MIN_SIZE,
  FREEFORM_PNG_SCALE,
  FREEFORM_ROTATION_SNAP,
  FREEFORM_SCHEMA_VERSION,
} from "./freeform.js";
import { DIAGRAM_NODE_KINDS, FREEFORM_ELEMENT_KINDS, type FreeformDocument, type FreeformElement } from "./types.js";

const emptyDocument = (elements: FreeformElement[] = [], unsupported: FreeformDocument["unsupported"] = []): FreeformDocument => ({
  schemaVersion: FREEFORM_SCHEMA_VERSION,
  diagramId: "diagram-1",
  elements,
  unsupported,
  updatedAt: "",
});

/** 用归一化函数构造元素，保证与真实写入路径的字段形状一致。 */
function element(raw: Record<string, unknown>): FreeformElement {
  const normalized = normalizeFreeformElement({ rotation: 0, groupId: null, style: {}, locked: false, hidden: false, createdAt: "", updatedAt: "", ...raw });
  if (!normalized) throw new Error(`元素归一化失败：${JSON.stringify(raw)}`);
  return normalized;
}

// AC1 / FT-01..FT-07：7 类自由元素均可表达且字段完整（数据契约层）。
describe("AC1 自由元素数据模型（FT-01..FT-07）", () => {
  const samples: Array<[string, Record<string, unknown>]> = [
    ["text（FT-01）", { id: "fr_text_1", kind: "text", x: 10, y: 20, w: 180, h: 36, text: "标题", autoHeight: true }],
    ["sticky（FT-02）", { id: "fr_sticky_1", kind: "sticky", x: 0, y: 0, w: 180, h: 120, text: "便签", tone: "warn" }],
    ["rect（FT-03）", { id: "fr_rect_1", kind: "rect", x: 0, y: 0, w: 160, h: 100, cornerStyle: "rounded" }],
    ["ellipse（FT-04）", { id: "fr_ellipse_1", kind: "ellipse", x: 0, y: 0, w: 140, h: 140 }],
    ["arrow（FT-05）", { id: "fr_arrow_1", kind: "arrow", x: 0, y: 0, w: 140, h: 1, dx: 70, dy: 0, arrowStart: "none", arrowEnd: "triangle", lineStyle: "dashed" }],
    ["ink（FT-06）", { id: "fr_ink_1", kind: "ink", x: 0, y: 0, w: 120, h: 120, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], strokeWidth: 2 }],
    ["image（FT-07）", { id: "fr_image_1", kind: "image", x: 0, y: 0, w: 220, h: 160, assetRef: "fa_abc123", imageFit: "cover", alt: "示意图", sourceWidth: 640, sourceHeight: 480 }],
  ];

  it.each(samples)("可构造 %s 且通过 strict schema", (_label, raw) => {
    const parsed = element(raw);
    expect(parsed.kind).toBe(raw.kind);
    expect(parsed.id.startsWith(FREEFORM_ELEMENT_ID_PREFIX)).toBe(true);
    expect(freeformElementSchema.safeParse(parsed).success).toBe(true);
    for (const [key, value] of Object.entries(raw)) expect(parsed[key as keyof FreeformElement]).toEqual(value);
  });

  it("枚举覆盖 7 类且工具映射与快捷键一致", () => {
    expect(FREEFORM_ELEMENT_KINDS).toHaveLength(7);
    expect(freeformToolCreatesKind("imageRef")).toBe("image");
    expect(freeformToolCreatesKind("select")).toBeNull();
    expect(freeformToolCreatesKind("pan")).toBeNull();
    expect(freeformToolForShortcut("R")).toBe("rect");
    expect(freeformToolForShortcut("P")).toBe("ink");
  });

  it("归一化将数值 round 到 2 位小数", () => {
    const parsed = element({ id: "fr_round_1", kind: "rect", x: 1 / 3, y: 0, w: 10.126, h: 10, cornerStyle: "sharp" });
    expect(parsed.x).toBe(0.33);
    expect(parsed.w).toBe(10.13);
  });
});

// AC2 / FT-11 / C2 / C3：id 空间不交叉、交付字段必须被拒绝、交付统计不可见。
describe("AC2 与交付节点硬隔离（FT-11 / C2 / C3）", () => {
  it("两套 id 空间互斥且自由元素 id 不可能是交付节点 id", () => {
    expect(isFreeformElementId("fr_01H")).toBe(true);
    expect(isFreeformGroupId("fg_01H")).toBe(true);
    expect(isFreeformElementId("whiteboard-freeform-authoring")).toBe(false);
    expect(isDeliveryNodeId("whiteboard-freeform-authoring")).toBe(true);
    expect(isDeliveryNodeId("fr_01H")).toBe(false);
    expect(isDeliveryNodeId("fg_01H")).toBe(false);
    expect(freeformIdSpaceOf("fr_01H")).toBe("freeform-element");
    expect(freeformIdSpaceOf("fg_01H")).toBe("freeform-group");
    expect(freeformIdSpaceOf("whiteboard-freeform-authoring")).toBe("delivery-node");
    expect(freeformIdSpaceOf("Bad Id!")).toBe("unknown");
  });

  it("kind 枚举与 DIAGRAM_NODE_KINDS 无交集（C3）", () => {
    expect(freeformKindIntersectsDeliveryKinds()).toEqual([]);
    expect(FREEFORM_ELEMENT_KINDS.filter((kind) => (DIAGRAM_NODE_KINDS as readonly string[]).includes(kind))).toEqual([]);
  });

  it("自由元素携带交付状态字段时必须被拒绝而不是静默忽略", () => {
    const leaked = element({ id: "fr_leak_1", kind: "sticky", x: 0, y: 0, w: 100, h: 60, text: "x", tone: "info" });
    expect(listDeliveryFieldLeaks({ elements: [{ ...leaked, requirementStatus: "todo" }] })).toEqual(["requirementStatus"]);
    expect(() => assertNoDeliveryFieldLeak({ elements: [{ ...leaked, requirementStatus: "todo" }] })).toThrow(/requirementStatus/);
    expect(listDeliveryFieldLeaks({ elements: [leaked] })).toEqual([]);
    expect(() => assertNoDeliveryFieldLeak({ elements: [leaked] })).not.toThrow();
    // 嵌套层级同样必须被扫描到，不能只看顶层。
    expect(listDeliveryFieldLeaks({ nested: [{ deep: { owner: "无" } }] })).toEqual(["owner"]);
  });

  it("保存体 strict：交付字段、未知字段、id 重复一律校验失败", () => {
    const rect = element({ id: "fr_rect_2", kind: "rect", x: 0, y: 0, w: 100, h: 100, cornerStyle: "rounded" });
    const base = { schemaVersion: FREEFORM_SCHEMA_VERSION, elements: [rect], unsupported: [], expectedUpdatedAt: null };
    expect(freeformSaveSchema.safeParse(base).success).toBe(true);
    expect(freeformSaveSchema.safeParse({ ...base, elements: [{ ...rect, acceptanceStatus: "待验收" }] }).success).toBe(false);
    expect(freeformSaveSchema.safeParse({ ...base, rogue: true }).success).toBe(false);
    expect(freeformSaveSchema.safeParse({ ...base, elements: [rect, { ...rect }] }).success).toBe(false);
  });
});

// AC5 / FT-45 / FT-46：旧数据归一化幂等，未知元素不得静默删除。
describe("AC5 旧数据兼容（FT-45 / FT-46）", () => {
  it("缺 rotation/groupId/style 由默认值补齐，zIndex 转换为数组序，且二次归一化幂等", () => {
    const legacy = {
      elements: [
        { id: "fr_a", kind: "rect", x: 10, y: 20, w: 100, h: 50, zIndex: 5, cornerStyle: "sharp" },
        { id: "fr_b", kind: "text", x: 0, y: 0, w: 120, h: 30, text: "hi", zIndex: 1 },
      ],
    };
    const first = normalizeFreeformDocument(legacy, "diagram-1");
    expect(first.elements.map((item) => item.id)).toEqual(["fr_b", "fr_a"]);
    expect(first.elements[0].rotation).toBe(0);
    expect(first.elements[0].groupId).toBeNull();
    expect(first.elements[0].style).toMatchObject({ strokeColor: "#507287" });
    expect(first.schemaVersion).toBe(FREEFORM_SCHEMA_VERSION);
    const second = normalizeFreeformDocument(JSON.parse(JSON.stringify(first)), "diagram-1");
    expect(freeformDocumentFingerprint(second)).toBe(freeformDocumentFingerprint(first));
    const third = normalizeFreeformDocument(JSON.parse(JSON.stringify(second)), "diagram-1");
    expect(freeformDocumentFingerprint(third)).toBe(freeformDocumentFingerprint(first));
  });

  it("未知 kind 进入 unknown 容器并原样保留，禁止静默删除", () => {
    const legacy = {
      elements: [
        {
          id: "fr_ok", kind: "rect", x: 0, y: 0, w: 10, h: 10, rotation: 0, groupId: null, style: {},
          locked: false, hidden: false, createdAt: "", updatedAt: "", cornerStyle: "rounded",
        },
        { id: "fr_unknown", kind: "sparkle", x: 1, y: 1, w: 2, h: 2, glow: "high" },
      ],
    };
    const document = normalizeFreeformDocument(legacy, "diagram-1");
    expect(document.elements.map((item) => item.id)).toEqual(["fr_ok"]);
    expect(document.unsupported.map((item) => item.id)).toEqual(["fr_unknown"]);
    expect(document.unsupported[0].raw).toMatchObject({ kind: "sparkle", glow: "high" });
    const again = normalizeFreeformDocument(JSON.parse(JSON.stringify(document)), "diagram-1");
    expect(freeformDocumentFingerprint(again)).toBe(freeformDocumentFingerprint(document));
  });

  it("历史原型草稿只读映射为 legacy 子集，不产生交付字段", () => {
    const mapped = mapLegacyPrototypeDraft({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      screens: [{
        id: "home",
        name: "首页",
        components: [
          { id: "t1", kind: "text", x: 0, y: 0, w: 100, h: 20, text: "标题" },
          { id: "c1", kind: "card", x: 0, y: 30, w: 200, h: 120, text: "" },
          { id: "i1", kind: "image", x: 0, y: 160, w: 200, h: 120, text: "示例" },
        ],
      }],
    });
    expect(mapped.map((item) => item.kind)).toEqual(["text", "rect", "image"]);
    expect(mapped.every((item) => item.id.startsWith("fr_legacy_"))).toBe(true);
    expect(mapped[2].assetRef).toBe(FREEFORM_ASSET_PLACEHOLDER_ID);
    expect(listDeliveryFieldLeaks({ elements: mapped })).toEqual([]);
  });
});

// AC3 / FT-20..FT-27：选择、多选、移动、缩放、旋转、组合与层级（纯函数部分）。
describe("AC3 选择与变换（FT-20..FT-27）", () => {
  const first = element({ id: "fr_1", kind: "rect", x: 0, y: 0, w: 100, h: 100, cornerStyle: "rounded" });
  const second = element({ id: "fr_2", kind: "rect", x: 200, y: 0, w: 100, h: 100, cornerStyle: "rounded" });
  const third = element({ id: "fr_3", kind: "rect", x: 400, y: 0, w: 100, h: 100, cornerStyle: "rounded" });
  const document = emptyDocument([first, second, third]);

  it("FT-20 框选部分相交即命中，隐藏元素被排除；全选不含锁定元素", () => {
    expect(freeformMarqueeHits(document.elements, { x: 50, y: 50, w: 200, h: 60 })).toEqual(["fr_1", "fr_2"]);
    const hidden = withElements(document, document.elements.map((item) => item.id === "fr_2" ? { ...item, hidden: true } : item));
    expect(freeformMarqueeHits(hidden.elements, { x: 50, y: 50, w: 300, h: 60 })).toEqual(["fr_1"]);
    const locked = withElements(document, document.elements.map((item) => item.id === "fr_3" ? { ...item, locked: true } : item));
    expect(freeformSelectAllIds(locked)).toEqual(["fr_1", "fr_2"]);
    expect(freeformElementHitTest(first, { x: 50, y: 50 })).toBe(true);
    expect(freeformElementHitTest(first, { x: 150, y: 150 })).toBe(false);
  });

  it("FT-22 方向键位移逐像素，坐标被钳制到 ±100000 且锁定元素不动", () => {
    const moved = moveFreeformElements(document, ["fr_1"], 1, 0);
    expect(moved.elements[0].x).toBe(1);
    const clamped = moveFreeformElements(emptyDocument([element({ id: "fr_far", kind: "rect", x: 100000, y: 0, w: 10, h: 10, cornerStyle: "sharp" })]), ["fr_far"], 500, 0);
    expect(clamped.elements[0].x).toBe(100000);
    const locked = withElements(document, document.elements.map((item) => item.id === "fr_1" ? { ...item, locked: true } : item));
    expect(moveFreeformElements(locked, ["fr_1"], 10, 10).elements[0].x).toBe(0);
  });

  it("FT-23 缩放保持最小 8x8，Shift 保持纵横比时按最大边换算", () => {
    const shrunk = resizeFreeformElements(document, ["fr_1"], "se", -500, -500);
    expect(shrunk.elements[0].w).toBe(FREEFORM_MIN_SIZE);
    expect(shrunk.elements[0].h).toBe(FREEFORM_MIN_SIZE);
    const rectangle = emptyDocument([element({ id: "fr_r", kind: "rect", x: 0, y: 0, w: 200, h: 100, cornerStyle: "rounded" })]);
    const aspect = resizeFreeformElements(rectangle, ["fr_r"], "se", 200, 0, { keepAspect: true });
    expect(aspect.elements[0].w).toBe(400);
    expect(aspect.elements[0].h).toBe(200);
  });

  it("FT-24 旋转按 15° 吸附，数值输入被钳制在 ±360", () => {
    const rotated = rotateFreeformElements(document, ["fr_1"], 20, { snap: true });
    expect(rotated.elements[0].rotation).toBe(Math.round(20 / FREEFORM_ROTATION_SNAP) * FREEFORM_ROTATION_SNAP);
    const free = rotateFreeformElements(document, ["fr_1"], 20);
    expect(free.elements[0].rotation).toBe(20);
    expect(setFreeformRotation(document, ["fr_1"], 999).elements[0].rotation).toBe(360);
  });

  it("FT-25/FT-27 组合后整组作为单位选中、变换与层级调整，组内相对次序不变", () => {
    const grouped = groupFreeformElements(document, ["fr_1", "fr_2"], "fg_test1");
    expect(new Set(grouped.elements.filter((item) => item.groupId).map((item) => item.id))).toEqual(new Set(["fr_1", "fr_2"]));
    expect(expandFreeformSelection(grouped, ["fr_1"])).toEqual(["fr_1", "fr_2"]);
    const raised = reorderFreeformElements(grouped, ["fr_1"], "front");
    const order = raised.elements.map((item) => item.id);
    expect(order.slice(-2)).toEqual(["fr_1", "fr_2"]);
    const ungrouped = ungroupFreeformElements(grouped, ["fr_1"]);
    expect(ungrouped.elements.every((item) => item.groupId === null)).toBe(true);
  });

  it("FT-26 层级四操作以整组为单位且不丢元素", () => {
    const front = reorderFreeformElements(document, ["fr_1"], "front");
    expect(front.elements.map((item) => item.id)).toEqual(["fr_2", "fr_3", "fr_1"]);
    const back = reorderFreeformElements(document, ["fr_3"], "back");
    expect(back.elements.map((item) => item.id)).toEqual(["fr_3", "fr_1", "fr_2"]);
    const forward = reorderFreeformElements(document, ["fr_1"], "forward");
    expect(forward.elements.map((item) => item.id)).toEqual(["fr_2", "fr_1", "fr_3"]);
    const backward = reorderFreeformElements(document, ["fr_3"], "backward");
    expect(backward.elements.map((item) => item.id)).toEqual(["fr_1", "fr_3", "fr_2"]);
  });

  it("FT-21 复制粘贴偏移 +16/+16 并重生成 id，越权 assetRef 降级为占位", () => {
    const image = element({ id: "fr_img", kind: "image", x: 0, y: 0, w: 60, h: 60, assetRef: "fa_keepme", imageFit: "contain", alt: "", sourceWidth: 0, sourceHeight: 0 });
    const base = emptyDocument([first, image]);
    const clipboard = copyFreeformElements(base, ["fr_1"]);
    expect(clipboard?.elements).toHaveLength(1);
    const pasted = pasteFreeformClipboard(base, clipboard!);
    const pastedElement = pasted.document.elements.at(-1)!;
    expect(pastedElement.id).not.toBe("fr_1");
    expect(pastedElement.x).toBe(16);
    expect(pastedElement.y).toBe(16);
    const unauthorized = duplicateFreeformElements(base, ["fr_img"], { availableAssetIds: [] });
    expect(unauthorized.document.elements.at(-1)!.assetRef).toBe(FREEFORM_ASSET_PLACEHOLDER_ID);
    const authorized = duplicateFreeformElements(base, ["fr_img"], { availableAssetIds: ["fa_keepme"] });
    expect(authorized.document.elements.at(-1)!.assetRef).toBe("fa_keepme");
  });
});

// AC5 / FT-40 / FT-41：命令栈合并、50 步上限、可重放到同一最终状态。
describe("AC5 撤销重做（FT-40 / FT-41）", () => {
  const first = element({ id: "fr_1", kind: "rect", x: 0, y: 0, w: 100, h: 100, cornerStyle: "rounded" });
  const second = element({ id: "fr_2", kind: "sticky", x: 300, y: 0, w: 100, h: 100, text: "便签", tone: "neutral" });
  const document = emptyDocument([first, second]);

  it("命令栈最多保留 50 步，超出后丢弃最早命令", () => {
    let history = createFreeformHistory();
    let current = document;
    for (let step = 0; step < FREEFORM_HISTORY_LIMIT + 12; step += 1) {
      const next = moveFreeformElements(current, ["fr_1"], 1, 0);
      const command = buildFreeformCommand("move", current, next);
      expect(command).not.toBeNull();
      history = pushFreeformCommand(history, command!);
      current = next;
    }
    expect(history.past).toHaveLength(FREEFORM_HISTORY_LIMIT);
    expect(current.elements[0].x).toBe(FREEFORM_HISTORY_LIMIT + 12);
  });

  it("FT-41 不同操作路径重放到同一最终状态，且撤销/重做可回到原状", () => {
    const moveFirst = moveFreeformElements(document, ["fr_1"], 20, 0);
    const styleSecond = withElements(moveFirst, moveFirst.elements.map((item) =>
      item.id === "fr_2" ? { ...item, style: { ...item.style, fill: "#123456" } } : item));
    const pathA = styleSecond;

    const styleFirst = withElements(document, document.elements.map((item) =>
      item.id === "fr_2" ? { ...item, style: { ...item.style, fill: "#123456" } } : item));
    const pathB = moveFreeformElements(styleFirst, ["fr_1"], 20, 0);

    expect(freeformDocumentFingerprint(pathB)).toBe(freeformDocumentFingerprint(pathA));

    const command = buildFreeformCommand("move", document, pathA)!;
    const applied = applyFreeformCommand(document, command);
    expect(freeformDocumentFingerprint(applied)).toBe(freeformDocumentFingerprint(pathA));
    const reverted = applyFreeformCommand(applied, command, "backward");
    expect(freeformDocumentFingerprint(reverted)).toBe(freeformDocumentFingerprint(document));
  });

  it("undo/redo 通过历史对象往返且重做栈在新命令产生后被清空", () => {
    const next = moveFreeformElements(document, ["fr_1"], 5, 5);
    const command = buildFreeformCommand("move", document, next)!;
    let history = pushFreeformCommand(createFreeformHistory(), command);
    const undone = undoFreeformCommand(history, next)!;
    expect(undone.document.elements.find((item) => item.id === "fr_1")!.x).toBe(0);
    history = undone.history;
    const redone = redoFreeformCommand(history, undone.document)!;
    expect(redone.document.elements.find((item) => item.id === "fr_1")!.x).toBe(5);
    expect(pushFreeformCommand(redone.history, buildFreeformCommand("move", redone.document, moveFreeformElements(redone.document, ["fr_1"], 1, 0))!).future).toEqual([]);
  });

  it("删除「不支持的元素」后可被撤销恢复，unknown 容器不得静默丢失", () => {
    const before = emptyDocument([first], [{ id: "fr_unknown", raw: { id: "fr_unknown", kind: "sparkle" } }]);
    const after = { ...before, unsupported: [] };
    const command = buildFreeformCommand("delete", before, after)!;
    expect(command.beforeUnsupported).toHaveLength(1);
    const applied = applyFreeformCommand(before, command);
    expect(applied.unsupported).toEqual([]);
    const reverted = applyFreeformCommand(applied, command, "backward");
    expect(reverted.unsupported.map((item) => item.id)).toEqual(["fr_unknown"]);
    expect(freeformDocumentFingerprint(reverted)).toBe(freeformDocumentFingerprint(before));
  });
});

// AC5 / FT-42：三类导出内容断言，且导出物只含自由层数据。
describe("AC5 导出（FT-42）", () => {
  const document = emptyDocument([
    element({ id: "fr_rect", kind: "rect", x: 10, y: 10, w: 100, h: 60, cornerStyle: "rounded" }),
    element({ id: "fr_img", kind: "image", x: 200, y: 10, w: 80, h: 80, assetRef: "fa_shot", imageFit: "contain", alt: "图", sourceWidth: 10, sourceHeight: 10 }),
    element({ id: "fr_hidden", kind: "ellipse", x: 500, y: 500, w: 10, h: 10, hidden: true }),
  ]);

  it("PNG 采用 2x 像素比常量；SVG 为矢量输出且不含脚本与外部链接", () => {
    expect(FREEFORM_PNG_SCALE).toBe(2);
    const svg = buildFreeformSvg(document, { assetUrl: freeformAssetUrl });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/data:/i);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/i);
    expect(svg).toContain("/api/freeform-assets/fa_shot");
    expect(svg).not.toContain("fr_hidden");
  });

  it("JSON 导出包含 schemaVersion 与 unsupported，且不含交付字段", () => {
    const parsed = JSON.parse(buildFreeformExportJson(document));
    expect(parsed.schemaVersion).toBe(FREEFORM_SCHEMA_VERSION);
    expect(parsed.elements).toHaveLength(3);
    expect(parsed.unsupported).toEqual([]);
    expect(listDeliveryFieldLeaks(parsed)).toEqual([]);
  });
});

// AC4 / FT-33 与 6.2/6.3：受控资源白名单、magic number、CSP、占位策略。
describe("AC4 受控图片引用（FT-33 的数据契约部分）", () => {
  it("magic number 只识别白名单格式，不因扩展名或声明而放行", () => {
    expect(freeformAssetMimeFromMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe("image/png");
    expect(freeformAssetMimeFromMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(freeformAssetMimeFromMagic(new TextEncoder().encode("GIF89a...."))).toBe("image/gif");
    expect(freeformAssetMimeFromMagic(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe("image/webp");
    expect(freeformAssetMimeFromMagic(new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\">"))).toBeNull();
  });

  it("MIME 白/黑名单明确，SVG 与 HTML 必须被拒绝", () => {
    expect(isFreeformAssetMimeAllowed("image/png")).toBe(true);
    expect(isFreeformAssetMimeAllowed("image/gif")).toBe(true);
    expect(isFreeformAssetMimeAllowed("image/svg+xml")).toBe(false);
    expect(isFreeformAssetMimeDenied("image/svg+xml")).toBe(true);
    expect(isFreeformAssetMimeDenied("text/html")).toBe(true);
    expect(isFreeformAssetMimeDenied("application/javascript")).toBe(true);
    expect(isFreeformAssetMimeDenied("image/png")).toBe(false);
  });

  it("资源端点带严格 CSP 与 nosniff，且 URL 做编码", () => {
    const headers = applyFreeformAssetSecurityHeaders();
    expect(headers["Content-Security-Policy"]).toContain("script-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(freeformAssetUrl("fa_a/b")).toBe("/api/freeform-assets/fa_a%2Fb");
  });

  it("图片元素只接受 fa_ 前缀引用，URL/data:/blob: 一律拒绝", () => {
    const base = { id: "fr_img", kind: "image", x: 0, y: 0, w: 10, h: 10, rotation: 0, groupId: null, style: {}, locked: false, hidden: false, createdAt: "", updatedAt: "", imageFit: "contain", alt: "", sourceWidth: 0, sourceHeight: 0 };
    expect(normalizeFreeformElement({ ...base, assetRef: "fa_ok" })).not.toBeNull();
    for (const bad of ["https://evil.example/x.png", "data:image/png;base64,AAAA", "blob:http://x/y", "javascript:alert(1)"]) {
      expect(normalizeFreeformElement({ ...base, assetRef: bad })).toBeNull();
      expect(freeformSaveSchema.safeParse({ schemaVersion: FREEFORM_SCHEMA_VERSION, elements: [{ ...base, assetRef: bad }], unsupported: [], expectedUpdatedAt: null }).success).toBe(false);
    }
  });

  it("缺失/越权引用归一化为占位 id，渲染与导出都不产生任何资源请求", () => {
    const base = { id: "fr_img", kind: "image", x: 0, y: 0, w: 10, h: 10, rotation: 0, groupId: null, style: {}, locked: false, hidden: false, createdAt: "", updatedAt: "", imageFit: "contain", alt: "", sourceWidth: 0, sourceHeight: 0 };
    const normalized = normalizeFreeformElement({ ...base, assetRef: "" }, { allowMissingAssetRef: true });
    expect(normalized?.kind === "image" ? normalized.assetRef : "").toBe(FREEFORM_ASSET_PLACEHOLDER_ID);
    const svg = buildFreeformSvg(emptyDocument([normalized as FreeformElement]), { assetUrl: freeformAssetUrl });
    expect(svg).not.toMatch(/<image/);
    expect(svg).not.toContain("href=");
    expect(svg).not.toContain(FREEFORM_ASSET_PLACEHOLDER_ID);
  });
});

// AC6 / FT-50 的纯逻辑部分：手势状态机与工具切换。
describe("AC6 手势状态机（FT-50 纯逻辑部分）", () => {
  it("idle→selecting→committed 且 committed 后不再持有指针", () => {
    let state = createFreeformMachine("select");
    expect(state.phase).toBe("idle");
    state = freeformMachine(state, { type: "pointerdown", pointerId: 1, point: { x: 0, y: 0 }, hitIds: [] });
    expect(state.phase).toBe("selecting");
    state = freeformMachine(state, { type: "pointerup", pointerId: 1, point: { x: 40, y: 40 } });
    expect(state.phase).toBe("committed");
  });

  it("命中已有元素时进入 transforming 并保留 addtive 选择集", () => {
    let state = createFreeformMachine("select");
    state = freeformMachine(state, { type: "pointerdown", pointerId: 1, point: { x: 0, y: 0 }, hitIds: ["fr_1"] });
    expect(state.phase).toBe("active");
    expect(state.selection).toEqual(["fr_1"]);
    state = freeformMachine(state, { type: "pointerdown", pointerId: 2, point: { x: 0, y: 0 }, hitIds: ["fr_2"], additive: true, transform: "move" });
    expect(state.phase).toBe("transforming");
    expect(state.selection).toEqual(["fr_1", "fr_2"]);
  });

  it("工具切换不丢失选中集，Escape 清空指针与选中", () => {
    let state = freeformMachine(createFreeformMachine("select"), { type: "pointerdown", pointerId: 1, point: { x: 0, y: 0 }, hitIds: ["fr_1"] });
    state = freeformMachine(state, { type: "tool", tool: "rect" });
    expect(state.selection).toEqual(["fr_1"]);
    expect(state.tool).toBe("rect");
    const escaped = freeformMachine(state, { type: "escape" });
    expect(escaped.selection).toEqual([]);
    expect(escaped.pointerId).toBeNull();
  });
});