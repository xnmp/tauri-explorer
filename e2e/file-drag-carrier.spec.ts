/** Real file-list publishing and Explorer admission. The HTML-only row removes
 * the other formats after production dragstart to exercise WebKit's stripped
 * target projection on both engines. No test code publishes a session token. */
import { test, expect } from "./fixtures";
import { runPaletteCommand, waitForEntries } from "./helpers";

for (const carrier of ["browser", "html-only"] as const) {
  test(`production file drag delivers the ordered selection through ${carrier} carrier`, async ({ page }) => {
    // Observe before the production window capture listener can consume Drop.
    await page.addInitScript(() => {
      window.addEventListener("drop", event => {
        document.documentElement.dataset.droppedTypes = JSON.stringify([...event.dataTransfer!.types]);
      }, { capture: true });
    });
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await page.keyboard.press("Control+,");
    await expect(page.locator(".settings-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
    const dialog = page.locator(".plugins-dialog");
    await expect(dialog).toBeVisible();
    const row = dialog.locator('.setting-row:has-text("Demo Plugin")').first();
    if (!(await row.locator('input[type="checkbox"]').first().isChecked())) await row.locator("label.toggle").click();
    await dialog.locator(".close-btn").click();
    await expect(dialog).toBeHidden();
    await runPaletteCommand(page, "Split Pane Right");
    await expect(page.locator(".explorer-pane")).toHaveCount(2);
    await runPaletteCommand(page, "Demo: Toggle Cards View");
    const target = page.getByTestId("demo-file-drop-target");
    await expect(target).toBeVisible();
    const source = page.locator(".explorer-pane").first();
    const selected = await source.locator('.entry-item:not(.directory)').evaluateAll(elements =>
      elements.slice(0, 2).map(element => element.getAttribute("data-path")!));
    expect(selected).toHaveLength(2);
    const first = source.locator(`.entry-item[data-path=${JSON.stringify(selected[0])}]`);
    await first.click();
    await source.locator(`.entry-item[data-path=${JSON.stringify(selected[1])}]`).click({ modifiers: ["Control"] });
    if (carrier === "html-only") {
      // Window bubble runs after the component's createHtml5FileDrag handler,
      // including when Svelte delegates that handler through the document.
      // Keep its exact HTML; remove alternate authority so omitting production
      // setData("text/html", ...) or breaking HTML admission fails delivery.
      await first.evaluate(element => {
        window.addEventListener("dragstart", event => {
          if (event.target !== element) throw new Error("Unexpected file drag source");
          const data = event.dataTransfer!;
          for (const type of [...data.types]) if (type !== "text/html") data.clearData(type);
        }, { once: true });
      });
    }
    await first.dragTo(target);
    const result = target.getByTestId("demo-file-drop-result");
    await expect(result).toHaveCount(1);
    await expect(result).toHaveAttribute("data-source", "pane");
    await expect(result.locator("li")).toHaveText(selected);
    const droppedTypes = JSON.parse(await page.locator("html").getAttribute("data-dropped-types") ?? "[]") as string[];
    expect(droppedTypes).toContain("text/html");
    if (carrier === "html-only") expect(droppedTypes).toEqual(["text/html"]);
    for (const path of selected) await expect(source.locator(`.entry-item[data-path=${JSON.stringify(path)}]`)).toBeVisible();
    await expect(page.locator(".toast").filter({ hasText: /^(Moved|Copied) / })).toHaveCount(0);
  });
}
