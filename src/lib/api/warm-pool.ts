/**
 * Thin IPC wrappers for the warm-window pool (pre-spawned hidden windows).
 * Issue: refactor/audit-tier4-splits (#212)
 */

import { invoke } from "./common";

/** Reserve a spawn slot. Resolves true when the caller may spawn a window. */
export async function warmPoolBeginSpawn(): Promise<boolean> {
  return invoke<boolean>("warm_pool_begin_spawn");
}

/** Release a spawn reservation taken by warmPoolBeginSpawn. */
export async function warmPoolCancelSpawn(): Promise<void> {
  return invoke<void>("warm_pool_cancel_spawn");
}

/** Claim a ready warm window from the pool. Resolves its label, or null when none. */
export async function warmPoolClaim(): Promise<string | null> {
  return invoke<string | null>("warm_pool_claim");
}

/** Discard a claimed-but-unusable warm window by label. */
export async function warmPoolDiscard(label: string): Promise<void> {
  return invoke<void>("warm_pool_discard", { label });
}

/** Register a freshly-spawned window as a ready pool member. */
export async function warmPoolRegister(label: string): Promise<void> {
  return invoke<void>("warm_pool_register", { label });
}

/** Tear down the warm-window pool (closes the parked hidden window). */
export async function warmPoolShutdown(): Promise<void> {
  return invoke<void>("warm_pool_shutdown");
}
