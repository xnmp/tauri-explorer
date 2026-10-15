import { expect, test } from "./fixtures";
import { waitForEntries } from "./helpers";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";
const bytes = Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex");
async function openReport(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Report Issue");
  await page.keyboard.press("Enter");
  return page.getByRole("dialog", { name: "Report Issue" });
}
test("picker video survives close and failed submission, retries and submits", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/"); await waitForEntries(page);
  let dialog = await openReport(page);
  await dialog.getByLabel("Title", { exact: true }).fill("Short video report");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "recording.mp4", mimeType: "video/mp4", buffer: bytes });
  await expect(dialog.getByRole("img", { name: "Video attachment" })).toBeVisible();
  await expect(dialog.getByText("recording.mp4", { exact: true })).toBeVisible();
  await expect(dialog.locator("img")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await openReport(page);
  await page.evaluate((key) => localStorage.setItem(key, "network_unreachable"), MOCK_LOCAL_KEYS.reportError);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.locator(".toast.error")).toContainText("Your text is saved");
  dialog = await openReport(page);
  await expect(dialog.getByText("recording.mp4", { exact: true })).toBeVisible();
  await dialog.screenshot({ path: process.env.CAPTURE_EVIDENCE ? "evidence/ac-1-picker-video.png" : "test-results/ac-1-picker-video.png", animations: "disabled" });
  await page.evaluate((key) => localStorage.removeItem(key), MOCK_LOCAL_KEYS.reportError);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.locator(".toast.success")).toContainText("Report submitted");
  const submitted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), MOCK_LOCAL_KEYS.submittedReport);
  expect(submitted.attachments).toEqual([{ name: "recording.mp4", mediaType: "video/mp4", data: bytes.toString("base64") }]);
});
test("copied video enables Attach from clipboard and supports removal", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/"); await waitForEntries(page);
  await page.evaluate((key) => localStorage.setItem(key, "1"), MOCK_LOCAL_KEYS.reportClipboardVideo);
  const dialog = await openReport(page);
  await expect(dialog.getByRole("button", { name: "Attach from clipboard" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Attach from clipboard" }).click();
  await expect(dialog.getByText("Copied video.mp4", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Video attachment" })).toBeVisible();
  await dialog.screenshot({ path: process.env.CAPTURE_EVIDENCE ? "evidence/ac-2-clipboard-video.png" : "test-results/ac-2-clipboard-video.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Remove Copied video.mp4" }).click();
  await expect(dialog.getByText("Copied video.mp4", { exact: true })).toHaveCount(0);
});

test("video rejection shows the relay reason and preserves the draft", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  const dialog = await openReport(page);
  await dialog.getByLabel("Title", { exact: true }).fill("Video attachment rejection");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "recording.mp4", mimeType: "video/mp4", buffer: bytes });
  await expect(dialog.getByText("recording.mp4", { exact: true })).toBeVisible();
  await page.evaluate(({ kindKey, messageKey }) => {
    localStorage.setItem(kindKey, "malformed_input");
    localStorage.setItem(messageKey, "Attachment type is invalid");
  }, { kindKey: MOCK_LOCAL_KEYS.reportError, messageKey: MOCK_LOCAL_KEYS.reportErrorMessage });
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.locator(".toast.error")).toContainText("Attachment type is invalid");
  await expect(page.locator(".toast.error")).toContainText("Your text is saved");
  await page.screenshot({ path: process.env.CAPTURE_EVIDENCE ? "evidence/1170-relay-rejection.png" : "test-results/1170-relay-rejection.png", animations: "disabled" });
  const restored = await openReport(page);
  await expect(restored.getByText("recording.mp4", { exact: true })).toBeVisible();
});

test("oversized video explains the limit in the dialog before submission", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  const dialog = await openReport(page);
  await dialog.getByLabel("Title", { exact: true }).fill("Large video attachment");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "large.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2097153) });
  await expect(dialog.getByRole("alert")).toContainText("2 MiB maximum");
  await expect(dialog.getByRole("alert")).toContainText("shorter clip");
  await expect(dialog.getByRole("img", { name: "Video attachment" })).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), MOCK_LOCAL_KEYS.submittedReport)).toBeNull();
  await dialog.screenshot({ path: process.env.CAPTURE_EVIDENCE ? "evidence/1170-video-size-limit.png" : "test-results/1170-video-size-limit.png", animations: "disabled" });
});
