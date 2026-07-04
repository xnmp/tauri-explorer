/**
 * Update check bridge (#185). The backend asks the GitHub releases API for
 * the latest version; this module throttles checks to once per day.
 */

import { invoke } from "./files";

export interface UpdateInfo {
  version: string;
  url: string;
}

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

/** Returns the newer release, or null when up to date. */
export function checkForUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("check_for_update");
}
