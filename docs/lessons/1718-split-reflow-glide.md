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
- **Release holds synchronously.** `animation.finished` rejects asynchronously
  on cancel; releasing the hold there can strip the hold a re-split just set on
  the same frame. `settleFrames()` clears every hold in the same task, and a
  late release only clears a hold its own animation still owns.
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
- **Tests must freeze both animation kinds.** Entry reflows start in the first
  rendered frame's ResizeObserver delivery, after `tick()`. Wait two frames,
  then pause animations with `id === 'entry-reflow'` as well as `paneMotion`
  targets, or a target chosen from a frozen frame keeps moving.
- Folder Peek Tiles sizes panels from VirtualList's own probe, which observes
  later in the same delivery. With panels open, panel geometry settles at the
  first frame rather than gliding.
