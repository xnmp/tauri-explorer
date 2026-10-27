/**
 * In-app Trash location (#863): the sidebar opens the Trash in the active
 * pane, entries browse like any listing, and Restore returns items to their
 * recorded folders without overwriting.
 *
 * The browser mock mirrors the native refusals; real filesystem outcomes are
 * covered by the Rust tests in `src-tauri/test_support/trash_inventory.rs`.
 */
import { test, expect, type Page } from "./fixtures";
import { captureEvidence } from "./evidence-shots";
import { switchViewMode, waitForEntries } from "./helpers";

type Control = { __mockControl?: { invokeCounts?: Record<string, number>; failures?: Record<string, string>; trashIssues?: { source: string; error: string }[] } };

async function mockInvoke(page: Page, command: string, args: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(async ([name, payload]) => {
    const modulePath = "/src/lib/api/mock-invoke.ts";
    const { mockInvoke: invoke } = await import(modulePath);
    return invoke(name, payload);
  }, [command, args] as const);
}

async function trash(page: Page, ...paths: string[]): Promise<void> {
  await mockInvoke(page, "delete_entries", { paths, permanent: false });
}

async function openTrash(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open Recycle Bin" }).click();
  await expect(page.locator(".tab-cwd", { hasText: /^Trash$/ })).toBeVisible();
}

const nav = (page: Page, label: string) => page.locator(`button[aria-label="${label}"]`).first().click();

const trashRow = (page: Page, name: string) => page.locator(".entry-item").filter({ hasText: name });

test.describe("In-app Trash (#863)", () => {
  test("opens inside the pane with origins, without launching an external file manager", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await trash(page, "/home/user/Documents/notes.md", "/home/user/notes.md");

    await openTrash(page);
    const rows = trashRow(page, "notes.md");
    await expect(rows).toHaveCount(2);
    await expect(page.locator(".details-view .column-header", { hasText: "Original location" })).toBeVisible();
    await expect(page.locator(".details-view .column-header", { hasText: "Date deleted" })).toBeVisible();
    await expect(rows.locator(".type-cell")).toHaveText(["/home/user/Documents", "/home/user"], { useInnerText: true });
    expect(await page.evaluate(() => (window as unknown as Control).__mockControl?.invokeCounts?.open_recycle_bin ?? 0)).toBe(0);
    await page.screenshot({ path: "evidence/863-trash-details.png" });
  });

  test("supports List and Tiles, keyboard selection and back/forward history", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await trash(page, "/home/user/Documents/notes.md", "/home/user/Documents/report.pdf");
    await openTrash(page);
    await expect(trashRow(page, "report.pdf")).toHaveCount(1);

    for (const mode of ["list", "tiles"] as const) {
      await switchViewMode(page, mode);
      await expect(trashRow(page, "notes.md")).toHaveCount(1);
      await page.screenshot({ path: `evidence/863-trash-${mode}.png` });
    }
    await switchViewMode(page, "details");

    await trashRow(page, "notes.md").click();
    await expect(page.locator(".entry-item.selected")).toHaveCount(1);
    const first = await page.locator(".entry-item.selected").getAttribute("data-path");
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => page.locator(".entry-item.selected").getAttribute("data-path")).not.toBe(first);
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(".entry-item.selected")).toHaveAttribute("data-path", first!);

    await nav(page, "Go back");
    await expect(page.locator(".entry-item").filter({ hasText: "budget.xlsx" })).toBeVisible();
    await nav(page, "Go forward");
    await expect(trashRow(page, "report.pdf")).toHaveCount(1);
  });

  test("restores same-named items to their own folders and refreshes the Trash", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await trash(page, "/home/user/Documents/notes.md", "/home/user/notes.md");
    await openTrash(page);
    await expect(trashRow(page, "notes.md")).toHaveCount(2);

    await page.keyboard.press("ControlOrMeta+a");
    await trashRow(page, "notes.md").first().click({ button: "right" });
    await page.locator(".context-menu .menu-item", { hasText: "Restore" }).click();
    await expect(page.getByText("Restored 2 items")).toBeVisible();
    await expect(page.getByText("The Trash is empty")).toBeVisible();

    // Each item is back in its own recorded folder.
    await nav(page, "Go back");
    await expect(page.locator(".entry-item[data-path='/home/user/Documents/notes.md']")).toBeVisible();
    await nav(page, "Go up one level");
    await expect(page.locator(".entry-item[data-path='/home/user/notes.md']")).toBeVisible();
  });

  test("refuses to overwrite an occupied destination and keeps the item in the Trash", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await trash(page, "/home/user/Documents/notes.md");
    await mockInvoke(page, "write_text_file", { path: "/home/user/Documents/notes.md", content: "newer" });
    await openTrash(page);

    await trashRow(page, "notes.md").click({ button: "right" });
    await page.locator(".context-menu .menu-item", { hasText: "Restore" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Could not restore 1 item: notes.md: /home/user/Documents/notes.md already exists. Rename or move it, then restore again.",
    );
    await expect(trashRow(page, "notes.md")).toHaveCount(1);
    await expect(page.getByRole("alert")).toBeVisible();
    if (captureEvidence) await page.waitForTimeout(400); // let the toast's entrance settle for the evidence capture
    await page.screenshot({ path: "evidence/863-trash-restore-collision.png" });
  });

  test("shows empty, unavailable and partially readable Trash states in the pane", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await openTrash(page);
    await expect(page.getByText("The Trash is empty")).toBeVisible();
    await page.screenshot({ path: "evidence/863-trash-empty.png" });
    await nav(page, "Go back");
    await waitForEntries(page);

    await page.evaluate(() => {
      ((window as unknown as Control).__mockControl ??= {}).failures = { list_trash: "Permission denied" };
    });
    // A failed listing leaves the pane on its previous path with an in-pane error.
    await page.getByRole("button", { name: "Open Recycle Bin" }).click();
    await expect(page.getByText("Could not read the Trash: Permission denied")).toBeVisible();
    if (captureEvidence) await page.waitForTimeout(400); // let the error state's entrance settle for the evidence capture
    await page.screenshot({ path: "evidence/863-trash-unavailable.png" });

    await page.evaluate(() => {
      const control = ((window as unknown as Control).__mockControl ??= {});
      control.failures = {};
      control.trashIssues = [{ source: "/media/usb/.Trash-1000", error: "Could not open this trash: Permission denied" }];
    });
    await trash(page, "/home/user/Documents/budget.xlsx");
    // A failed listing is not a history entry, so leave through the sidebar.
    await page.locator(".sidebar .nav-item", { hasText: "Documents" }).first().click();
    await waitForEntries(page);
    await openTrash(page);
    await expect(trashRow(page, "budget.xlsx")).toHaveCount(1);
    await expect(page.getByRole("alert")).toContainText(
      "Some trash items could not be shown. /media/usb/.Trash-1000: Could not open this trash: Permission denied",
    );
  });

  test("opening a trashed folder with Enter explains Restore and stays in the Trash", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await trash(page, "/home/user/Documents/project");
    await openTrash(page);
    await trashRow(page, "project").click();
    await expect(page.locator(".entry-item.selected")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page.getByText("Restore project to open it. Right-click it and choose Restore.")).toBeVisible();
    await expect(page.locator(".status-path")).toHaveAttribute("title", "trash://");
    await expect(trashRow(page, "project")).toHaveCount(1);
  });

  test("keeps the system Trash launcher available from the Trash view", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await openTrash(page);
    await expect(page.getByText("The Trash is empty")).toBeVisible();
    await page.getByText("The Trash is empty").click({ button: "right" });
    await page.locator(".context-menu .menu-item", { hasText: "Open in System File Manager" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Control).__mockControl?.invokeCounts?.open_recycle_bin ?? 0)).toBe(1);
  });
});

