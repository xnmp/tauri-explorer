# 791 — Generated-theme text contrast

Theme from Image (`domain/theme-from-palette.ts`) used to derive secondary and
tertiary text by fixed RGB interpolation toward the surface. Tertiary text landed
near 2.5–3:1 on dark palettes and lower on hover and selected rows.

- Solve text against **composited surfaces**, not just `--background-solid`:
  cards (`rgba` over solid), the Miller column, hover fills (also on cards) and
  the accent tint used for selected rows (up to 20%). The worst one decides.
- Translucent fills tinted by the text colour create a cycle (hover fill depends
  on primary text, primary text is solved against hover). Break the cycle by
  tinting strokes/fills with a fixed `ink` colour and solving only the
  `--text-*` tokens.
- Target 4.6:1, not 4.5:1, so 8-bit hex rounding cannot push a token below AA.
- A three-tier hierarchy (primary > secondary ≥ 1.2× tertiary ≥ 4.6) needs about
  6.5:1 of white/black headroom; near-mid-grey dominants could lack it, so the
  surface is pushed further toward the extreme until it fits.
- Fills that fail as text get a `-text` twin (`--accent-text`,
  `--system-*-text`) solved in OKLCH lightness, matching the built-in contract
  in `tests/themes/theme-token-contrast.test.ts`.
- Coverage: `tests/domain/theme-from-palette-contrast.test.ts` composites
  surfaces from the emitted CSS with an independent contrast oracle.
