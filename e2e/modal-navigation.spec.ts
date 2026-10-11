import { test, expect, type Page } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

async function openDirtyCaller(page: Page) {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })));
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("Dirty caller draft");
  await name.focus();
  return name;
}

async function openDirtyChild(page: Page) {
  await page.evaluate(async () => {
    const { dialogRegistry } = await import("/src/lib/plugins/dialog-registry.svelte.ts");
    const component = (await import("/src/test-support/modal/DirtyCloseDialog.svelte")).default;
    dialogRegistry.register({ id: "test.dirty-child", component });
    dialogRegistry.openManaged("test.dirty-child");
  });
  await expect(page.getByRole("dialog", { name: "Dirty child", exact: true })).toBeVisible();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
}

async function focusBody(page: Page) {
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
}

test("managed navigation preserves dirty caller and restores focus after Escape and backdrop", async ({ page }) => {
  const name = await openDirtyCaller(page);
  await page.evaluate(async () => {
    const { dialogRegistry } = await import("/src/lib/plugins/dialog-registry.svelte.ts");
    const component = (await import("/src/lib/components/PluginsDialog.svelte")).default;
    dialogRegistry.register({ id: "test.manager", component });
    dialogRegistry.openManaged("test.manager");
  });
  await expect(page.getByRole("dialog", { name: "Plugins", exact: true })).toBeVisible();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(name).toBeVisible();
  await expect(name).toHaveValue("Dirty caller draft");
  await expect(name).toBeFocused();
  await page.evaluate(async () => (await import("/src/lib/plugins/dialog-registry.svelte.ts")).dialogRegistry.openManaged("test.manager"));
  await expect(page.getByRole("dialog", { name: "Plugins", exact: true })).toBeVisible();
  await page.locator(".modal-overlay:not(.suspended)").click({ position: { x: 5, y: 5 } });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Dirty caller draft");
});

test("global Escape retains dirty confirmation and caller until explicit discard", async ({ page }) => {
  const name = await openDirtyCaller(page);
  await openDirtyChild(page);
  const childDraft = page.getByLabel("Child draft", { exact: true });
  await childDraft.fill("Edited child draft");
  await focusBody(page);
  await page.keyboard.press("Escape");
  await expect(page.getByText("Discard unsaved child?", { exact: true })).toBeVisible();
  await expect(childDraft).toHaveValue("Edited child draft");
  await expect(childDraft).toBeFocused();
  await expect(name).toBeHidden();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
  await page.screenshot({ path: "screenshots/feat/shared-ai-services/modal-dirty-confirmation.png", animations: "disabled" });
  await page.getByRole("button", { name: "Keep editing child", exact: true }).click();
  await expect(page.getByText("Discard unsaved child?", { exact: true })).toBeHidden();
  await focusBody(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Discard child", exact: true }).click();
  await expect(name).toBeVisible();
  await expect(name).toHaveValue("Dirty caller draft");
  await expect(name).toBeFocused();
  await page.screenshot({ path: "screenshots/feat/shared-ai-services/modal-caller-draft-restored.png", animations: "disabled" });
});

test("busy child vetoes both global and local Escape and retains focus and caller", async ({ page }) => {
  const name = await openDirtyCaller(page);
  await openDirtyChild(page);
  await page.getByRole("button", { name: "Start pending work", exact: true }).click();
  await focusBody(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Finish pending work", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Discard unsaved child?", { exact: true })).toBeHidden();
  await expect(name).toBeHidden();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Finish pending work", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Discard child", exact: true }).click();
  await expect(name).toHaveValue("Dirty caller draft");
  await expect(name).toBeFocused();
});

test("global closeAll retains a dirty child and its built-in caller", async ({ page }) => {
  const name = await openDirtyCaller(page);
  await openDirtyChild(page);
  await page.evaluate(async () => (await import("/src/lib/state/dialogs.svelte.ts")).dialogStore.closeAll());
  await expect(page.getByText("Discard unsaved child?", { exact: true })).toBeVisible();
  await expect(name).toBeHidden();
  await page.getByRole("button", { name: "Discard child", exact: true }).click();
  await expect(name).toHaveValue("Dirty caller draft");
  await expect(name).toBeFocused();
});
