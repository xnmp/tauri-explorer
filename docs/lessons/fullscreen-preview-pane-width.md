# Fullscreen preview must not resize the workspace

The docked size lives on `.preview-dock`, an in-flow slot that `PreviewPane`
renders around `.preview-pane`. Fullscreen lifts only the pane out of flow
(`position: fixed`); the slot keeps the docked width or height. Before this,
the pane itself carried the inline size, so fixing it collapsed the
content-sized `.preview-island` and the workspace panes took its space while
hidden: Tiles and plugin views (Trace) reflowed for a size never shown.

Anything hidden while fullscreen must keep its box. The title bar uses
`visibility: hidden`, not `display: none`, which moved the panes up 38px.

A window resize while fullscreen lays the panes out exactly as if docked.
`e2e/preview-fullscreen-docks.spec.ts` asserts every `.explorer-pane` rect is
unchanged through fullscreen for each dock edge. After a resize, wait for the
rects to hold for a few frames: the inspector restacks a frame or two later,
docked or not.
