# 1703: pane continuity requires stable DOM ancestry

The recursive split renderer remounted the original ExplorerPane when a leaf
became a split. Keeping its explorer store alive was insufficient: virtualized
scroll position and row DOM still reset. Flat pane hosts keyed by pane ID keep
the same DOM through split/close operations; the split tree remains the layout
model and separator geometry still uses its constraints.

Recursive CSS custom properties were not a safe way to flatten the geometry:
browser substitution expanded shared expressions repeatedly and collapsed the
last panes of a deep chain. Reuse the existing numeric domain geometry instead.
The canvas stays CSS-filled with measurement-free subtree minima; a synchronous
initial measurement and ResizeObserver delivery position its absolute children
before paint, without waiting for the manager's deferred interaction geometry.
Absolutely positioned leaves cannot size the observed canvas, preventing a
measurement feedback loop. Preserve focused-first restoration pruning: a
64-pane workspace initially needs six placeholders, not 63.

Interrupted reveals need spatial clipping as well as interpolated rectangles.
Splitting a still-opening incoming pane on the perpendicular axis otherwise
lets its descendant paint and receive clicks ahead of the ancestor divider.
Carry the source's current inset into both the descendant and its divider.
The regression checks hit testing in the region that is still opening, along
with first/middle/final pane bounds, identity, selection and scroll continuity.
