/** Browser/mock acceptance through a contributed demo-plugin target. These
 * tests exercise host routing; they do not run GTK native source delivery. */
import { test, expect, type Page } from "./fixtures";
import { runPaletteCommand, switchViewMode, waitForEntries } from "./helpers";

async function enableDemo(page: Page) {
  await page.keyboard.press("Control+,");
  await expect(page.locator(".settings-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
  const dialog = page.locator(".plugins-dialog");
  await expect(dialog).toBeVisible();
  const row = dialog.locator('.setting-row:has-text("Demo Plugin")').first();
  if (!(await row.locator('input[type="checkbox"]').first().isChecked())) await row.locator("label.toggle").click();
  await page.locator(".plugins-dialog .close-btn").click();
  await expect(dialog).toBeHidden();
}

async function fixture(page: Page) {
  await page.goto("/?path=/home/user/Documents"); await waitForEntries(page); await enableDemo(page);
  await runPaletteCommand(page, "Split Pane Right");
  await expect(page.locator(".explorer-pane")).toHaveCount(2);
  // The new right pane is active. Put the plugin target in a different
  // directory so an accidental transfer becomes visible in both listings.
  await page.keyboard.press("Control+l");
  const input = page.locator(".explorer-pane.active .path-input");
  await input.fill("/home/user/Downloads"); await input.press("Enter");
  await expect(page.locator(".explorer-pane.active .entry-item").first()).toBeVisible();
  await runPaletteCommand(page, "Demo: Toggle Cards View");
  await expect(page.getByTestId("demo-file-drop-target")).toBeVisible();
  return { source: page.locator(".explorer-pane").first(), destination: page.getByTestId("demo-file-view"), target: page.getByTestId("demo-file-drop-target") };
}

const modes = process.env.ALL_VIEW_MODES ? ["details", "list", "tiles"] as const : ["details"] as const;
for (const mode of modes) {
  test(`registered target receives both internal files in selection order without a transfer (${mode})`, async ({ page }) => {
    const { source, destination, target } = await fixture(page);
    await source.locator('.entry-item').first().click(); await switchViewMode(page, mode);
    const files = source.locator('.entry-item:not(.directory)');
    const selected = await files.evaluateAll(elements => elements.slice(0, 2).map(element => element.getAttribute("data-path")!));
    expect(selected).toHaveLength(2);
    const sourceBefore = await source.locator('.entry-item').evaluateAll(elements => elements.map(element => element.getAttribute("data-path")));
    const destinationBefore = await destination.locator('.card[data-path]').evaluateAll(elements => elements.map(element => element.getAttribute("data-path")));
    await source.locator(`.entry-item[data-path=${JSON.stringify(selected[0])}]`).click();
    await source.locator(`.entry-item[data-path=${JSON.stringify(selected[1])}]`).click({ modifiers: ["Control"] });
    const rejected = await target.evaluate(async element => {
      // @ts-expect-error Vite serves test source modules.
      const { createPluginContext } = await import("/src/lib/plugins/api.ts");
      const intruder = createPluginContext("drop-intruder");
      try {
        return [element, document.body].map(node => {
          try { intruder.ctx.workspace.registerFileDropTarget(node as HTMLElement, () => {}, { enabled: () => false }); return "accepted"; }
          catch (error) { return String(error); }
        });
      } finally { intruder.dispose(); }
    });
    expect(rejected).toHaveLength(2);
    expect(rejected.every(message => /owned by drop-intruder/.test(message))).toBe(true);
    await source.locator(`.entry-item[data-path=${JSON.stringify(selected[0])}]`).dragTo(target);
    const result = target.getByTestId("demo-file-drop-result");
    await expect(result).toHaveCount(1); await expect(result).toHaveAttribute("data-source", "pane");
    await expect(result.locator("li")).toHaveText(selected);
    await expect(source.locator('.entry-item')).toHaveCount(sourceBefore.length);
    expect(await source.locator('.entry-item').evaluateAll(elements => elements.map(element => element.getAttribute("data-path")))).toEqual(sourceBefore);
    expect(await destination.locator('.card[data-path]').evaluateAll(elements => elements.map(element => element.getAttribute("data-path")))).toEqual(destinationBefore);
    await expect(page.locator(".toast").filter({ hasText: /^(Moved|Copied) / })).toHaveCount(0);
    await page.screenshot({ path: `screenshots/feat/file-drop-targets/internal-two-file-drop-${mode}.png` });
  });
}

test("external DOM Files without Tauri paths deliver nothing", async ({ page }) => {
  const { source, destination, target } = await fixture(page);
  const before = await destination.locator('.card[data-path]').evaluateAll(elements => elements.map(element => element.getAttribute("data-path")));
  const sourceBefore = await source.locator('.entry-item').count();
  await target.evaluate(element => {
    const data = new DataTransfer(); data.items.add(new File(["image"], "external.png", { type: "image/png" }));
    for (const type of ["dragover", "drop"]) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await expect(target.getByTestId("demo-file-drop-result")).toHaveCount(0);
  expect(await destination.locator('.card[data-path]').evaluateAll(elements => elements.map(element => element.getAttribute("data-path")))).toEqual(before);
  await expect(source.locator('.entry-item')).toHaveCount(sourceBefore);
});

for (const target of ["folder", "breadcrumb", "tab"] as const) {
  test(`rejected native start retains the real ${target} DOM drop outcome`, async ({ page }) => {
    const sourcePath = target === "breadcrumb" ? "/home/user/Pictures/vacation/itinerary.txt" : "/home/user/Documents/notes.md";
    const filename = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
    await page.goto(`/?path=${sourcePath.slice(0, sourcePath.lastIndexOf("/"))}`); await waitForEntries(page);
    const destination = target === "folder" ? "/home/user/Documents/project" : target === "breadcrumb" ? "/home/user/Pictures" : "/home/user/Downloads";
    await page.evaluate(async ({ target, destination }) => {
      // @ts-expect-error Vite serves test source modules.
      const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
      if (target === "tab") {
        const sourceTab = manager.activeTabId; manager.createTab(destination); manager.setActiveTab(sourceTab);
      }
      // Stub only the platform boundary; source and drop handlers stay real.
      // @ts-expect-error Vite serves test source modules.
      const { mockInvoke } = await import("/src/lib/api/mock-invoke.ts");
      let callbackId = 0;
      // Real Tauri hands commands a Channel (an object with `onmessage`); the
      // fixture backend takes a plain receiver function. Adapt every channel
      // argument, and answer the event plugin's bookkeeping, so only the
      // native drag start differs from the browser fixture.
      const adapt = (args?: Record<string, unknown>) => args && Object.fromEntries(Object.entries(args).map(([key, value]) =>
        [key, value && typeof value === "object" && "onmessage" in value
          ? (event: unknown) => (value as { onmessage(event: unknown): void }).onmessage(event) : value]));
      Object.assign(window, { __TAURI_INTERNALS__: {
        transformCallback: () => ++callbackId, unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: (command: string, args?: Record<string, unknown>) => command === "plugin:event|listen" ? Promise.resolve(++callbackId)
          : command.startsWith("plugin:event|") ? Promise.resolve(null) : mockInvoke(command, adapt(args)),
      } });
    }, { target, destination });
    await page.locator(`.entry-item[data-path="${sourcePath}"]`).evaluate(async (element, { target, destination }) => {
      const data = new DataTransfer();
      element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data, ctrlKey: true }));
      // Observe the source's settled transport, rather than hand-feeding a
      // native callback or waiting a guessed number of event-loop turns.
      // @ts-expect-error Vite serves test source modules.
      const { dragState } = await import("/src/lib/state/drag.svelte.ts");
      // Yield whole tasks: the rejection arrives through IPC, which a microtask-only loop would starve.
      while (dragState.current?.transport === "native-pending") await new Promise(resolve => setTimeout(resolve, 0));
      const selector = target === "folder" ? `.entry-item.directory[data-path="${destination}"]`
        : `.crumb[data-path="${destination}"]`;
      const drop = target === "tab" ? [...document.querySelectorAll(".tab")].at(-1) : document.querySelector(selector);
      if (!drop) throw new Error(`Missing drop target: ${selector}`);
      for (const type of ["dragover", "drop"]) drop.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, ctrlKey: true }));
      element.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: data }));
    }, { target, destination });
    const copied = target !== "breadcrumb"; // Dev's breadcrumb handler is move-only.
    await expect(page.locator(".toast").filter({ hasText: copied ? /Copied/ : /Moved/ })).toHaveCount(1);
    await expect(page.locator(`.entry-item[data-path="${sourcePath}"]`)).toHaveCount(copied ? 1 : 0);
    const listingPaths = (path: string) => page.evaluate(async path => {
      // @ts-expect-error Vite serves test source modules.
      const { mockInvoke } = await import("/src/lib/api/mock-invoke.ts");
      // @ts-expect-error Vite serves test source modules.
      const { decodeDirectoryListing } = await import("/src/lib/api/directory-wire.ts");
      // Read the resulting files without navigating through the partial
      // native stub: common.invoke has intentionally latched native routing.
      return decodeDirectoryListing(await mockInvoke("list_directory", { path })).entries
        .map((entry: { path: string }) => entry.path);
    }, path);
    expect(await listingPaths(destination)).toContain(`${destination}/${filename}`);
    const sourcePaths = await listingPaths(sourcePath.slice(0, sourcePath.lastIndexOf("/")));
    if (copied) expect(sourcePaths).toContain(sourcePath);
    else expect(sourcePaths).not.toContain(sourcePath);
  });
}

