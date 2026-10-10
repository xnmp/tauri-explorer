/** Real presentation/controller with a private native transport. No provider calls. */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test("retained native jobs recover without fabricated progress, wait for cancellation, and dismiss only presentation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(HOME_URL); await waitForEntries(page);
  await page.evaluate(async () => {
    const { createNativePluginJobsController } = await import("/src/lib/state/native-plugin-jobs.ts");
    const { jobsStore } = await import("/src/lib/state/jobs.svelte.ts");
    let receive: (value: unknown) => void = () => {}, revision = 1, announcements = 0;
    let jobs = [{ jobKey: "a".repeat(48), owner: { packageId: "xnmp.trace-explorer", digest: "b".repeat(64), incarnation: 1 }, operationId: "retained-operation", jobId: 99001, kind: "openai-image", label: "retained.png", originWindow: "fixture-window", revision, createdAtMs: Date.now() - 3000, updatedAtMs: Date.now(), state: "recovering", phase: "acquiring" }];
    const calls: string[] = []; let failDismiss = true;
    const make = () => createNativePluginJobsController({
      watch: async (callback) => { receive = callback; return () => { receive = () => {}; }; },
      snapshot: async () => structuredClone({ originWindow: "fixture-window", watermark: revision, jobs }),
      apply: records => jobsStore.applyNative(records), toast: () => { announcements++; }, error: message => jobsStore.setMonitoringError(message),
    });
    let observer = make(); await observer.init();
    jobsStore.configureNativeControls({ cancel: async key => { calls.push(`cancel:${key}`); await observer.refresh(); }, resume: async key => { calls.push(`resume:${key}`); },
      dismiss: async key => { calls.push(`dismiss:${key}`); if (failDismiss) throw new Error("Presentation ledger unavailable"); jobs = []; receive({ type: "dismissed", jobKey: key, revision: ++revision }); await observer.refresh(); }, refresh: () => observer.refresh() });
    (window as any).nativePresentation = { calls,
      forged: () => receive({ type: "updated", job: { ...jobs[0], owner: { ...jobs[0].owner, packageId: "xnmp.image-generation" }, revision: 2, state: "completed" } }),
      complete: () => { jobs = [{ ...jobs[0], revision: ++revision, state: "completed", updatedAtMs: Date.now() }]; receive({ type: "updated", job: jobs[0] }); receive({ type: "updated", job: jobs[0] }); },
      stale: () => receive({ type: "updated", job: { ...jobs[0], revision: ++revision, state: "running" } }),
      reload: async () => { observer.dispose(); observer = make(); await observer.init(); },
      allowDismiss: () => { failDismiss = false; }, announcements: () => announcements,
    };
  });
  const progress = page.getByRole("region", { name: "Background progress" });
  await expect(progress.getByText("Recovering original operation", { exact: true })).toBeVisible();
  expect(await progress.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(progress.getByRole("progressbar")).toHaveCount(0);
  await expect(progress.getByRole("button", { name: "Dismiss retained.png" })).toHaveCount(0);
  await progress.getByRole("button", { name: "Cancel retained.png" }).click();
  await expect(progress.getByText("Recovering original operation · cancellation requested", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).nativePresentation.forged());
  await expect(progress.getByText("Recovering original operation · cancellation requested", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).nativePresentation.complete());
  await expect(progress.getByText("Complete", { exact: true })).toBeVisible();
  await expect(progress.locator('[data-job-id="99001"]')).toHaveCount(1);
  await page.evaluate(() => (window as any).nativePresentation.stale());
  await expect(progress.getByText("Complete", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).nativePresentation.reload());
  expect(await page.evaluate(() => (window as any).nativePresentation.announcements())).toBe(1);
  await progress.getByRole("button", { name: "Dismiss retained.png" }).click();
  await expect(progress.getByRole("alert")).toHaveText("Presentation ledger unavailable");
  await expect(progress.getByText("retained.png", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).nativePresentation.allowDismiss());
  await progress.getByRole("button", { name: "Dismiss retained.png" }).click();
  await expect(progress).toBeHidden();
  expect(await page.evaluate(() => (window as any).nativePresentation.calls)).toEqual([`cancel:${"a".repeat(48)}`, `dismiss:${"a".repeat(48)}`, `dismiss:${"a".repeat(48)}`]);
});

