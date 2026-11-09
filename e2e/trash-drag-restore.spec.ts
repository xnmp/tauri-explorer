/**
 * Dragging out of the in-app Trash (#1554): dropping Trash entries on a folder
 * row in another pane, or on a bookmark, restores them into that folder (never
 * a move by path), refreshes both views, and refuses an occupied name while
 * keeping the item in the Trash.
 *
 * The browser drives the HTML5 drop path (Linux). The pointer path
 * (macOS/Windows) has unit coverage in `tests/composables/pointer-drag.test.ts`;
 * real filesystem outcomes are covered by `src-tauri/test_support/trash_inventory.rs`.
 */
import { test, expect, type Page } from "./fixtures";
import { captureEvidence } from "./evidence-shots";
import { runPaletteCommand, waitForEntries } from "./helpers";

type Control = { __mockControl?: { invokeCounts?: Record<string, number> } };

async function mockInvoke(page: Page, command: string, args: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(async ([name, payload]) => {
    const modulePath = "/src/lib/api/mock-invoke.ts";
    const { mockInvoke: invoke } = await import(modulePath);
    return invoke(name, payload);
  }, [command, args] as const);
}

const invokeCount = (page: Page, command: string) =>
  page.evaluate((name) => (window as unknown as Control).__mockControl?.invokeCounts?.[name] ?? 0, command);

/** Two panes on /home/user; `paths` go to the Trash, which the first pane shows. */
async function trashBesideHome(page: Page, paths: string[]) {
  await page.goto("/?path=/home/user");
  await waitForEntries(page);
  await runPaletteCommand(page, "Split Pane Right");
  const panes = page.locator(".pane-tree:not(.retained) .explorer-pane");
  await expect(panes).toHaveCount(2);
  await mockInvoke(page, "delete_entries", { paths, permanent: false });
  await panes.first().locator(".entry-item").first().click();
  await page.getByRole("button", { name: "Open Recycle Bin" }).click();
  return { trashPane: panes.first(), homePane: panes.nth(1) };
}

test.describe("Drag out of the Trash (#1554)", () => {
  test("dropping on a folder in another pane restores into that folder", async ({ page }) => {
    const { trashPane, homePane } = await trashBesideHome(page, ["/home/user/Documents/notes.md", "/home/user/readme.txt"]);
    const notes = trashPane.locator(".entry-item").filter({ hasText: "notes.md" });
    const readme = trashPane.locator(".entry-item").filter({ hasText: "readme.txt" });
    await expect(notes).toHaveCount(1);
    await expect(readme).toHaveCount(1);

    await notes.click();
    await readme.click({ modifiers: ["ControlOrMeta"] });
    const pictures = homePane.locator(".entry-item[data-path='/home/user/Pictures']");
    await notes.dragTo(pictures);

    await expect(page.getByText("Restored 2 items to /home/user/Pictures")).toBeVisible();
    await expect(trashPane.getByText("The Trash is empty")).toBeVisible();
    expect(await invokeCount(page, "restore_trash_items_to")).toBe(1);
    expect(await invokeCount(page, "move_entries")).toBe(0);
    if (captureEvidence) await page.waitForTimeout(400); // let the toast's entrance settle for the evidence capture
    await page.screenshot({ path: "screenshots/feat/make-it-possible-to-drag-and-drop-from-recycle-bin/restored-into-folder.png" });

    await pictures.dblclick();
    await expect(homePane.locator(".entry-item[data-path='/home/user/Pictures/notes.md']")).toBeVisible();
    await expect(homePane.locator(".entry-item[data-path='/home/user/Pictures/readme.txt']")).toBeVisible();
    await page.screenshot({ path: "screenshots/feat/make-it-possible-to-drag-and-drop-from-recycle-bin/restored-folder-contents.png" });
  });

  test("an occupied name is refused and the item stays in the Trash", async ({ page }) => {
    const { trashPane, homePane } = await trashBesideHome(page, ["/home/user/notes.md"]);
    await mockInvoke(page, "write_text_file", { path: "/home/user/Pictures/notes.md", content: "already here" });
    const notes = trashPane.locator(".entry-item").filter({ hasText: "notes.md" });
    await notes.dragTo(homePane.locator(".entry-item[data-path='/home/user/Pictures']"));

    await expect(page.getByRole("alert")).toContainText(
      "Could not restore 1 item: notes.md: /home/user/Pictures/notes.md already exists. Rename or move it, then restore again.",
    );
    await expect(notes).toHaveCount(1);
    if (captureEvidence) await page.waitForTimeout(400);
    await page.screenshot({ path: "screenshots/feat/make-it-possible-to-drag-and-drop-from-recycle-bin/occupied-name-refused.png" });
  });

  test("dropping a trashed folder on a bookmark restores it there instead of pinning it", async ({ page }) => {
    const { trashPane } = await trashBesideHome(page, ["/home/user/Music"]);
    const music = trashPane.locator(".entry-item").filter({ hasText: "Music" });
    const bookmark = page.locator(".bookmark-drop-target[data-path='/home/user/Downloads']").first();
    await expect(bookmark).toBeVisible();
    const pinned = await page.locator(".user-bookmark").count();
    await music.dragTo(bookmark);

    await expect(page.getByText("Restored Music to /home/user/Downloads/Music")).toBeVisible();
    await expect(trashPane.getByText("The Trash is empty")).toBeVisible();
    await expect(page.locator(".user-bookmark")).toHaveCount(pinned);
  });
});
