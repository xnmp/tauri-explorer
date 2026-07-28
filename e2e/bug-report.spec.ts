/** In-app bug and feature reports (#547). */

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function runPaletteCommand(page: import("@playwright/test").Page, query: string) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill(query);
  await page.keyboard.press("Enter");
}

function evidencePath(name: string): string {
  return process.env.CAPTURE_EVIDENCE ? `evidence/${name}` : `test-results/${name}`;
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

for (const command of ["Report a Bug", "Request a Feature"]) {
  test(`${command} submits in-app and links the created issue`, async ({ page }) => {
    await page.goto("/");
    await waitForEntries(page);

    await runPaletteCommand(page, command);
    const dialog = page.getByRole("dialog", { name: /report|request/i });
    await dialog.getByLabel("Title").fill(`${command} title`);
    await dialog.getByLabel("Description").fill("Typed description");
    await dialog.getByLabel(/How can we reach you/).fill("@playwright-reporter");
    await page.keyboard.press("Control+Enter");

    await expect(dialog).toBeHidden();
    const toast = page.locator(".toast.success");
    await expect(toast).toContainText("Issue #5470");
    await expect(toast.getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/xnmp/tauri-explorer/issues/5470",
    );
  });
}

test("report dialog footer buttons use the themed control treatment", async ({ page }) => {
  for (const [command, name, screenshot] of [
    ["Report a Bug", /report a bug/i, "ac-1-report-dialog-buttons.png"],
    ["Request a Feature", /request a feature/i, "ac-1-feature-dialog-buttons.png"],
  ] as const) {
    await page.goto("/");
    await waitForEntries(page);
    await runPaletteCommand(page, command);

    const dialog = page.getByRole("dialog", { name });
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const submit = dialog.getByRole("button", { name: "Submit" });
    const styles = await Promise.all([cancel, submit].map((button) => button.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        borderRadius: computed.borderRadius,
        borderStyle: computed.borderStyle,
        backgroundColor: computed.backgroundColor,
      };
    })));

    expect(styles[0].borderRadius).not.toBe("0px");
    expect(styles[0].borderStyle).toBe("solid");
    expect(styles[0].backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(styles[1].borderRadius).not.toBe("0px");
    expect(styles[1].backgroundColor).not.toBe(styles[0].backgroundColor);

    await cancel.hover();
    await expect.poll(() => cancel.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(styles[0].backgroundColor);

    await dialog.getByLabel("Title").fill("Keyboard focus styling");
    await dialog.getByLabel("Description").fill("Keyboard focus styling");
    await submit.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(submit).toBeFocused();
    await expect.poll(() => submit.evaluate((element) => getComputedStyle(element).outlineStyle))
      .toBe("solid");

    await page.screenshot({ path: evidencePath(screenshot) });
  }
});

test("failed submission preserves the draft in the GitHub fallback", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("mock-report-error", "daily_cap"));

  await runPaletteCommand(page, "Request a Feature");
  const dialog = page.getByRole("dialog", { name: /request/i });
  await dialog.getByLabel("Title").fill("Keep my feature title");
  await dialog.getByLabel("Description").fill("Keep my typed description 🐛");
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Reports are temporarily unavailable",
  );
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
    .not.toBeNull();
  const url = new URL(
    (await page.evaluate(() => localStorage.getItem("mock-opened-url")))!,
  );
  expect(url.searchParams.get("title")).toBe("Keep my feature title");
  expect(url.searchParams.get("body")).toContain("Keep my typed description 🐛");
  expect(url.searchParams.get("labels")).toBe("enhancement");
});

test("image picker shows named previews and lets the user remove an attachment", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await runPaletteCommand(page, "Report a Bug");
  const dialog = page.getByRole("dialog", { name: /report a bug/i });

  await dialog.getByLabel("Add images").setInputFiles([
    { name: "first-screenshot.png", mimeType: "image/png", buffer: png },
    { name: "second-screenshot.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 1]) },
  ]);

  await expect(dialog.getByText("first-screenshot.png")).toBeVisible();
  await expect(dialog.getByText("second-screenshot.jpg")).toBeVisible();
  await expect(dialog.getByRole("img", { name: "first-screenshot.png" })).toBeVisible();
  await dialog.getByRole("button", { name: "Remove second-screenshot.jpg" }).click();
  await expect(dialog.getByText("second-screenshot.jpg")).toBeHidden();
  await expect(dialog.getByText("first-screenshot.png")).toBeVisible();
  await page.screenshot({ path: evidencePath("ac-1-image-picker-previews.png") });
});

