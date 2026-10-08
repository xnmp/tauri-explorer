# Details column menu under interface zoom

## Placement contract

The Details header column-selection menu takes viewport-space mouse coordinates.
A fixed overlay must convert those through the shared engine-aware
`clientToFixed` helper, just like ContextMenu, before assigning CSS left/top.
Measure the mounted menu in CSS space with offsetWidth/offsetHeight and clamp
against viewport dimensions converted through the same helper. Preserve column
visibility actions and the 100% placement control.

Regression proof belongs at the rendered Details header popup, not solely at
zoom arithmetic helpers. Exercise zoom above/below 100% and viewport edges.
