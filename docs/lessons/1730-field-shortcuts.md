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
  focused, non-modal field yields. Only chords whose own event carries Ctrl or
  Cmd are candidates. The tracked Linux Super overlay does not count in a
  field: a lost Super keyup (compositor grab) would otherwise turn ordinary
  typing into commands. Outside fields the overlay still applies.
- The field keeps plain, Shift-only and Alt-only keys, Ctrl+Alt without Cmd
  (Windows AltGr types characters), IME composition (`isComposing` or
  keyCode 229), A/C/V/X/Y/Z with Ctrl/Cmd, caret/deletion keys (arrows,
  Home/End, Backspace/Delete/Insert, Enter, Space) under any modifier,
  unmodified or Shift PageUp/PageDown, and anything its own handler already
  `preventDefault`ed. Ctrl/Cmd+PageUp/PageDown yield like Ctrl+Tab (tab
  navigation). Editing letters are read logically on Latin layouts and by
  physical code when the layout types a non-ASCII letter (Ctrl+ф is select-all
  on Russian).
- An unbound Ctrl chord still reaches the field: routing yields to the command
  matcher, which leaves the event untouched when nothing matches. The
  hardcoded Ctrl+J / Ctrl+, / Ctrl+\ surface actions likewise leave the key
  with the field when their command is unavailable.
- A Ctrl/Cmd chord prefix accepted from a field owns the next key (it is
  consumed, not typed). A suffix the field already handled, or an IME
  composition key, retires the chord instead.
- Modal dialogs, pane-scoped dialogs and the terminal (`domain/terminal-keys.ts`
  allowlist) are unchanged.
- Trade-off: on macOS, bound Ctrl keys (Ctrl+T/N/P/W …) now run commands from a
  field instead of the Cocoa emacs-style text bindings, because "Ctrl" bindings
  match either Ctrl or Cmd. Ctrl+A stays with the field as an editing letter.
- Accepted behaviour: a shortcut that moves focus (new tab, Quick Open, …)
  from an inline rename field blurs it, and blur commits the rename, exactly
  as clicking elsewhere does.

- `keybinding-parser.ts`: on macOS only (`MatchOptions.mac`, defaulting to the
  running platform), under Alt a key that is a single non-ASCII character,
  `Dead` or `Unidentified` resolves by physical `code` to its US character
  (shifted when Shift is held, matching what Linux reports). Option replaces
  characters only on macOS; on Linux/Windows a non-ASCII Alt key is the
  layout's own letter (German ö on the Semicolon key, AZERTY é on Digit2,
  Swedish å on BracketLeft, AltGr output) and must keep its logical identity,
  or saved "Alt+Ö" bindings stop matching and start firing Alt+; instead.
  Keys that still type ASCII keep their logical identity everywhere; unknown
  or missing codes fall back to the logical key. The recorder
  (`eventToShortcutString`) shares the same identity function.
- Residual: macOS non-US layouts with Option resolve by US physical position
  (Cmd+Option on the AZERTY "M" key, physical Semicolon, matches Cmd+Alt+;).
  The browser exposes no layout map in WKWebView to do better, and the
  existing Alt-letter rule already resolves letters physically.

## Verification limits

Neither Playwright engine reproduces macOS Option key replacement or
WKWebView's Cocoa text bindings; the macOS cases are covered by unit tables in
`tests/domain/keybinding-parser.test.ts` built from macOS US-layout `key`
values, and the field routing by `tests/state/window-keyboard.test.ts`.
