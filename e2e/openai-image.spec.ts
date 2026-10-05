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
  return page.getByRole("dialog", { name: action === "Edit with OpenAI" ? "Edit image" : action.replace(/…$/, "") });
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

for (const edit of [false, true]) test(`configured Codex executable reaches ${edit ? "the image editor" : "generation"}`, async ({ page }) => {
  await page.goto(edit ? "/?path=/home/user/Pictures" : "/?path=/home/user");
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { createPluginStorage } = await import("/src/lib/plugins/api.ts");
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { pluginJobsController } = await import("/src/lib/state/plugin-jobs.ts");
    await createPluginStorage("openai-image").set({ codexPath: "/opt/custom tools/codex" });
    pluginJobsController.accept = (_registration, start) => start();
    getMockControl().openAIImageStart = (request) => {
      if (request.backend !== "codex" || request.codexPath !== "/opt/custom tools/codex") throw new Error("Configured Codex executable was not supplied");
      return 12;
    };
  });
  const dialog = await openAction(page, edit ? "screenshot.png" : "Pictures", edit ? "Edit with OpenAI" : "Generate image with OpenAI…");
  await dialog.getByLabel(edit ? "Edit prompt" : "Image prompt").fill("A green mug on a white background");
  await dialog.getByLabel("Output filename (.png)").fill("configured-codex.png");
  await dialog.getByRole("button", { name: edit ? "Generate edit" : "Generate image", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("OpenAI image job started: configured-codex.png", { exact: true })).toBeVisible();
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

for (const enteredName of ["my-chosen-name.png", ""]) test(`a slow filename suggestion preserves an explicit ${enteredName ? "name" : "clear"} and the submitted destination`, async ({ page }) => {
  let release!: () => void;
  let started!: () => void;
  const response = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  await page.exposeFunction("awaitFilenameCheck", () => { started(); return response; });
  await page.goto("/?path=/home/user");
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { pluginJobsController } = await import("/src/lib/state/plugin-jobs.ts");
    pluginJobsController.accept = (_registration, start) => start();
    getMockControl().checkPathsExist = async (paths) => {
      await (window as Window & { awaitFilenameCheck: () => Promise<void> }).awaitFilenameCheck();
      return paths.map(() => false);
    };
    getMockControl().openAIImageStart = (request) => {
      if (request.outputFilename !== "my-chosen-name.png") throw new Error("Filename suggestion overwrote the destination");
      return 5;
    };
  });
  const dialog = await openAction(page, "Pictures", "Generate image with OpenAI…");
  await requested;
  await dialog.getByLabel("Image prompt").fill("A green mug");
  await dialog.getByLabel("Output filename (.png)").fill("my-chosen-name.png");
  if (!enteredName) await dialog.getByLabel("Output filename (.png)").fill("");
  release();
  // A second storage query is a response barrier for the held filename query.
  await page.evaluate(async () => {
    const { checkPathsExist } = await import("/src/lib/api/files.ts");
    await checkPathsExist([]);
  });
  await expect(dialog.getByLabel("Output filename (.png)")).toHaveValue(enteredName);
  if (!enteredName) await dialog.getByLabel("Output filename (.png)").fill("my-chosen-name.png");
  await dialog.getByRole("button", { name: "Generate image", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("OpenAI image job started: my-chosen-name.png")).toBeVisible();
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
  const dialog = page.getByRole("dialog", { name: "Edit image", exact: true });
  await expect(dialog.getByLabel("Connection", { exact: true })).toHaveValue("codex");
  await dialog.getByLabel("Edit target", { exact: true }).selectOption("/home/user/Pictures/screenshot.png");
  await expect(dialog.locator(".dialog-subtitle")).toContainText("screenshot.png");
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
