import { expect, test } from "@playwright/test";

const projectId = "93775248-c4e3-4697-8ef9-41d5dd1b8a21";
const diagramId = "7283a719-5955-4d1d-9659-fcaaa2f10053";
const nodeId = "2be2c3da-fd26-4dff-a877-2bb7431ab7d0";

test.use({ channel: "chrome" });

test("silently opens the Agent-requested canvas in the originating page", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: () => "browser-context-1",
    });
  });
  await page.route(`**/api/projects/${projectId}/agent-events`, async (route) => {
    const event = {
      type: "CUSTOM",
      name: "productdesign.navigation.requested",
      value: {
        projectId,
        sessionId: "session-1",
        contextId: "browser-context-1",
        diagramId,
        nodeId,
        silent: true,
        source: "agent",
      },
      timestamp: Date.now(),
    };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: `id: 1\ndata: ${JSON.stringify(event)}\n\n`,
    });
  });

  await page.goto(`/#/projects/${projectId}`, { waitUntil: "domcontentloaded" });
  const targetHash = `#/canvas/${diagramId}?node=${nodeId}`;
  await page.waitForURL((url) => url.hash === targetHash);
  expect(new URL(page.url()).hash).toBe(targetHash);
  await expect(page.getByText("Agent 页面上下文与实时同步", { exact: true }).first()).toBeVisible();
});
