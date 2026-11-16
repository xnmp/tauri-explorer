# #1730 — Window shortcuts from text fields; Option+punctuation on macOS

## Symptom

1. A new window opens with the address bar focused, and Ctrl+T (or Cmd+T) did
   nothing until the user clicked away: the window keyboard passed every key
   from an `INPUT`/`TEXTAREA`/contenteditable target straight to the field.
2. On macOS, Cmd+Alt+; / Cmd+Alt+' (split down/right) and Alt+; / Alt+' never
   matched. Option replaces punctuation in `event.key` ("…" for `;`, "æ" for
   `'`, NBSP for Space, `Dead` for the backtick) even while Cmd is held.

## Rule

- `isWindowShortcutInField` (`domain/window-keys.ts`) decides which keys a
  focused, non-modal field yields. Only Ctrl/Cmd chords (Linux Super via the
  tracked meta overlay counts as Cmd) are candidates. The field keeps plain,
  Shift-only and Alt-only keys, Ctrl+Alt without Cmd (Windows AltGr types
  characters), A/C/V/X/Y/Z with Ctrl/Cmd, caret/deletion keys (arrows,
  Home/End, PageUp/Down, Backspace/Delete/Insert, Enter, Space) under any
  modifier, and anything its own handler already `preventDefault`ed. Editing
  letters are read logically on Latin layouts and by physical code when the
  layout types a non-ASCII letter (Ctrl+ф is select-all on Russian).
- An unbound Ctrl chord still reaches the field: routing yields to the
  command matcher, which leaves the event untouched when nothing matches.
- A Ctrl/Cmd chord prefix accepted from a field owns the next key (it is
  consumed, not typed). A suffix the field already handled retires the chord.
- Modal dialogs, pane-scoped dialogs and the terminal (`domain/terminal-keys.ts`
  allowlist) are unchanged.
- Trade-off: on macOS, bound Ctrl keys (Ctrl+T/N/P/W …) now run commands from a
  field instead of the Cocoa emacs-style text bindings, because "Ctrl" bindings
  match either Ctrl or Cmd. Ctrl+A stays with the field as an editing letter.

- `keybinding-parser.ts`: under Alt, a key that is a single non-ASCII
  character, `Dead` or `Unidentified` resolves by physical `code` to its US
  character (shifted when Shift is held, matching what Linux reports). Keys
  that still type ASCII under Alt (Linux, Windows, AZERTY) keep their logical
  identity; unknown or missing codes fall back to the logical key. The
  recorder (`eventToShortcutString`) shares the same identity function.

## Verification limits

Neither Playwright engine reproduces macOS Option key replacement or
WKWebView's Cocoa text bindings; the macOS cases are covered by unit tables in
`tests/domain/keybinding-parser.test.ts` built from macOS US-layout `key`
values, and the field routing by `tests/state/window-keyboard.test.ts`.
