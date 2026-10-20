import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function captureSidebarRoster(page: Page, testInfo: TestInfo, name: string) {
  const aside = page.locator("aside").first();
  await expect(aside).toBeVisible();
  const box = await aside.boundingBox();
  if (box) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: screenshotPath,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.min(box.width + 24, 360),
        height: Math.min(Math.max(box.height * 0.55, 320), 480),
      },
    });
    await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
    return;
  }
  await captureScreenshot(page, testInfo, name);
}

test("sidebar roster shows Working… while a run is active", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `work-status-${stamp}@seepients.test`, "password12", "Work Status");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const sidebar = page.locator("aside").first();
  const row = sidebar.locator(`[data-roster-bot-id="${botId}"]`);
  await expect(row).toBeVisible();

  try {
    const composer = page.locator('textarea[name="chat-message"]');
    await composer.fill("keep working until I stop you");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const statusLabel = row.getByText("Working…", { exact: true });
    await expect(statusLabel).toBeVisible();
    await expect(row).not.toContainText("keep working until I stop you");
    const workingColor = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--status-working)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(statusLabel).toHaveCSS("color", workingColor);
    await expect(statusLabel).toHaveCSS("font-weight", "600");
    await captureSidebarRoster(page, testInfo, "sidebar-work-status-working");
  } finally {
    await rpc(page, "threads/stop", { botId }).catch(() => undefined);
  }
});
