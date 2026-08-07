/**
 * Deciding whether a config-file change notification should be adopted into
 * in-memory state (#599).
 *
 * A filesystem watcher reports *that* a file changed, never *who* changed it —
 * the app's own atomic save looks exactly like an editor's. Adopting our own
 * write back is not merely wasteful: it can revert the user's most recent
 * change, because the notification for write N can arrive after the in-memory
 * state has already moved on to N+1.
 *
 * This module is the whole decision, kept pure so every rejection reason is
 * directly testable. Callers supply the four facts it needs; nothing here
 * reads a store, a file, or the clock.
 */

/** Why a change notification was or wasn't adopted. */
export type ConfigReloadReason =
  /** A write from this process is queued or in flight — disk is about to be
   *  overwritten by us, so nothing on it can be authoritative right now. */
  | "self-write-pending"
  /** Byte-identical to what we last wrote: our own save coming back. */
  | "own-write-echo"
  /** Not parseable as config (mid-write truncation, hand-edit typo, deleted
   *  file). Keeping the current state beats wiping it. */
  | "unusable"
  /** Semantically identical to what is already in memory. */
  | "unchanged"
  /** A genuine external change. */
  | "external-change";

export interface ConfigReloadDecision {
  apply: boolean;
  reason: ConfigReloadReason;
}

export interface ConfigReloadInput {
  /** Raw file text just read from disk ("" when the file is absent). */
  raw: string;
  /** `raw` reduced to a canonical form by the caller (parsed, defaulted,
   *  migrated, re-serialized), or null when `raw` is not usable. */
  normalized: string | null;
  /** Current in-memory value in that same canonical form. */
  currentNormalized: string;
  /** Content this process most recently sent to disk, if any. */
  lastWritten: string | null;
  /** Whether a write from this process is queued or in flight. */
  writePending: boolean;
}

/**
 * Decide whether an observed config-file change should replace in-memory state.
 *
 * Order matters: the two "this is ours" checks come first, so a self-write is
 * rejected as such even when it also happens to be unparseable or identical.
 * That keeps the reason honest for diagnostics, and means a half-written file
 * observed mid-save is never mistaken for a corrupt external edit.
 */
export function decideConfigReload(input: ConfigReloadInput): ConfigReloadDecision {
  if (input.writePending) return { apply: false, reason: "self-write-pending" };
  if (input.lastWritten !== null && input.raw === input.lastWritten) {
    return { apply: false, reason: "own-write-echo" };
  }
  if (input.normalized === null) return { apply: false, reason: "unusable" };
  if (input.normalized === input.currentNormalized) {
    return { apply: false, reason: "unchanged" };
  }
  return { apply: true, reason: "external-change" };
}