test("plugin-specific DOM text delivery passes through its registered file target", async ({ page }) => {
  const { target, destination } = await fixture(page);
  const before = await destination.locator('.card[data-path]').evaluateAll(elements => elements.map(element => element.getAttribute("data-path")));
  await target.evaluate(element => {
    element.addEventListener("dragover", event => {
      if ((event as DragEvent).dataTransfer?.types.includes("text/plain")) event.preventDefault();
    });
    element.addEventListener("drop", event => {
      element.setAttribute("data-text-received", (event as DragEvent).dataTransfer!.getData("text/plain"));
    });
    const source = document.createElement("div");
    source.draggable = true; source.dataset.testid = "plugin-text-drag";
    source.textContent = "Plugin DOM payload";
    source.addEventListener("dragstart", event => event.dataTransfer!.setData("text/plain", source.textContent!));
    element.parentElement!.prepend(source);
  });
  await page.getByTestId("plugin-text-drag").dragTo(target);
  await expect(target).toHaveAttribute("data-text-received", "Plugin DOM payload");
  expect(await destination.locator('.card[data-path]').evaluateAll(elements => elements.map(element => element.getAttribute("data-path")))).toEqual(before);
  await expect(page.locator(".toast").filter({ hasText: /Copied|Moved/ })).toHaveCount(0);
});
