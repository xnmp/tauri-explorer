/**
 * E2E: Retry on a failed plugin job in Background Operations (capability
 * "jobRetry"). A test plugin accepts a job through the window's plugin-jobs
 * controller, which feeds the real jobs store and panel; only the backend
 * event source is faked, since the browser mock has no Tauri events.
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test("Retry on a failed image job starts a new job and replaces the failed entry", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  const capabilities = await page.evaluate(async () => {
    const { exposePluginSDK } = await import("/src/lib/plugins/runtime-sdk.ts");
    exposePluginSDK();
    return (window as any).__TAURI_EXPLORER_PLUGIN_SDK__.capabilities as string[];
  });
  expect(capabilities).toContain("jobRetry");

  await page.evaluate(async () => {
    const { createPluginJobsController, windowJobSink } = await import("/src/lib/state/plugin-jobs.ts");
    const handlers = new Map<string, (payload: unknown) => void>();
    const jobs = createPluginJobsController({
      ...windowJobSink,
      listen: async (name, handler) => { handlers.set(name, handler as (payload: unknown) => void); return () => handlers.delete(name); },
    });
    const state = { next: 9001, retries: 0, refuseNextRetry: false };
    // What a plugin passes: retry accepts a fresh job for the same request.
    const registration = {
      kind: "retry-contract", label: "lantern.png", detail: "Make it daytime", presentation: "image" as const,
      retry: async () => {
        state.retries += 1;
        if (state.refuseNextRetry) return { ok: false as const, error: "Rate limited, try later" };
        return jobs.accept(registration, async () => ({ ok: true as const, data: ++state.next }));
      },
    };
    await jobs.accept(registration, async () => ({ ok: true, data: state.next }));
    (window as any).retryContract = {
      state,
      fail: (jobId: number, error: string) => handlers.get("retry-contract-error")!({ jobId, error }),
    };
  });

  const progress = page.getByRole("region", { name: "Background progress" });
  await expect(progress.getByRole("progressbar")).toHaveCount(1);
  await expect(progress.getByRole("button", { name: "Retry lantern.png" })).toHaveCount(0);

  await page.evaluate(() => (window as any).retryContract.fail(9001, "Codex replied with a refusal"));
  await expect(progress.getByText("Codex replied with a refusal")).toBeVisible();
  const retry = progress.getByRole("button", { name: "Retry lantern.png" });
  await expect(retry).toBeEnabled();

  // Keyboard-accessible: Enter on the focused action retries.
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(progress.getByText("Codex replied with a refusal")).toHaveCount(0);
  await expect(progress.getByRole("progressbar")).toHaveCount(1);
  await expect(retry).toHaveCount(0);
  const jobs = () => page.evaluate(async () => {
    const { jobsStore } = await import("/src/lib/state/jobs.svelte.ts");
    return jobsStore.jobs.map((job) => `${job.id}:${job.status}`);
  });
  expect(await jobs()).toEqual(["9002:running"]);

  // A retry that cannot start keeps the entry and shows why.
  await page.evaluate(() => {
    const contract = (window as any).retryContract;
    contract.state.refuseNextRetry = true;
    contract.fail(9002, "Codex replied with a refusal");
  });
  await retry.click();
  await expect(progress.getByText("Rate limited, try later")).toBeVisible();
  await expect(retry).toBeEnabled();
  expect(await jobs()).toEqual(["9002:error"]);
  expect(await page.evaluate(() => (window as any).retryContract.state.retries)).toBe(2);
});
