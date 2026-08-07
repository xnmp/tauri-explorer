/** In-app bug and feature reports (#547). */

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function runPaletteCommand(page: import("@playwright/test").Page, query: string) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill(query);
  await page.keyboard.press("Enter");
}

async function openReportDialog(
  page: import("@playwright/test").Page,
  kind: "bug" | "feature" = "bug",
) {
  await runPaletteCommand(page, "Report Issue");
  const dialog = page.getByRole("dialog", { name: "Report Issue" });
  if (kind === "feature") {
    await dialog.getByRole("button", { name: "Feature" }).click();
  }
  return dialog;
}

function evidencePath(name: string): string {
  return process.env.CAPTURE_EVIDENCE ? `evidence/${name}` : `test-results/${name}`;
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

for (const kind of ["bug", "feature"] as const) {
  test(`${kind} reports submit in-app and link the created issue`, async ({ page }) => {
    await page.goto("/");
    await waitForEntries(page);

    const dialog = await openReportDialog(page, kind);
    await expect(dialog.getByRole("button", { name: "Bug" })).toHaveAttribute(
      "aria-pressed",
      String(kind === "bug"),
    );
    await expect(dialog.getByRole("button", { name: "Feature" })).toHaveAttribute(
      "aria-pressed",
      String(kind === "feature"),
    );
    await dialog.getByLabel("Title").fill(`${kind} report title`);
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

test("report submission closes before the native command completes", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __MOCK_LATENCY__?: Record<string, number>;
    }).__MOCK_LATENCY__ = { submit_user_report: 800 };
  });

  const dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("Optimistic report");
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(dialog).toBeHidden({ timeout: 300 });
  expect(await page.evaluate(() => localStorage.getItem("mock-submitted-report"))).toBeNull();
  await expect(page.locator(".toast.success")).toContainText("Issue #5470");
});

/**
 * #596: the dialog closes on Submit, so a slow relay used to leave the user
 * with no evidence the report went anywhere until the success toast landed.
 * The in-flight toast must be up while the request is still outstanding, and
 * must be gone once the outcome toast replaces it.
 */
test("an in-flight report announces itself before the outcome toast", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __MOCK_LATENCY__?: Record<string, number>;
    }).__MOCK_LATENCY__ = { submit_user_report: 2000 };
  });

  const dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("Slow relay report");
  await dialog.getByRole("button", { name: "Submit" }).click();

  const pending = page.locator(".toast.info");
  await expect(pending).toContainText("Submitting report…", { timeout: 500 });
  await expect(dialog).toBeHidden();
  // Fully faded in, not a mid-animation frame.
  await expect
    .poll(() => pending.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
  // Still outstanding: the mock has not recorded the submission yet.
  expect(await page.evaluate(() => localStorage.getItem("mock-submitted-report"))).toBeNull();
  await page.screenshot({ path: evidencePath("issue-596-submitting-toast.png") });

  await expect(page.locator(".toast.success")).toContainText("Issue #5470");
  await expect(pending).toBeHidden();
  await page.screenshot({ path: evidencePath("issue-596-submitted-toast.png") });
});

test("a failed report retires the in-flight toast before the error toast", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("mock-report-error", "daily_cap"));

  const dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("Doomed report");
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByRole("alert")).toContainText("Reports are temporarily unavailable");
  await expect(page.locator(".toast.info")).toBeHidden();
});

test("the single Report Issue command defaults to bug and accepts a blank description", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("mock-report-clipboard-image", "1"));

  const dialog = await openReportDialog(page);
  await expect(dialog.getByLabel("Description")).not.toHaveAttribute("required", "");
  await expect(dialog.getByRole("button", { name: "Attach from clipboard" })).toBeVisible();
  await dialog.getByLabel("Title").fill("Title-only bug");
  await page.screenshot({ path: evidencePath("issues-587-588-report-issue.png") });
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(dialog).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-submitted-report")))
    .not.toBeNull();
  const submitted = await page.evaluate(() => localStorage.getItem("mock-submitted-report"));
  expect(JSON.parse(submitted!)).toMatchObject({
    title: "Title-only bug",
    body: "",
    kind: "bug",
  });
});

