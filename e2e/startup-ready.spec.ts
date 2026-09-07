import { test, expect } from "./fixtures";

for (const path of ["/home/user", "/home/user/Archive"]) {
  test(`startup reports a usable explorer for ${path}`, async ({ page }) => {
    const reports: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Startup(webview):")) reports.push(message.text());
    });
    await page.goto(`/?path=${path}`);
    await expect.poll(() => reports.length).toBe(1);
    expect(reports[0]).toContain("commands-ready=");
    expect(reports[0]).toContain("settings-ready=");
    expect(reports[0]).toContain("list-ready=");
    expect(reports[0]).toContain("ui-ready=");

    // Exercise real navigation and file selection immediately after the signal.
    await page.locator(".sidebar").getByRole("button", { name: "Documents", exact: true }).click();
    const entry = page.locator(".entry-item").first();
    await expect(entry).toBeVisible();
    await page.keyboard.press("Control+a");
    await expect(entry).toHaveClass(/selected/);
    expect(reports).toHaveLength(1);
  });
}

test("optional window priming follows foreground readiness when configuration is slow", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const timeline: Array<{ command: string; time: number }> = [];
    const host = window as Window & {
      __mockInvokeCounts?: Record<string, number>;
      __sessionTimeline?: typeof timeline;
    };
    host.__sessionTimeline = timeline;
    host.__mockInvokeCounts = new Proxy<Record<string, number>>({}, {
      set(target, command, value) {
        if (command === "warm_pool_begin_spawn" || command === "log_startup_timing") {
          timeline.push({ command, time: performance.now() });
        }
        target[String(command)] = value;
        return true;
      },
    });
  });
  await page.goto("/?path=/home/user&mockLatency=read_config_file:3000");
  await expect.poll(() => page.evaluate(() => {
    const timeline = (window as Window & { __sessionTimeline: Array<{ command: string; time: number }> }).__sessionTimeline;
    return timeline.map(item => item.command);
  }), { timeout: 15_000 }).toEqual(expect.arrayContaining(["log_startup_timing", "warm_pool_begin_spawn"]));
  const timeline = await page.evaluate(() =>
    (window as Window & { __sessionTimeline: Array<{ command: string; time: number }> }).__sessionTimeline);
  const ready = timeline.find(item => item.command === "log_startup_timing")!;
  const prime = timeline.find(item => item.command === "warm_pool_begin_spawn")!;
  console.log("[session-startup-order]", timeline);
  expect(prime.time).toBeGreaterThan(ready.time);
  await page.locator(".sidebar").getByRole("button", { name: "Documents", exact: true }).click();
  const entry = page.locator(".entry-item").first();
  await expect(entry).toBeVisible();
  await page.keyboard.press("Control+a");
  await expect(entry).toHaveClass(/selected/);
  if (testInfo.project.name === "chromium") {
    const { mkdirSync } = await import("node:fs");
    mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
    await page.screenshot({ path: "screenshots/refactor/repo-health-cleanup/session-startup-ready.png" });
  }
});