for (const mode of ["details", "list", "tiles"] as const) {
  for (const action of ["Delete", "Shift+Delete", "menu"] as const) {
    test(`Trash ${action} confirms permanent deletion in ${mode} (#1216)`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("explorer-settings", JSON.stringify({ confirmDelete: false })));
      await page.goto("/?path=/home/user/Documents");
      await waitForEntries(page);
      await trash(page, "/home/user/Documents/notes.md");
      await openTrash(page);
      await switchViewMode(page, mode);
      const row = trashRow(page, "notes.md");
      await row.click();
      if (action === "menu") {
        await row.click({ button: "right" });
        await page.getByRole("menuitem", { name: "Permanently Delete…" }).click();
      } else await page.keyboard.press(action);
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("permanently deleted");
      await expect(row).toHaveCount(1);
      if (mode === "details" && action === "menu") {
        await page.screenshot({ animations: "disabled", path: "screenshots/fix/misc-changes/trash-permanent-delete.png" });
      }
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(row).toHaveCount(1);
      await row.click();
      await page.keyboard.press(action === "menu" ? "Delete" : action);
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByText("The Trash is empty")).toBeVisible();
      await nav(page, "Go back");
      await expect(page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]')).toHaveCount(0);
    });
  }
}

test("Recycle Bin is discoverable through palette and visited Quick Open history (#1216)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.keyboard.press("Control+p");
  let picker = page.locator(".quick-open-dialog");
  await picker.locator("input").fill("Recycle Bin");
  await expect(picker.locator(".result-item", { hasText: "Recycle Bin" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator("input").fill("Open Recycle Bin");
  await page.keyboard.press("Enter");
  await expect(page.locator(".status-path")).toHaveAttribute("title", "trash://");
  await nav(page, "Go back");
  await page.keyboard.press("Control+p");
  picker = page.locator(".quick-open-dialog");
  await picker.locator("input").fill("Recycle Bin");
  await expect(picker.locator(".result-item", { hasText: "Recycle Bin" })).toHaveCount(1);
  await page.screenshot({ animations: "disabled", path: "screenshots/fix/misc-changes/recycle-bin-quick-open.png" });
  await page.keyboard.press("Enter");
  await expect(page.locator(".status-path")).toHaveAttribute("title", "trash://");
});