test("report dialog footer buttons use the themed control treatment", async ({ page }) => {
  for (const [kind, screenshot] of [
    ["bug", "ac-1-report-dialog-buttons.png"],
    ["feature", "ac-1-feature-dialog-buttons.png"],
  ] as const) {
    await page.goto("/");
    await waitForEntries(page);
    const dialog = await openReportDialog(page, kind);
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

  const dialog = await openReportDialog(page, "feature");
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
  const dialog = await openReportDialog(page);

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

test("feature dialog also accepts multiple image files", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  const dialog = await openReportDialog(page, "feature");

  await dialog.getByLabel("Add images").setInputFiles([
    { name: "feature-first.png", mimeType: "image/png", buffer: png },
    { name: "feature-second.png", mimeType: "image/png", buffer: png },
  ]);

  await expect(dialog.getByText("feature-first.png")).toBeVisible();
  await expect(dialog.getByText("feature-second.png")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Remove / })).toHaveCount(2);
});

test("clipboard image is offered and attached without creating a file", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("mock-report-clipboard-image", "1"));
  const dialog = await openReportDialog(page, "feature");

  const clipboardButton = dialog.getByRole("button", { name: "Attach from clipboard" });
  await expect(clipboardButton).toBeEnabled();
  await clipboardButton.click();

  await expect(dialog.getByText("Clipboard screenshot.png")).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Clipboard screenshot.png" })).toBeVisible();
  await dialog.getByRole("button", { name: "Remove Clipboard screenshot.png" }).click();
  await expect(dialog.getByRole("button", { name: "Attach from clipboard" })).toBeVisible();
  await dialog.getByRole("button", { name: "Attach from clipboard" }).click();
  await expect(dialog.getByText("Clipboard screenshot.png")).toBeVisible();
  await page.screenshot({ path: evidencePath("ac-2-clipboard-image.png") });
});

test("clipboard action stays visible but disabled when the clipboard has no image", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  const dialog = await openReportDialog(page);

  const clipboardButton = dialog.getByRole("button", { name: "Attach from clipboard" });
  await expect(clipboardButton).toBeVisible();
  await expect(clipboardButton).toBeDisabled();
  await expect(clipboardButton).toHaveAttribute("title", "No image in clipboard");
  await page.screenshot({
    path: evidencePath("issue-587-disabled-clipboard-action.png"),
    animations: "disabled",
  });
});

test("invalid image keeps the report draft and existing attachments", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  const dialog = await openReportDialog(page);
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

test("empty, excessive, per-image, and total image limits are visible without draft loss", async ({
  page,
}) => {
  await page.goto("/");
  await waitForEntries(page);
  const dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("Keep every limit draft");
  await dialog.getByLabel("Description").fill("Limits must not discard this.");
  const input = dialog.getByLabel("Add images");

  await input.setInputFiles({ name: "empty.png", mimeType: "image/png", buffer: Buffer.alloc(0) });
  await expect(dialog.getByRole("alert")).toContainText("empty");

  await input.setInputFiles(Array.from({ length: 4 }, (_, index) => ({
    name: `${index}.png`,
    mimeType: "image/png",
    buffer: png,
  })));
  await expect(dialog.getByRole("alert")).toContainText("up to 3");

  await input.setInputFiles({
    name: "too-large.png",
    mimeType: "image/png",
    buffer: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]),
  });
  await expect(dialog.getByRole("alert")).toContainText("2 MiB");

  const underTwoMiB = Buffer.concat([png, Buffer.alloc(1600 * 1024)]);
  await input.setInputFiles({
    name: "valid-large.png", mimeType: "image/png", buffer: underTwoMiB,
  });
  await expect(dialog.getByText("valid-large.png")).toBeVisible();
  await input.setInputFiles({
    name: "total-overflow.png", mimeType: "image/png", buffer: underTwoMiB,
  });
  await expect(dialog.getByRole("alert")).toContainText("3 MiB");

  await expect(dialog.getByLabel("Title")).toHaveValue("Keep every limit draft");
  await expect(dialog.getByLabel("Description")).toHaveValue("Limits must not discard this.");
  await expect(dialog.getByText("valid-large.png")).toBeVisible();
  await expect(dialog.getByText("total-overflow.png")).toBeHidden();
});

test("overlapping picker reads cannot bypass attachment limits", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  const dialog = await openReportDialog(page);

  await dialog.getByLabel("Add images").evaluate((element) => {
    const input = element as HTMLInputElement;
    const select = (prefix: string) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["first"], `${prefix}-first.png`, { type: "image/png" }));
      transfer.items.add(new File(["second"], `${prefix}-second.png`, { type: "image/png" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    select("one");
    select("two");
  });

  await expect(dialog.getByRole("button", { name: /^Remove / })).toHaveCount(2);
  await expect(dialog.getByRole("alert")).toContainText("up to 3");
});

