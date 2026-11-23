/**
 * Manual update-check requests (#1901). The palette's "Check for Updates"
 * bumps `manualRequest`; `UpdateCheck` then loads `UpdateNotice` without
 * waiting for the daily throttle, and the notice re-runs its check and reports
 * the outcome (including "already up to date"), which the silent daily check
 * does not. Kept tiny: it ships in the startup bundle with the commands.
 */

class UpdateRequestState {
  /** Incremented once per manual request; 0 means none since launch. */
  manualRequest = $state(0);

  request(): void {
    this.manualRequest += 1;
  }
}

export const updateRequest = new UpdateRequestState();
