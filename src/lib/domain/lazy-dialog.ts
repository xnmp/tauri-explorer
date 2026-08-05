/**
 * Failure-safe loading for code-split dialog components.
 * Issue: #584
 *
 * Every lazily-imported dialog follows the same contract: some store flag is
 * already `true` (the dialog is "open") before the chunk arrives. If the
 * dynamic import rejects and nothing resets that flag, the dialog never
 * renders while `dialogStore.hasModalOpen` keeps gating every global
 * shortcut — a keyboard soft-lock with no visible cause. This seam makes the
 * rollback mandatory: a failed load always runs `onFailure` (close the
 * dialog / cancel the pending operation) and always notifies the user.
 *
 * Reopening after a failure re-runs the import, but browsers cache a failed
 * module fetch in the page's module map, so the retry typically re-rejects
 * until the app restarts — which is why the failure toast says to restart.
 * The guarantee here is only that every attempt fails safe.
 */

export interface LazyDialogRequest<T> {
  /** User-facing dialog name, used in the failure notification. */
  label: string;
  load: () => Promise<{ default: T }>;
  onLoaded: (component: T) => void;
  /** Roll back the "open" state that was set before the chunk loaded. */
  onFailure?: () => void;
}

/**
 * Run a dialog chunk import, assigning the component on success and rolling
 * back open-state + notifying on failure. Never rejects: a rollback or
 * notification callback that itself throws is contained so one bad handler
 * cannot resurrect the soft-lock this exists to prevent.
 */
export async function loadDialogComponent<T>(request: LazyDialogRequest<T>, notifyError: (message: string) => void): Promise<void> {
  try {
    const loadedModule = await request.load();
    request.onLoaded(loadedModule.default);
  } catch (error) {
    console.error(`Failed to load ${request.label} dialog`, error);
    try {
      request.onFailure?.();
    } catch (rollbackError) {
      console.error(`Rollback for ${request.label} dialog failed`, rollbackError);
    }
    try {
      notifyError(`Could not load ${request.label}. Restart the app and try again.`);
    } catch {
      // Notification is best-effort; the state rollback above is what matters.
    }
  }
}
