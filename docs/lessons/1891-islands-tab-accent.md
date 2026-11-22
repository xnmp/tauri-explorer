# #1891 — No accent on the selected tab (Floating Islands)

## Symptom

Reported on Windows: the selected tab had no accent bar, while the
breadcrumb still showed the accent colour.

## Cause

Not a Windows or WebView2 bug. The tab bar gives the active tab
`border-top: 2px solid var(--accent)` (`window-tab-bar.css`). Floating
Islands overrode it with `border: none` when #1734 turned the active tab
into a hole in the strip shade and dropped its fill. The accent went with the
fill. Default (#1856) draws the same hole but kept the accent. The report
came from Windows because a Windows install that had a Mica/Acrylic backdrop
before #1306 migrated to Floating Islands (`legacyLayoutThemeId`).

## Fix

Floating Islands restores the top border on the active tab. Its
`[data-region="tab-edge"]` layer drops to `z-index: 0`, as in Default, so
the accent paints over the outline's top row.

## Gotcha

When a layout's active-tab rule resets `border`, re-declare the accent.
`e2e/layout-themes.spec.ts` ("the selected tab carries the accent …")
checks the computed border and a painted pixel for Default and Floating
Islands, in light and dark. Hairline Ledger and Soft Cards style their tabs
their own way on purpose and are not covered by that test.
