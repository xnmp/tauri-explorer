/**
 * Once-a-day update check throttle (#185). Separate from `api/update` so the
 * startup bundle carries only this, not the update IPC (#1679).
 */

const LAST_CHECK_KEY = "updateCheck.lastCheckedAt";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** True when the last check is older than the throttle interval. */
export function shouldCheckForUpdate(now: number = Date.now()): boolean {
  const raw = localStorage.getItem(LAST_CHECK_KEY);
  const last = raw ? parseInt(raw, 10) : NaN;
  return Number.isNaN(last) || now - last >= CHECK_INTERVAL_MS;
}

export function markUpdateChecked(now: number = Date.now()): void {
  localStorage.setItem(LAST_CHECK_KEY, String(now));
}
