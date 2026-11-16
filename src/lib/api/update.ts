/**
 * Update bridge (#185, #1679). The backend either prepares a signed
 * self-update (download + verify, then `installUpdate` restarts into it) or
 * reports a newer GitHub release to view. This module throttles checks to
 * once per day.
 */

import { invoke } from "./common";

export interface UpdateOffer {
  version: string;
  /** Release page on github.com. */
  url: string;
  /** Downloaded and verified: `installUpdate` applies it and restarts. */
  ready: boolean;
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

/**
 * Returns the newer release, or null when up to date. With `autoInstall`,
 * installs that can replace themselves get it downloaded (`ready: true`).
 */
export function prepareUpdate(autoInstall: boolean): Promise<UpdateOffer | null> {
  return invoke<UpdateOffer | null>("prepare_update", { autoInstall });
}

/** Apply the prepared update and relaunch the app. */
export function installUpdate(): Promise<void> {
  return invoke<void>("install_update");
}
