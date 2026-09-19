import { chromium } from "@playwright/test";

const url = "http://127.0.0.1:4310/#/canvas/3f7ddb1c-9afe-4df4-99a0-03be7e0550be/node/tech-be-root?tab=development";
const browser = await chromium.launch({ executablePath: "C:\\Users\\94058\\AppData\\Local\\ms-playwright\\chromium-1200\\chrome-win64\\chrome.exe" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);

const info = await page.evaluate(() => {
  // inject a realistic rejection block with long tokens inside the delivery console
  const host = document.querySelector(".plan-delivery-console") || document.body;
  const div = document.createElement("div");
  div.className = "plan-delivery-rejection";
  div.innerHTML = "<strong>最近退回原因</strong><span>返工第二轮独立审计失败（审计证据 717b8ad6-80ec-4c... DargLine--Xmx768m 编译即失败（BUILD FAILURE: IdempotentCommandResult&lt;CreationResult&gt; 无法转换，施工证据 1b391052 声称的 97/97 全绿 BUILD SUCCESS 修订不可复现）第一轮 blocker5 复发并恶化：证据 dig 12 位有 5 个与当前工作区不一致（SystemIdempotencyService/IdempotencyQueryConstruct 迁移）均于证据提交（2026-08-30T16:05:22, 00:13:46）后工作区持续被并发修改（00:09:14/00:09:56/00:13:44 IdempotentCommandResult.java、修改 AccountAdmin... AccountAdminController 与 AccountAdminService 类型重复码在当前工作区真实存在（8 写端点 Idempotency-Key +requireIdempotencyKey 拒绝空/超长键、begin 竞态分 409、requestId 回读端点 system:audit:read+账户隔离+参数回归）但编译失败导致全部未经验证 0 测试执行；B2 证据 SHA-256 5/10 与工作区不符（交付物仍被持续修改（未冻结）。要求施工者冻结交付（交付物仍被持续修改（未冻结）</span>";
  host.appendChild(div);
  const box = div.getBoundingClientRect();
  return {
    overflow: div.scrollWidth > div.clientWidth + 1,
    clientWidth: div.clientWidth,
    scrollWidth: div.scrollWidth,
    spanOverflowWrap: getComputedStyle(div.querySelector("span")).overflowWrap,
  };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "artifacts/rejection-fixed.png", fullPage: false });
await browser.close();
