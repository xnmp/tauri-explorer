# 1718: reflow a split source on the first frame, glide its entries

#1703/#1709 hold a split source's frame at its old width for the 220 ms
reveal, then settle it once. A Tiles or List view therefore jumped from, say,
13 columns to 6 in one frame when the reveal ended. Now the held frame
publishes its extra width as `--pane-content-hold-x`; FileList's layout probe
subtracts it, so the view reflows to its final width on the first frame and
each entry glides from its painted position (FLIP keyed by path; rows rechunk,
so element identity cannot be the key).

- **Never let CSS apply the inset directly.** The var resolves during layout,
  before the ResizeObserver callback runs, so the "before" measurement already
  saw the old column count squeezed into the narrow width, and the first frame
  showed overlapping tiles. FileList commits the view inset as state in the same
  `flushSync` as the width, after measuring. Only the probe reads the var.
- **The hold is rendered state, never an imperative style write.** The pane
  frame's inline style belongs to Svelte (`style={pane.style}`), which rewrites
  `cssText` whenever the placement string changes, e.g. when a new pane's width
  lease clamps the split ratio without changing the layout tree. A
  `setProperty` hold would vanish mid-reveal. The motion keeps holds in a
  `SvelteMap` that PaneLayoutView renders with a `style:` directive.
- **Release holds in the same flush.** `animation.finished` rejects
  asynchronously on cancel; releasing the hold there can strip the hold a
  re-split just set on the same pane. `settleFrames()` clears every hold
  synchronously, and a late release only clears a hold its own animation still
  owns.
- **A re-layout does not cancel glides; an interruption does.** `prepare`
  settles frames only, so a pane split again mid-glide continues from its
  painted entries (the FLIP measures transforms). Input, blur, scroll, divider
  and canvas resizes call `finish()`, which also cancels `entry-reflow`
  animations; pointer holds pause and resume them with the reveal.
- **No fade-in for newly mounted entries.** A split keeps the pixel scroll
  offset (asserted by the continuity spec), so a scrolled pane mounts a new
  range after reflowing. Fading those from opacity 0 blanked the first frame.
- **Details is excluded.** Its rows don't flow with width; insetting them only
  shortened their hit area during the reveal (held presses beyond the final
  edge missed). Only Tiles/List receive the inset.
- **Tests must freeze both animation kinds** (`id === 'entry-reflow'` as well
  as `paneMotion` targets), or a target chosen from a frozen frame keeps moving.
- Not covered: vertical splits in List with Folder Peek (ListColumnsView flows
  by height and only the held width is published) still reflow at settle.
- **Open Folder Peek panels opt out** (`data-entry-reflow-off`). Panels size
  from VirtualList's own probe, which delivers after FileList's FLIP has
  measured, so their entries would start their glide displaced. With panels
  open, the reflow happens at once on the first frame.
- **Only a held reflow glides,** and only entries visible before or after it.
  Running glides are tracked in a registry, so the motion's per-keydown
  `finish()` costs nothing when idle (no `getAnimations({subtree})` style
  flush). An unheld reflow of at least 1 px (the new pane closing mid-reveal)
  cancels running glides; sub-pixel release rounding leaves them alone.
- **Glide offsets go through `rectDimToCSS`.** Rect deltas are post-zoom
  viewport pixels on every engine; `translate` is in CSS pixels (the doubled
  scale of `fixedFrom*` applies only to `position: fixed` overlays). The
  130% zoom spec passes in Chromium and WebKit.
- **WebKit tests must catch the glide in the same delivery.** Headless
  WebKit's first frames after a split can outlast 220 ms, so waiting two
  animation frames finds the glides already finished. Pause the pane
  animations after `tick()`, then observe the source's `.layout-probe` with a
  new ResizeObserver: observers deliver in creation order, so its first
  callback runs right after FileList's reflow; pause the glides there.
