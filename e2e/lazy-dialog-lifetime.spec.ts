import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

for (const outcome of ["resolve", "reject"] as const) {
  test(`host teardown suppresses a pending dialog ${outcome}`, async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    const result = await page.evaluate(async (outcome) => {
      const path = "/src/test-support/lazy-dialog-lifetime.svelte.ts";
      const { retirePendingDialog } = await import(/* @vite-ignore */ path);
      return retirePendingDialog(outcome);
    }, outcome);
    expect(result).toEqual({ beforeOpen: 0, afterOpen: 1, component: null, rollbacks: 0, notifications: [] });
  });
}
