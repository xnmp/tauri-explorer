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

for (const width of [320, 1024]) test(`automatically settled jobs show their reason once without resolution controls at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(HOME_URL); await waitForEntries(page);
  const reason = "Provider connection closed before its outcome was known";
  await page.evaluate(async (reason) => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { jobsStore } = await import("/src/lib/state/jobs.svelte.ts");
    // The fixture runs the host's inactive-operation policy, then publishes its
    // authoritative native presentation. It never calls an AI provider.
    const { createMockAiPresentation } = await import("/src/lib/api/mock-ai-presentation.ts");
    const mock = getMockControl().nativeAiPresentation ??= createMockAiPresentation((name, value) => window.dispatchEvent(new CustomEvent(name, { detail: value })));
    const stopped = { operationId: "op-stopped", consumerPackage: "xnmp.trace-explorer", providerPackage: "xnmp.image-generation", createdAtMs: Date.now(), execution: "unknown", delivery: "none", reason, canResume: false, canDiscard: false, canStop: false, canDismiss: true, active: false };
    const job = { jobKey: "c".repeat(48), owner: { packageId: "xnmp.trace-explorer", digest: "b".repeat(64), incarnation: 1 }, operationId: stopped.operationId, jobId: 99002, kind: "openai-image", label: "stopped.png", originWindow: "mock-window", revision: 1, createdAtMs: Date.now() - 3000, updatedAtMs: Date.now(), state: "needs_attention", phase: "stopped" };
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job] }, { version: 1, operations: [stopped] });
    jobsStore.applyNative(mock.snapshot().jobs);
    jobsStore.configureNativeControls({ cancel: async key => mock.cancel(key), resume: async key => mock.resume(key), dismiss: async key => { mock.dismiss(key); jobsStore.applyNative(mock.snapshot().jobs); }, refresh: async () => { jobsStore.applyNative(mock.snapshot().jobs); } });
  }, reason);
  const progress = page.getByRole("region", { name: "Background progress" });
  await expect(progress.getByText("Discarded", { exact: true })).toBeVisible();
  await expect(progress.getByText(reason, { exact: true })).toHaveCount(1);
  await expect(progress.getByText(/unresolved|Inspect/i)).toHaveCount(0);
  expect(await progress.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);

  await page.keyboard.press("Control+j");
  const jobs = page.getByRole("dialog", { name: "Background Jobs", exact: true });
  await expect(jobs.getByText(reason, { exact: true })).toHaveCount(1);
  await expect(jobs.getByText(/unresolved|Inspect/i)).toHaveCount(0);
  await jobs.getByRole("button", { name: "Close", exact: true }).click();
  await expect(jobs).toBeHidden();
  await progress.getByRole("button", { name: "Dismiss stopped.png" }).click();
  await expect(progress).toBeHidden();
  await page.keyboard.press("Control+j");
  await expect(jobs.getByText("No background jobs", { exact: true })).toBeVisible();
  expect(await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    return getMockControl().nativeAiPresentation!.calls.filter(call => call.command === "resume");
  })).toEqual([]);
});

test("Plugins has no unresolved operations entry", async ({ page }) => {
  await page.goto(HOME_URL); await waitForEntries(page);
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
  const plugins = page.getByRole("dialog", { name: "Plugins", exact: true });
  await expect(plugins.getByRole("textbox", { name: "Filter plugins" })).toBeVisible();
  await expect(plugins.getByRole("button", { name: /Unresolved AI/i })).toHaveCount(0);
});
