# #701 — Preserve live preview sizing when capping available height

A vertical preview has three distinct sizes: the saved preference, the current
resize draft, and the space the layout can allocate. `useControlledSize` publishes
the draft during pointer movement and commits preferences only on release.

PR #700 correctly protected the file area from oversized restored previews, but
bound the wrapper's height to the saved preference and forced the child to fill
it with `height: 100% !important`. This suppressed the child's live inline height.
Six existing resize tests failed with zero movement; a larger viewport still
failed, ruling out expected clamping. Do not weaken live-movement assertions to
match a static saved-size projection.

Keep the child's inline `resize.value` as its desired height. Limit the vertical
wrapper with `max-height`, then allow the child to shrink with `min-height: 0` and
`flex-shrink: 1`. This preserves a single resize owner, immediate draft feedback,
cancellation, saved preferences, and restoration when more space becomes
available. The fullscreen fixed surface retains its own viewport-size override.

Verify both the existing resize contracts and constrained-height selection/scroll
outcomes. A successful constrained-height test alone cannot establish live drag
behavior, and a successful resize test alone cannot establish a usable file area.
