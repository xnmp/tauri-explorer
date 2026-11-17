# #1746 Rename word movement stopped only at a few separators

Inline rename's word movement treated just space, `_`, `-`, `.`, `,` and
brackets as separators, so names with `'`, `&`, `+`, `!`, `#` and similar ran
together as one word. `domain/word-boundary.ts` now treats every character
that is not a letter, digit or combining mark as a separator (Unicode-aware,
so accented and CJK names keep their words).

- Word commands come from `wordEditCommand` (Ctrl on Windows/Linux, Option on
  macOS; Cmd+Arrow keeps its native line-start/end meaning) and are applied by
  the pure `applyWordEdit`, which also covers word deletion
  (Ctrl/Option+Backspace/Delete) so movement and deletion agree.
- The composable writes deletions back through `editedName` and an `input`
  event, so the bound value and the tiles auto-size stay in sync.
