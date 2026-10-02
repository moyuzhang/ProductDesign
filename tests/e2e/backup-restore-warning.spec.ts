import { expect, test } from "@playwright/test";

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } });

// Deliberate response fixture: backend filesystem fault/commit handling is covered separately.
test("completed restore retains its archive warning after the modal closes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const backup = { id: "warning-fixture", label: "合成保护归档", reason: "UI warning fixture", itemCount: 1, createdAt: "2026-10-02T00:00:00Z" };
  const warning = "数据库和活动项目镜像已恢复成功；保护归档整理失败，原始文件保留在测试暂存目录，请检查后再处理。";
  let restores = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/restore")) {
      restores += 1;
      expect(route.request().postDataJSON()).toEqual({ confirmation: `RESTORE ${backup.id}` });
      return route.fulfill({ json: { ok: true, backup, restored: { projects: 1 }, protectionBackup: backup, partialProtection: false, warnings: [warning] } });
    }
    if (url.pathname === "/api/storage-retention") return route.fulfill({ status: 503, json: { message: "unused fixture" } });
    if (url.pathname === "/api/dashboard") return route.fulfill({ json: { totals: { unconfigured: 0 } } });
    if (url.pathname === "/api/backups") return route.fulfill({ json: { items: [backup], total: 1 } });
    return route.fulfill({ json: [] });
  });
  await page.goto("/#/backups");
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  const confirm = page.getByRole("button", { name: "确认恢复", exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(`输入 RESTORE ${backup.id} 以确认`).fill(`RESTORE ${backup.id}`);
  await confirm.click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("恢复已完成，请检查保护归档");
  await expect(page.getByRole("status")).toContainText(warning);
  expect(restores).toBe(1);
  expect(errors).toEqual([]);
});
