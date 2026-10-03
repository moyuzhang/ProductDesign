import { expect, test } from "./historical-fixtures";

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } });

test("silently opens the Agent-requested canvas in the originating page", async ({ page, historicalProject }) => {
  const { projectId, diagramId, nodeId } = historicalProject;
  // Deliberate SSE simulation: this verifies browser navigation, not a real Agent run.
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
