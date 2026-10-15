import { test, expect, type Page } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

// Browser contract fixture only (#795). The native refusal, the Discard that
// keeps the edit and claim release are proven by the Rust temp-tree tests in
// `src-tauri/test_support/recovery_move_retirement/edited_destination.rs` and
// by `e2e-tauri/specs/move-retirement.spec.ts`; this replaces only the API
// port with the presentation the native service returns for that record.
const SOURCE = "/home/user/Documents/report.txt";
const TARGET = "/run/media/user/Archive/report.txt";
// Verbatim from `MoveExecution::admit_endpoints` for these two paths.
const REFUSAL = `Undo cannot return '${SOURCE}': '${TARGET}' changed after the move, and Undo would hide those changes. Nothing was changed. To keep '${TARGET}' as it is, discard this move's recovery data in File Recovery; that permanently deletes the retained original.`;

async function editedMoveFixture(page: Page) {
  await page.route("**/src/lib/api/file-recovery.ts*", async (route) => {
    await route.fulfill({ contentType: "application/javascript", body: `
      let revision = 1;
      let item = { id: 'move-edited', generation: '1', originalPath: ${JSON.stringify(SOURCE)},
        retainedPath: '/home/user/Documents/.tauri-explorer-recovery-6f2a',
        retainedPaths: ['/home/user/Documents/.tauri-explorer-recovery-6f2a', '/run/media/user/Archive/.tauri-explorer-recovery-c81d'],
        retainedBytes: '742', status: 'pending',
        message: 'Inspect this interrupted operation before choosing a recovery action', actions: [] };
      const listeners = new Set();
      const snapshot = () => ({ revision: String(revision), items: item ? [item] : [], error: null });
      const publish = () => { const value = snapshot(); for (const listener of listeners) listener(value); return value; };
      export const fileRecoveryPort = {
        async subscribe(receive) { listeners.add(receive); receive(snapshot()); return async () => { listeners.delete(receive); }; },
        async list() { return snapshot(); },
        async inspect(id) {
          if (!item || id !== item.id) throw new Error('Recovery operation is no longer available');
          revision++;
          item = { ...item, generation: String(revision), status: 'retained', message: ${JSON.stringify(REFUSAL)}, actions: ['discard'] };
          return publish();
        },
        async resolve(id, generation, choice) {
          if (!item || id !== item.id || generation !== item.generation || choice !== 'discard') throw new Error('Recovery action is stale');
          revision++; item = null;
          document.documentElement.dataset.recoveryResolved = choice;
          return publish();
        },
      };
    ` });
  });
}

test("an edited move destination is offered a Discard that keeps the edit, not a Restore (#795)", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await editedMoveFixture(page);
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.getByTestId("file-recovery-notice").click();
  const dialog = page.getByRole("dialog", { name: "File recovery", exact: true });
  await dialog.getByRole("button", { name: "Inspect", exact: true }).click();

  await expect(dialog.getByText(REFUSAL, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Discard…", exact: true }).click();
  const confirmation = dialog.locator(".discard-confirmation");
  await expect(confirmation).toContainText("Files at their visible locations, including any you changed since, are kept as they are.");
  await page.screenshot({ path: "screenshots/fix/edited-durable-move-record/recovery-offers-exit.png" });

  await confirmation.getByRole("button", { name: "Discard recovery data", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-recovery-resolved", "discard");
  await expect(dialog.getByText("No file recovery actions are pending.")).toBeVisible();
});
