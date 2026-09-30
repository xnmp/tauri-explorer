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

async function delayAndCountReports(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (globalThis as typeof globalThis & { __MOCK_LATENCY__?: Record<string, number> })
      .__MOCK_LATENCY__ = { submit_user_report: 8000 };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "mock-submitted-report") {
        const completed = JSON.parse(localStorage.getItem("pending-report-completions") ?? "[]");
        completed.push(JSON.parse(value));
        setItem.call(this, "pending-report-completions", JSON.stringify(completed));
      }
      return setItem.call(this, key, value);
    };
  });
}

test("reopening a pending report cannot submit it twice and clears only its submitted text", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await delayAndCountReports(page);
  await page.goto("/");
  await waitForEntries(page);
  let dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("One pending report");
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog).toBeHidden();
  dialog = await openReportDialog(page);
  await expect(dialog.getByRole("button", { name: "Submitting…", exact: true })).toBeDisabled();
  await expect(page.locator(".toast.progress")).toContainText("Submitting report");
  await dialog.screenshot({ path: "screenshots/fix/pending-report-draft-ownership/pending-submission-disabled.png", animations: "disabled" });
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".toast.success")).toContainText("Report submitted", { timeout: 15000 });
  await expect(dialog.getByLabel("Title")).toHaveValue("");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pending-report-completions") ?? "[]").length)).toBe(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await waitForEntries(page);
  dialog = await openReportDialog(page);
  await expect(dialog.getByLabel("Title")).toHaveValue("");
});

test("a newer unsent draft survives the older report completing and application reload", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await delayAndCountReports(page);
  await page.goto("/");
  await waitForEntries(page);
  let dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("First sent report");
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog).toBeHidden();
  dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("New unsent draft");
  await dialog.getByLabel("Description").fill("This newer text must survive.");
  await expect(dialog.getByRole("button", { name: "Submitting…", exact: true })).toBeDisabled();
  await dialog.locator("footer").getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".toast.success")).toContainText("Report submitted", { timeout: 15000 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pending-report-completions") ?? "[]").length)).toBe(1);
  await page.reload();
  await waitForEntries(page);
  dialog = await openReportDialog(page);
  await expect(dialog.getByLabel("Title")).toHaveValue("New unsent draft");
  await expect(dialog.getByLabel("Description")).toHaveValue("This newer text must survive.");
  await dialog.screenshot({ path: "screenshots/fix/pending-report-draft-ownership/newer-draft-survives-reload.png", animations: "disabled" });
});

test("an already-open failed image report retries with its visible image", async ({ page }) => {
  await delayAndCountReports(page);
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => {
    localStorage.setItem("mock-report-error", "network_unreachable");
    localStorage.setItem("mock-report-clipboard-image", "1");
  });
  let dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("Retry the visible image");
  await dialog.getByRole("button", { name: "Attach from clipboard" }).click();
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog).toBeHidden();
  dialog = await openReportDialog(page);
  await expect(dialog.getByText("Clipboard screenshot.png")).toBeVisible();
  await expect(page.locator(".toast.error")).toContainText("Your text is saved", { timeout: 15000 });
  await page.evaluate(() => localStorage.removeItem("mock-report-error"));
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.locator(".toast.success")).toContainText("Report submitted", { timeout: 15000 });
  const submitted = await page.evaluate(() => JSON.parse(localStorage.getItem("mock-submitted-report")!));
  expect(submitted.attachments).toHaveLength(1);
  expect(submitted.attachments[0].name).toBe("Clipboard screenshot.png");
});

test("post-failure text and image edits survive closing and reopening", async ({ page }) => {
  await delayAndCountReports(page);
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => {
    localStorage.setItem("mock-report-error", "network_unreachable");
    localStorage.setItem("mock-report-clipboard-image", "1");
  });
  let dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("Original image report");
  await dialog.getByRole("button", { name: "Attach from clipboard" }).click();
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog).toBeHidden();
  dialog = await openReportDialog(page);
  await expect(page.locator(".toast.error")).toContainText("Your text is saved", { timeout: 15000 });
  await dialog.getByLabel("Title").fill("New draft after rejection");
  await dialog.getByRole("button", { name: "Remove Clipboard screenshot.png" }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  dialog = await openReportDialog(page);
  await expect(dialog.getByLabel("Title")).toHaveValue("New draft after rejection");
  await expect(dialog.getByText("Clipboard screenshot.png")).toHaveCount(0);
});

test("selected image reads keep Submit disabled across closing and reopening", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== "delayed-proof.png") return original.call(this);
      const file = this;
      localStorage.setItem("pending-report-image-read", "1");
      return new Promise<ArrayBuffer>((resolve, reject) => {
        (window as Window & { releaseReportImageRead?: () => void }).releaseReportImageRead =
          () => { void original.call(file).then(resolve, reject); };
      });
    };
  });
  let dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("Report the selected image");
  await dialog.getByLabel("Add images").setInputFiles({
    name: "delayed-proof.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=", "base64"),
  });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pending-report-image-read"))).toBe("1");
  await expect(dialog.getByRole("button", { name: "Reading images…", exact: true })).toBeDisabled();
  await page.keyboard.press("Control+Enter");
  expect(await page.evaluate(() => localStorage.getItem("mock-submitted-report"))).toBeNull();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  dialog = await openReportDialog(page);
  await expect(dialog.getByRole("button", { name: "Reading images…", exact: true })).toBeDisabled();
  await page.evaluate(() => (window as Window & { releaseReportImageRead?: () => void }).releaseReportImageRead!());
  await expect(dialog.getByText("delayed-proof.png")).toBeVisible();
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.locator(".toast.success")).toContainText("Report submitted");
  const submitted = await page.evaluate(() => JSON.parse(localStorage.getItem("mock-submitted-report")!));
  expect(submitted.attachments).toHaveLength(1);
  expect(submitted.attachments[0].name).toBe("delayed-proof.png");
});

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

  let dialog = await openReportDialog(page);
  await dialog.getByRole("button", { name: "Feature" }).click();
  await dialog.getByLabel("Title").fill("Submitted title");
  await dialog.getByLabel("Description").fill("Submitted description");
  await dialog.getByLabel(/How can we reach you/).fill("@submitted-reporter");
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
  await expect(page.locator(".toast.error")).toContainText(
    "Your text is saved; images remain available until this window closes",
  );

  dialog = await openReportDialog(page);
  await expect(dialog.getByLabel("Title")).toHaveValue("Retry with image");
  await expect(dialog.getByText("Clipboard screenshot.png")).toBeVisible();
  await dialog.screenshot({ path: evidencePath("ac-4-failed-report-retry.png") });
});
