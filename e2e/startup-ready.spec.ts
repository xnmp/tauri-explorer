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
