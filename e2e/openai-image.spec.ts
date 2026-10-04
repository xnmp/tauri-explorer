import { test, expect, type Page } from "./fixtures";
import { waitForEntries, MULTI_SELECT_MODIFIER } from "./helpers";

async function openAction(page: Page, name: string, action: string) {
  const entry = page.locator(".entry-item").filter({ hasText: name }).first();
  await entry.click();
  await entry.click({ button: "right" });
  const menu = page.locator(".context-menu");
  const group = menu.locator(":scope > .submenu-wrapper").filter({ hasText: "AI" });
  await group.hover();
  await group.locator(".submenu .menu-item").filter({ hasText: action }).click();
  return page.getByRole("dialog", { name: action.replace(/…$/, "") });
}

test("an image edit submits the chosen recipe and displays the resulting Trace branch", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { createPluginStorage } = await import("/src/lib/plugins/api.ts");
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { pluginJobsController } = await import("/src/lib/state/plugin-jobs.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    await createPluginStorage("openai-image").set({ apiKey: "browser-fixture-key" });
    // Browser acceptance exercises the dialog/API/Trace surface. Native event
    // ownership and the actual HTTP/publication lifecycle have separate tests.
    pluginJobsController.accept = (_registration, start) => start();
    getMockControl().openAIImageStart = (request, apiKey) => {
      if (apiKey !== "browser-fixture-key") throw new Error("Configured key was not supplied");
      getMockControl().traceForImage = () => ({
        currentArtifactId: 1, selectedRevisionStatus: "matched",
        artifacts: [
          { id: 1, path: request.sourcePath!, digest: "a".repeat(64), createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" },
          { id: 3, path: `${request.outputDir}/${request.outputFilename}`, digest: "b".repeat(64), createdAt: "2026-10-03T00:00:02Z", generatingRun: 2, pathState: "present" },
        ],
        runs: [{ id: 2, operation: "openai.image.edit", parameters: { provider: "openai", prompt: request.prompt, model: request.model, size: request.size, quality: request.quality, background: request.background }, createdAt: "2026-10-03T00:00:01Z", status: "succeeded", finishedAt: "2026-10-03T00:00:02Z", error: null, recovered: false, inputIds: [1], details: { request_id: "req_browser", usage: { total_tokens: 123 }, cost: null } }],
      });
      traceInvalidation.bump();
      return 1;
    };
  });
  const dialog = await openAction(page, "screenshot.png", "Edit with OpenAI");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Connection", { exact: true }).selectOption("api_key");
  await dialog.getByLabel("Edit prompt").fill("Preserve the face; add a warm lantern");
  await dialog.getByLabel("Quality").selectOption("low");
  await dialog.getByLabel("Size", { exact: true }).selectOption("1536x1024");
  await dialog.getByLabel("Output filename (.png)").fill("lantern-edit.png");
  if (process.env.TRACE_SCREENSHOTS) await page.screenshot({ path: "docs/screenshots/openai-image-dialog.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Generate edit" }).click();
  await expect(dialog).toBeHidden();
  const provenance = page.getByRole("list", { name: "Image provenance" });
  await expect(provenance).toContainText("lantern-edit.png");
  await provenance.getByRole("button", { name: "OpenAI edit", exact: true }).click();
  const details = page.getByRole("region", { name: "Trace details" });
  await expect(details).toContainText("Preserve the face; add a warm lantern");
  await expect(details).toContainText('"model": "gpt-image-2"');
  await expect(details).toContainText('"quality": "low"');
  await expect(details).toContainText('"size": "1536x1024"');
  await expect(details).toContainText("req_browser");
  await expect(details).not.toContainText("browser-fixture-key");
  if (process.env.TRACE_SCREENSHOTS) await page.screenshot({ path: "docs/screenshots/trace-openai-image.png", animations: "disabled" });
});

test("generation starts in a selected folder with no source image", async ({ page }) => {
  await page.goto("/?path=/home/user");
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { pluginJobsController } = await import("/src/lib/state/plugin-jobs.ts");
    pluginJobsController.accept = (_registration, start) => start();
    getMockControl().openAIImageStart = (request) => {
      if (request.sourcePath !== null || request.outputDir !== "/home/user/Pictures" || request.backend !== "codex") throw new Error("Wrong generation destination or connection");
      return 2;
    };
  });
  const dialog = await openAction(page, "Pictures", "Generate image with OpenAI…");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Image prompt").fill("A lantern in a ruined medieval workshop");
  await expect(dialog.getByLabel("Output filename (.png)")).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Generate image", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/OpenAI image job started:/)).toBeVisible();
});

