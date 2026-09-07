# Pane viewport geometry and split ownership

Status: Accepted

Governs: `domain/pane-viewport.ts`, `state/pane-viewport.svelte.ts`,
`state/window-tabs.svelte.ts`, `composables/use-pane-dividers.svelte.ts`,
`components/PaneContainer.svelte`, `components/PaneLayoutView.svelte`

A saved split tree describes user preference. It must not be rewritten simply
because a window shrinks, another surface opens, or application zoom changes.
A separate presentation model determines what fits and how to reach it.

The domain computes subtree minima bottom-up and places panes top-down. Leaf
panes start at 240 × 200 CSS pixels; a row sums child widths plus its divider and
takes their maximum height, while a column does the converse. The workspace canvas
is at least that minimum and otherwise fills the available viewport. Rendered
ratios clamp the saved preference against descendant constraints using the extent
remaining after the divider. This is two linear traversals, with linear canvas
growth along each axis; extreme saved ratios do not cause exponential expansion.
No directory reads, DOM measurements or persistent writes occur in this calculation.

The window manager owns viewport measurements and derived geometry. Rendering,
directional focus and dwindle placement consume the same leaf rectangles, including
divider offsets. Before the first usable measurement, focus/dwindle retain their
existing normalized/window-aspect fallback. A viewport resize updates presentation,
not the captured workspace or saved ratios. The frontend measures native CSS client
sizes, and island mode supplies its shared 8-pixel gap instead of the usual 6.

`PaneContainer` owns the scrollable workspace. Active-pane changes and completed
geometry updates reveal that pane through local scroll coordinates; they do not
call `scrollIntoView` on ancestors or move DOM focus. Oversized panes reveal their
leading edge. Automatic reveal pauses during a divider drag. The recursive
renderer remains declarative, preserves deferred-pane placeholders, and does not
acquire global input listeners for each split node.

One divider gesture owner serves the active container. It captures pointer ID,
native client rectangles and the manager's tab-incarnation-bound commit function
when the drag starts. The post-divider extent and pointer coordinate stay in the
same visual coordinate space under zoom. Movement coalesces to one frame; scroll,
viewport/gap changes, tab replacement, changed parent geometry, lost capture and
teardown cancel pending work. The owner's own ratio update does not invalidate
its fixed parent rectangle. Late canceled frames cannot publish.

Focusable separators expose current/minimum/maximum percentages and the controlled
first subtree. Orientation-appropriate arrows move by five percentage points from
the **rendered** position; Home/End select the available bounds. These controls
follow the range and arrow-key guidance in the [WAI window-splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/).
Panes are not collapsible through this control. A handled local key retires the
window's pending chord; unhandled global commands retain normal routing. File-list
window listeners exclude separator targets, so resize keys cannot move selection.

This policy preserves the entire saved layout rather than silently hiding or
removing panes when it cannot fit. The minimum is a base file-pane constraint;
inline SCM/Miller width contributions and shared resize activity are now defined
by ADR 0012. Custom chrome and further surface combinations need their own
acceptance. It does not establish
assistive-technology certification, native platform zoom equivalence, constant-time
large-layout rendering, OS resource bounds or the macOS startup target.