for (const width of [320, 1024]) test(`operation-specific discard preserves another receipt and dirty parent at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(HOME_URL); await waitForEntries(page);
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
  const parent = page.getByRole("dialog", { name: "Plugins", exact: true });
  await parent.locator(".plugins-search").fill("dirty parent filter");
  await page.evaluate(async () => {
    const { dialogRegistry } = await import("/src/lib/plugins/dialog-registry.svelte.ts");
    const { default: component } = await import("/src/lib/components/AiOperationsDialog.svelte");
    let snapshot = { version: 1, operations: ["alpha", "beta"].map(operationId => ({ operationId, consumerPackage: "xnmp.trace-explorer", providerPackage: "xnmp.image-generation", createdAtMs: Date.now(), execution: "succeeded", delivery: "sealed", reason: "Original output retained", canResume: true, canDiscard: true, canStop: false })) };
    let fail = true, notify = () => {}; const calls: unknown[] = [];
    dialogRegistry.register({ id: "fixture.operations", component, props: { dependencies: {
      read: async () => structuredClone(snapshot), watch: async receive => { notify = receive; return () => {}; },
      resolve: async (operation: any, action: string) => { calls.push([operation.consumerPackage, operation.operationId, action]); if (fail) { notify(); throw new Error("Receipt commit unavailable"); } snapshot = { ...snapshot, operations: snapshot.operations.filter(item => item.operationId !== operation.operationId) }; return structuredClone(snapshot); },
    } } });
    dialogRegistry.openManaged("fixture.operations");
    (window as any).operationPresentation = { calls, allow: () => { fail = false; } };
  });
  const dialog = page.getByRole("dialog", { name: "Unresolved AI operations", exact: true });
  const alpha = dialog.locator('[data-operation-id="alpha"]');
  await expect(alpha.getByText("Original output retained")).toBeVisible();
  const card = dialog.locator(".operations");
  expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await alpha.getByRole("button", { name: "Discard retained result…" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("alpha"); await expect(confirm).toContainText("xnmp.trace-explorer");
  await expect(confirm.getByRole("button", { name: "Keep operation" })).toBeFocused();
  await confirm.getByRole("button", { name: "Keep operation" }).click();
  expect(await page.evaluate(() => (window as any).operationPresentation.calls)).toEqual([]);
  await alpha.getByRole("button", { name: "Discard retained result…" }).click();
  await confirm.getByRole("button", { name: "Discard retained result", exact: true }).click();
  await expect(confirm.getByRole("alert")).toHaveText("Receipt commit unavailable");
  await page.evaluate(() => (window as any).operationPresentation.allow());
  await confirm.getByRole("button", { name: "Discard retained result", exact: true }).click();
  await expect(confirm).toBeHidden(); await expect(alpha).toHaveCount(0);
  await expect(dialog.locator('[data-operation-id="beta"]')).toBeVisible();
  expect(await page.evaluate(() => (window as any).operationPresentation.calls)).toEqual([["xnmp.trace-explorer", "alpha", "discard"], ["xnmp.trace-explorer", "alpha", "discard"]]);
  await dialog.getByRole("button", { name: "Close unresolved operations" }).click();
  await expect(parent).toBeVisible(); await expect(parent.locator(".plugins-search")).toHaveValue("dirty parent filter");
  await page.keyboard.press("Tab"); expect(await parent.evaluate(el => el.contains(document.activeElement))).toBe(true);
});

test("Plugins opens the real unresolved command surface and distinguishes missing provider configuration", async ({ page }) => {
  await page.goto(HOME_URL); await waitForEntries(page);
  await page.keyboard.press("Control+,"); await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
  const parent = page.getByRole("dialog", { name: "Plugins", exact: true });
  await parent.getByRole("button", { name: "Unresolved AI operations", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Unresolved AI operations", exact: true });
  await expect(dialog.getByText("No unresolved AI operations.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Configure image connections" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Install the Image Generation package in Plugins to configure connections.");
  await dialog.getByRole("button", { name: "Close unresolved operations" }).click(); await expect(parent).toBeVisible();
});
