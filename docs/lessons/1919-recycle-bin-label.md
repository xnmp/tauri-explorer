# #1919 — "Trash" shown on Windows instead of "Recycle Bin"

**Symptom.** Tab titles, the empty-state, restore/drop messages, SCM
"Move to Trash" buttons/toasts and the delete toast said "Trash" on Windows.

**Fix.** `domain/trash-label.ts` (`trashName`, `trashText`) picks the word from
`isWindows`; user-visible strings route through it. Linux/macOS keep "Trash".

**Lesson.** New user-visible trash strings must go through `trashText` (the
sidebar, palette and settings already said "Recycle Bin" unconditionally).
Test: `tests/domain/trash-label.test.ts`.
