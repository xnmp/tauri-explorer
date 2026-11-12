# #1651 — Terminal didn't match the theme, and wasn't an island

The terminal painted `--background-solid` (the bare window base) while the
file panes paint `--background-card` over that base, so in every theme it read
as a different, darker/greyer panel. Its ANSI palette was xterm's defaults, so
`ls`/`git` colours ignored the theme (and default white was unreadable on light
themes). In floating-islands mode it was a full-width strip glued under the
islands.

Fix:
- `domain/terminal-theme.ts` composites the card surface over the solid base
  (`compositeOver`) for an opaque, pane-matching background (xterm can't paint
  translucency or gradients), and fills the ANSI palette: `--terminal-<name>` /
  `--terminal-bright-<name>` / `--terminal-background` / `--terminal-foreground`
  overrides first, then red/green/yellow/blue from `--system-critical` /
  `--system-success` / `--system-caution` / `--accent`, and black/white from the
  text ramp on light backgrounds. Anything else stays xterm's default.
- `TerminalPanel.svelte`'s color probe now resolves through a sentinel parent
  colour, so a non-color variable (e.g. a gradient) reads as unset instead of
  silently inheriting the text colour.
- `layouts/floating-islands.css` gives `[data-region="terminal"]` island chrome.
  The panel counter-zooms itself (#419), so its margins and radius multiply by
  `var(--app-zoom)` to line up with the zoomed islands around it.

Guards: `tests/domain/terminal-theme.test.ts`; `e2e/terminal-panel.spec.ts`
(painted background differs from the base, xterm `.xterm-fg-1`/`-4` equal the
theme's critical/accent colours — xterm writes them as `#rrggbbaa`); and
`e2e/island-panel-layout.spec.ts` (rounded, shadowed, inset, gapped).
