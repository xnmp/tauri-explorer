import { expect, test } from "./fixtures";
import { waitForEntries } from "./helpers";

function evidencePath(name: string): string {
  return process.env.CAPTURE_EVIDENCE ? `evidence/${name}` : `test-results/${name}`;
}

async function openReportDialog(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Report Issue");
  await page.keyboard.press("Enter");
  return page.getByRole("dialog", { name: "Report Issue" });
}

test("an unsent report survives closing the dialog and restarting the app", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.removeItem("user-report-draft"));

  let dialog = await openReportDialog(page);
  await dialog.getByRole("button", { name: "Feature" }).click();
  await dialog.getByLabel("Title").fill("Persist this title");
  await dialog.getByLabel("Description").fill("Persist this description");
  await dialog.getByLabel(/How can we reach you/).fill("@persistent-reporter");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  dialog = await openReportDialog(page);
  await expect(dialog.getByRole("button", { name: "Feature" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("Title")).toHaveValue("Persist this title");
  await expect(dialog.getByLabel("Description")).toHaveValue("Persist this description");
  await expect(dialog.getByLabel(/How can we reach you/)).toHaveValue("@persistent-reporter");
  await dialog.screenshot({ path: evidencePath("ac-1-reopened-report-draft.png") });
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await page.reload();
  await waitForEntries(page);
  dialog = await openReportDialog(page);
  await expect(dialog.getByRole("button", { name: "Feature" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("Title")).toHaveValue("Persist this title");
  await expect(dialog.getByLabel("Description")).toHaveValue("Persist this description");
  await expect(dialog.getByLabel(/How can we reach you/)).toHaveValue("@persistent-reporter");
  await dialog.screenshot({ path: evidencePath("ac-2-restarted-report-draft.png") });
});

test("a successful report clears its saved text", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("user-report-draft", JSON.stringify({
    kind: "feature",
    title: "Submitted title",
    body: "Submitted description",
    contact: "@submitted-reporter",
  })));

  let dialog = await openReportDialog(page);
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".toast.success")).toContainText("Report submitted");

  dialog = await openReportDialog(page);
  await expect(dialog.getByRole("button", { name: "Bug" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("Title")).toHaveValue("");
  await expect(dialog.getByLabel("Description")).toHaveValue("");
  await expect(dialog.getByLabel(/How can we reach you/)).toHaveValue("");
  await dialog.screenshot({ path: evidencePath("ac-3-submitted-report-clears-draft.png") });
});

test("a failed report keeps its in-session attachment retry draft", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => {
    localStorage.setItem("mock-report-error", "network_unreachable");
    localStorage.setItem("mock-report-clipboard-image", "1");
  });

  let dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("Retry with image");
  await dialog.getByRole("button", { name: "Attach from clipboard" }).click();
  await expect(dialog.getByText("Clipboard screenshot.png")).toBeVisible();
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".toast.error")).toContainText("saved for retry");

  dialog = await openReportDialog(page);
  await expect(dialog.getByLabel("Title")).toHaveValue("Retry with image");
  await expect(dialog.getByText("Clipboard screenshot.png")).toBeVisible();
  await dialog.screenshot({ path: evidencePath("ac-4-failed-report-retry.png") });
});
