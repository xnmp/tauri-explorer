# 795 — An edited durable-move destination must not strand its record

A cross-volume durable move publishes a copy and parks the source. The user can
then edit the destination. Before this fix, Undo's admission only checked a
destination that still matched the published payload; an edited one skipped
admission, so restoration journaled `RestoreIntent`, returned the source, and
then failed to park the edited destination ("differs"). The record was left
unfinished with both endpoints claimed, a Restore that could never succeed,
and no Discard. A deleted destination produced a `Restored` record with no
`publication` and no actions at all.

## Admission must predict every refusal the effect would hit

"Read-only admission before the first durable effect" only works if it checks
everything the effect will check. `restore_admitted` compares the source name,
the parked original, the destination and the displaced original against exact
versions; any mismatch after `Begin(Restore)` is a half-applied Undo. So
`admit_endpoints` walks the same sequence read-only for settled positions and
refuses with "Nothing was changed". An interrupted restoration whose source is
still parked is the deliberate exception: bringing the original home is always
admitted, and a later refusal leaves a state Forget can end.

## Preservation rules can strand records

ADR 0023's "discard only while the public endpoint holds the exact payload"
was written to protect the only copy. For a move destination that the user
edited, it protected nothing: the edit is never touched by Discard, and the
parked source is exactly what the user is choosing to drop. Mark such an
endpoint `user_owned` (any present entry is kept) rather than weakening the
general rule; absence still refuses, because then the parked source is the
only copy left.

## Forget needs observation, not just evidence

The original Forget was decided from durable evidence alone, because a stopped
discard's volume might be the thing that cannot be observed. Forgetting a
record that still has a working exit would lose Undo for nothing, so the new
use requires, under the same ownership, that Restore was refused from verified
roots and that a retained record's discard is preserved by a successful
`Retirement::open`. An unobservable volume or root is never proof.

## Testing

`src-tauri/test_support/recovery_move_retirement/edited_destination.rs` covers
each transition with real files and asserts file contents, phase, offered
actions, record retirement and destination admission. Several older tests used
"write to the destination" as a generic endpoint change to exercise withdrawal
and preservation; they now delete the destination instead, which keeps that
machinery covered under the new rule.
