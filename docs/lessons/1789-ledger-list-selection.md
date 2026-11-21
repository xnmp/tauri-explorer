# Hairline Ledger: a List selection is ruled, not inverted (#1789)

Hairline Ledger inverted every selected row outside Tiles
(`[data-view]:not([data-view="tiles"])`). That reads as one struck-through band
in Details, where rows are contiguous, but List entries (and a List peek
card's rows) are separate cells with gaps between them: inverted, a selection
became a column of near-black blocks (white in dark themes).

- Only Details inverts (`[data-view="details"]`). Every other view takes the
  rule #1871 gave tiles (accent tint plus a 1px inset accent ring), by
  widening that one rule's selector to `:not([data-view="details"])`, not by a
  second copy.
- When a layout styles selection per view, decide per view whether rows touch:
  a treatment that joins rows (inversion, a full-bleed band) only works where
  they do. `e2e/layout-themes.spec.ts` "rules a List selection, peek card
  included" pins it in the default (Details-only) Playwright run, because the
  per-view matrix only reaches List under `ALL_VIEW_MODES=1`.
