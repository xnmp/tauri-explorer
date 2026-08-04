# #496: Terminal applications own non-core Explorer shortcuts

The terminal's xterm key handler and the page-level keydown handler must use
the same ownership gate. Returning `true` from the xterm handler lets the
terminal application receive the key; returning early from the page handler
keeps Explorer from running a global command after it bubbles.

Keep the terminal-focus exception as a small, explicit, availability-aware
allowlist. Currently only Quick Open, Command Palette, and previous/next tab
may leave the terminal. Treat every other Explorer binding—including custom
bindings, chords, Alt/meta combos, and function keys—as terminal input.
