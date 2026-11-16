/**
 * Update bridge (#185, #1679). The backend either prepares a signed
 * self-update (download + verify, then `installUpdate` restarts into it) or
 * reports a newer GitHub release to view. The once-a-day throttle lives in
 * `update-throttle.ts`.
 */

import { invoke } from "./common";

export interface UpdateOffer {
  version: string;
  /** Release page on github.com. */
  url: string;
  /** Downloaded and verified: `installUpdate` applies it and restarts. */
  ready: boolean;
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