test("Codex edits use the chosen target and references without forwarding a configured API key", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { createPluginStorage } = await import("/src/lib/plugins/api.ts");
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { pluginJobsController } = await import("/src/lib/state/plugin-jobs.ts");
    await createPluginStorage("openai-image").set({ apiKey: "must-not-be-forwarded" });
    pluginJobsController.accept = (_registration, start) => start();
    getMockControl().openAIImageStart = (request, apiKey) => {
      if (apiKey !== "" || request.backend !== "codex"
        || request.sourcePath !== "/home/user/Pictures/screenshot.png"
        || request.referencePaths?.join() !== "/home/user/Pictures/photo1.jpg") {
        throw new Error("Wrong connection, image roles, or leaked API key");
      }
      getMockControl().traceForImage = () => ({
        currentArtifactId: 1, selectedRevisionStatus: "matched",
        artifacts: [
          { id: 1, path: request.sourcePath!, digest: "a".repeat(64), createdAt: "2026-10-04T00:00:00Z", generatingRun: null, pathState: "present" },
          { id: 2, path: request.referencePaths![0], digest: "b".repeat(64), createdAt: "2026-10-04T00:00:00Z", generatingRun: null, pathState: "present" },
          { id: 4, path: `${request.outputDir}/${request.outputFilename}`, digest: "c".repeat(64), createdAt: "2026-10-04T00:00:02Z", generatingRun: 3, pathState: "present" },
        ],
        runs: [{ id: 3, operation: "openai.image.edit", parameters: { provider: "codex-cli", prompt: request.prompt, model: null, settings_source: "built_in_defaults" }, createdAt: "2026-10-04T00:00:01Z", status: "succeeded", finishedAt: "2026-10-04T00:00:02Z", error: null, recovered: false, inputIds: [1, 2], details: { transport: "codex_exec", thread_id: "01234567-89ab-7cde-8f01-23456789abcd", cost: null } }],
      });
      return 3;
    };
  });
  const target = page.locator(".entry-item").filter({ hasText: "screenshot.png" }).first();
  const reference = page.locator(".entry-item").filter({ hasText: "photo1.jpg" }).first();
  await reference.click();
  await target.click({ modifiers: [MULTI_SELECT_MODIFIER] });
  await target.click({ button: "right" });
  const ai = page.locator(".context-menu > .submenu-wrapper").filter({ hasText: "AI" });
  await ai.hover();
  await ai.locator(".submenu .menu-item").filter({ hasText: "Edit with OpenAI" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit with OpenAI" });
  await expect(dialog.getByLabel("Connection", { exact: true })).toHaveValue("codex");
  await dialog.getByLabel("Edit target").selectOption("/home/user/Pictures/screenshot.png");
  await expect(dialog).toContainText("References, in order: photo1.jpg");
  await dialog.getByLabel("Edit prompt").fill("Use image 2's lighting on image 1; preserve composition");
  await dialog.getByLabel("Output filename (.png)").fill("referenced-edit.png");
  if (process.env.TRACE_SCREENSHOTS) await page.screenshot({ path: "docs/screenshots/codex-image-references.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Generate edit" }).click();
  await expect(dialog).toBeHidden();
  await target.click();
  const provenance = page.getByRole("list", { name: "Image provenance" });
  await expect(provenance).toContainText("referenced-edit.png");
  await expect(provenance).toContainText("photo1.jpg");
  await provenance.getByRole("button", { name: "OpenAI edit", exact: true }).click();
  const details = page.getByRole("region", { name: "Trace details" });
  await expect(details).toContainText("codex-cli");
  await expect(details).toContainText("Use image 2's lighting on image 1");
  await expect(details).not.toContainText("must-not-be-forwarded");
});

test("failed generation remains inspectable through image run history", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    getMockControl().openAIImageHistory = [{
      run: { id: 12, operation: "openai.image.generate", parameters: { model: "gpt-image-2", prompt: "A lantern in a ruined workshop" }, createdAt: "2026-10-03T00:00:00Z", status: "failed", finishedAt: "2026-10-03T00:00:02Z", error: "openai_image_failed", recovered: false, inputIds: [] }, outputPath: null,
    }];
  });
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator(".search-input").fill("OpenAI: Image Run History");
  await palette.locator(".command-item").filter({ hasText: "OpenAI: Image Run History" }).click();
  const history = page.getByRole("dialog", { name: "OpenAI image history" });
  await expect(history).toBeVisible();
  await history.locator("summary").click();
  await expect(history).toContainText("failed");
  await expect(history).toContainText("A lantern in a ruined workshop");
  await expect(history).toContainText("No recorded output");
});
