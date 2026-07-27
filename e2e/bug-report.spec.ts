/** In-app bug and feature reports (#547). */

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function runPaletteCommand(page: import("@playwright/test").Page, query: string) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill(query);
  await page.keyboard.press("Enter");
}

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
    ["Report a Bug", /report a bug/i, "evidence/ac-1-report-dialog-buttons.png"],
    ["Request a Feature", /request a feature/i, "evidence/ac-1-feature-dialog-buttons.png"],
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

    await page.screenshot({ path: screenshot });
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