test("clipboard image is offered and attached without creating a file", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("mock-report-clipboard-image", "1"));
  await runPaletteCommand(page, "Request a Feature");
  const dialog = page.getByRole("dialog", { name: /request a feature/i });

  await dialog.getByRole("button", { name: "Attach from clipboard" }).click();

  await expect(dialog.getByText("Clipboard screenshot.png")).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Clipboard screenshot.png" })).toBeVisible();
  await page.screenshot({ path: evidencePath("ac-2-clipboard-image.png") });
});

test("clipboard action is absent when the clipboard has no image", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await runPaletteCommand(page, "Report a Bug");

  await expect(page.getByRole("button", { name: "Attach from clipboard" })).toHaveCount(0);
});

test("invalid image keeps the report draft and existing attachments", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await runPaletteCommand(page, "Report a Bug");
  const dialog = page.getByRole("dialog", { name: /report a bug/i });
  await dialog.getByLabel("Title").fill("Keep this title");
  await dialog.getByLabel("Description").fill("Keep this description");
  await dialog.getByLabel("Add images").setInputFiles({
    name: "valid.png", mimeType: "image/png", buffer: png,
  });
  await dialog.getByLabel("Add images").setInputFiles({
    name: "not-an-image.txt", mimeType: "text/plain", buffer: Buffer.from("text"),
  });

  await expect(dialog.getByRole("alert")).toContainText("PNG, JPEG, or GIF");
  await expect(dialog.getByLabel("Title")).toHaveValue("Keep this title");
  await expect(dialog.getByLabel("Description")).toHaveValue("Keep this description");
  await expect(dialog.getByText("valid.png")).toBeVisible();
  await page.screenshot({ path: evidencePath("ac-4-invalid-image-preserves-draft.png") });
});

test("successful submission forwards selected images to the native report command", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await runPaletteCommand(page, "Report a Bug");
  const dialog = page.getByRole("dialog", { name: /report a bug/i });
  await dialog.getByLabel("Title").fill("Attachment contract");
  await dialog.getByLabel("Description").fill("The screenshot must reach the relay.");
  await dialog.getByLabel("Add images").setInputFiles({
    name: "contract.png", mimeType: "image/png", buffer: png,
  });
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(dialog).toBeHidden();
  const submitted = await page.evaluate(() => localStorage.getItem("mock-submitted-report"));
  expect(JSON.parse(submitted!).attachments).toEqual([
    expect.objectContaining({ name: "contract.png", mediaType: "image/png" }),
  ]);
});

test("failed report with an attachment preserves both instead of opening a lossy fallback", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("mock-report-error", "network_unreachable"));
  await runPaletteCommand(page, "Report a Bug");
  const dialog = page.getByRole("dialog", { name: /report a bug/i });
  await dialog.getByLabel("Title").fill("Keep attachment title");
  await dialog.getByLabel("Description").fill("Keep attachment description");
  await dialog.getByLabel("Add images").setInputFiles({
    name: "keep.png", mimeType: "image/png", buffer: png,
  });
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(dialog.getByRole("alert")).toContainText("attachments");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue("Keep attachment title");
  await expect(dialog.getByText("keep.png")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
    .toBeNull();
  await page.screenshot({ path: evidencePath("ac-5-failure-preserves-attachments.png") });
});

test("draft stays editable when both relay and browser fallback fail", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => {
    localStorage.setItem("mock-report-error", "network_unreachable");
    localStorage.setItem("mock-open-url-error", "1");
  });

  await runPaletteCommand(page, "Report a Bug");
  const dialog = page.getByRole("dialog", { name: /report a bug/i });
  await dialog.getByLabel("Title").fill("Do not lose this title");
  await dialog.getByLabel("Description").fill("Do not lose this description");
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByRole("alert")).toContainText("your report is still here");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue("Do not lose this title");
  await expect(dialog.getByLabel("Description")).toHaveValue(
    "Do not lose this description",
  );
  await expect(dialog.getByRole("button", { name: "Submit" })).toBeEnabled();
});

test("unicode draft stays editable when it cannot fit in a fallback URL", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("mock-report-error", "network_unreachable"));

  await runPaletteCommand(page, "Report a Bug");
  const dialog = page.getByRole("dialog", { name: /report a bug/i });
  const description = "🐛".repeat(4000);
  await dialog.getByLabel("Title").fill("Keep the complete unicode draft");
  await dialog.getByLabel("Description").fill(description);
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByRole("alert")).toContainText("too long for GitHub");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Description")).toHaveValue(description);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
    .toBeNull();
});

test("Open Logs Folder navigates the pane to the log directory", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);

  await runPaletteCommand(page, "Open Logs Folder");

  await expect(page.locator(".status-path")).toHaveAttribute(
    "title",
    "/tmp/tauri-explorer/logs",
  );
});
