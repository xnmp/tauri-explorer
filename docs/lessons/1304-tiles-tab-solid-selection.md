# #1304: keep tile text over solid backgrounds

#1296 faded a selected open folder's tint toward its Tiles panel with a
`linear-gradient`. axe cannot compute text contrast over a background image or
gradient. `e2e/theme-accessibility.spec.ts` treats an unmeasured text node as a
failure, so every theme's Tiles scan failed: that scan opens Documents' panel
and selects Documents.

- Any background behind entry text must be a solid colour, including `color-mix`
  tints. Shape the selection with borders, radii and shadows instead.
- PR CI runs Playwright in the default (Details) view only. Tiles-only styling
  needs `ALL_VIEW_MODES=1` locally before merging, or at least
  `ALL_VIEW_MODES=1 npx playwright test e2e/theme-accessibility.spec.ts -g tiles`.
