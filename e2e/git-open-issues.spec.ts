/** "Git: Open Issues in Browser" palette command (#1055). */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";

async function runOpenIssues(page: Page, shot?: string) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("issues");
  await expect(
    page.locator(".command-palette-dialog").getByText("Git: Open Issues in Browser"),
  ).toBeVisible();
  if (shot) {
    await page.waitForTimeout(500); // let the selected-row highlight settle
    await page.screenshot({ path: shot });
  }
  await page.keyboard.press("Enter");
}

const openedUrl = (page: Page) =>
  page.evaluate((key) => localStorage.getItem(key), MOCK_LOCAL_KEYS.openedUrl);

test("opens the repo's GitHub issues page in the browser", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await runOpenIssues(page, "evidence/ac-1-open-issues-palette.png");

  await expect.poll(() => openedUrl(page)).toBe("https://github.com/mock/project/issues");
});

test("explains and opens nothing outside a git repository", async ({ page }) => {
  await page.goto("/?path=/home/user");
  await waitForEntries(page);
  await runOpenIssues(page);

  await expect(page.locator(".toast")).toContainText("Not inside a git repository");
  await page.screenshot({ path: "evidence/ac-2-not-a-repo-toast.png" });
  expect(await openedUrl(page)).toBeNull();
});
