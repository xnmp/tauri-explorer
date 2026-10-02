# #740: Native history ownership does not exclude filesystem mutations

A history reservation owns Undo/Redo ordering, not the files it will touch.
All three native trash adapters originally bypassed shared filesystem admission:
trash Redo, exact ordinary-copy Undo and exact restoration. Real filesystem
regressions showed each could mutate a target while another managed operation
held its claim.

Use the same read-only prepared-admission fence as forward trash. Restoration
includes exact payload and metadata effects plus every missing target parent.
Keep alias dependencies and physical target authority together, and validate
intra-selection overlap before reserving. The external coordinator cannot detect
a contradictory pair of children inside one reservation.

Missing parents are batch state: descriptor-relative creation must record identity
so later items may reuse only their own batch's parents. Untracked EEXIST and
replaced parents fail closed. Record refresh effects before each mkdir, including
when an earlier ancestor succeeds and a later one fails. Existing parents require
stable identity, not ctime that changes when a sibling is restored.

Display keys can be lossy. Prepare and compare exact native publication paths;
never reconstruct native authority from the history key. The regression restores
a non-UTF-8 publication while leaving an unrelated lossy-name collision untouched.

Admission belongs to the real worker through capture destruction, even after the
waiter disappears. Confirmed receipts and fresh publication identity survive
post-publication metadata/sync/ownership cleanup failures. This is cooperative
admission, not a claim of atomic identity-conditional unlink or crash durability.
