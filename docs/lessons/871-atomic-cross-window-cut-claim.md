# #871 — a Cut must be claimed before it is moved

Paste used to move a Cut first and clear the clipboard afterwards, fire-and-forget.
Two windows (or panes) pasting the same Cut could both start moves; a
cross-volume move is copy-then-delete, so the file could land in both
destinations.

- Every window shares the one native `file-clipboard` worker, so the claim
  (`clipboard_claim_cut`) is ordered with every publish. Only the claimant moves.
- The claim is a lease, not a clear: a complete move consumes the Cut with
  `clipboard_compare_and_clear`; an unfinished or failed move returns it with
  `clipboard_release_cut`, preserving "a partial Cut stays pasteable".
- Any revision change (new Copy/Cut, rekey, external replacement) makes an old
  lease stale; it neither blocks nor can release the new revision.
- The lease logic is the pure `CutLease` in `clipboard.rs`, unit-tested without
  a display; the X11 coordinator test covers it end to end under `xvfb-run`
  (unset `WAYLAND_DISPLAY`, or its `!is_wayland()` precondition fails).