test("successful submission forwards selected images to the native report command", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  const dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("Attachment contract");
  await dialog.getByLabel("Description").fill("The screenshot must reach GitHub.");
  await dialog.getByLabel("Add images").setInputFiles({
    name: "contract.png", mimeType: "image/png", buffer: png,
  });
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".toast.success")).toContainText("Issue #5470");
  const submitted = await page.evaluate(() => localStorage.getItem("mock-submitted-report"));
  expect(JSON.parse(submitted!).attachments).toEqual([
    expect.objectContaining({ name: "contract.png", mediaType: "image/png" }),
  ]);
});

test("failed optimistic attachment submission restores the complete draft on reopen", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => {
    localStorage.setItem("mock-report-error", "network_unreachable");
    localStorage.setItem("mock-report-clipboard-image", "1");
  });
  const dialog = await openReportDialog(page, "feature");
  await dialog.getByLabel("Title").fill("Keep attachment title");
  await dialog.getByLabel("Description").fill("Keep attachment description");
  await dialog.getByLabel(/How can we reach you/).fill("@retry-reporter");
  await dialog.getByRole("button", { name: "Attach from clipboard" }).click();
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".toast.error")).toContainText("saved for retry");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
    .toBeNull();

  const restoredDialog = await openReportDialog(page);
  await expect(restoredDialog.getByLabel("Title")).toHaveValue("Keep attachment title");
  await expect(restoredDialog.getByLabel("Description")).toHaveValue(
    "Keep attachment description",
  );
  await expect(restoredDialog.getByLabel(/How can we reach you/)).toHaveValue(
    "@retry-reporter",
  );
  await expect(restoredDialog.getByRole("button", { name: "Feature" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(restoredDialog.getByText("Clipboard screenshot.png")).toBeVisible();
  await expect(
    restoredDialog.getByRole("button", { name: "Attach from clipboard" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: evidencePath("issue-587-optimistic-failure-retry.png"),
    animations: "disabled",
  });
});

for (const [kind, message] of [
  ["daily_cap", "Reports are temporarily unavailable"],
  ["rate_limited", "Too many reports"],
  ["malformed_input", "not valid"],
  ["attachment_uploader_unavailable", "Install GitHub CLI"],
  ["attachment_upload_failed", "Could not upload the image through gh-image"],
] as const) {
  test(`${kind} optimistic attachment failure is explained by a toast`, async ({
    page,
  }) => {
    await page.goto("/");
    await waitForEntries(page);
    await page.evaluate((errorKind) => {
      localStorage.setItem("mock-report-error", errorKind);
    }, kind);
    const dialog = await openReportDialog(page);
    await dialog.getByLabel("Title").fill(`Keep ${kind} title`);
    await dialog.getByLabel("Description").fill(`Keep ${kind} description`);
    await dialog.getByLabel("Add images").setInputFiles({
      name: `${kind}.png`, mimeType: "image/png", buffer: png,
    });

    await dialog.getByRole("button", { name: "Submit" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.locator(".toast.error")).toContainText(message);
  });
}

test("draft is restored when both relay and browser fallback fail", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => {
    localStorage.setItem("mock-report-error", "network_unreachable");
    localStorage.setItem("mock-open-url-error", "1");
  });

  const dialog = await openReportDialog(page);
  await dialog.getByLabel("Title").fill("Do not lose this title");
  await dialog.getByLabel("Description").fill("Do not lose this description");
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".toast.error")).toContainText("draft is saved");

  const restoredDialog = await openReportDialog(page);
  await expect(restoredDialog.getByLabel("Title")).toHaveValue("Do not lose this title");
  await expect(restoredDialog.getByLabel("Description")).toHaveValue(
    "Do not lose this description",
  );
  await expect(restoredDialog.getByRole("button", { name: "Submit" })).toBeEnabled();
});

test("unicode draft is restored when it cannot fit in a fallback URL", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("mock-report-error", "network_unreachable"));

  const dialog = await openReportDialog(page);
  const description = "🐛".repeat(4000);
  await dialog.getByLabel("Title").fill("Keep the complete unicode draft");
  await dialog.getByLabel("Description").fill(description);
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".toast.error")).toContainText("draft is saved");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
    .toBeNull();

  const restoredDialog = await openReportDialog(page);
  await expect(restoredDialog.getByLabel("Description")).toHaveValue(description);
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
