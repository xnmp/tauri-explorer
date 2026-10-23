# #1360 — List peek column stage had no way back to the compact card

**Symptom:** after "+N more" grew a large List peek card into its scrollable
column stage, the card could never shrink again: the column stage hides the
resize grip, and "Less" only existed in the full-flow stage (returning to the
column).

**Cause:** the List stage memory only stores expansions (`column`, `full`);
the compact card is the *absence* of a choice, and no API could write that
absence. Each stage gained an exit only to the stage above it.

**Fix:** `explorer.showCompactListCard(path)` (facade → lazy session) deletes
the folder's remembered expansion under the same admission as
`showAllListChildren` / `showColumnListChildren` (now one local
`listStageAllowed` guard in the explorer). The header shows Less in both
expanded stages: full flow → column ("Show fewer X items"), column → compact
card ("Shrink X to a card"). The grip's remembered height (`listCardRows`) is
untouched, so the card returns at its old size. The generic stage setter from
#1346 stays reverted: it pushed the startup bundle over its cap (#1357).

**Gotcha:** when adding a stage to a state ladder, check every stage has an
exit control rendered — hiding the grip in the column stage silently removed
the only way down. Keeping the grip there instead would snap: the column
stage is R-1 rows, above the grip's floor(0.7R) maximum.
