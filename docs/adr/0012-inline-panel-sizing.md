# Inline panel sizing and resize ownership

Status: Accepted

Governs: `domain/panel-width.ts`, `state/panel-resize.ts`,
`composables/use-panel-resize.svelte.ts`, `components/PanelResizeHandle.svelte`,
`state/pane-viewport.svelte.ts`, `composables/use-inline-panel-width.svelte.ts`,
`state/resize-activity.svelte.ts`

The base file-pane minimum cannot include a fixed assumption about optional
panels. Their presence depends on actual render conditions: Miller columns can
be empty, SCM is per-pane, and an active Miller panel can move into a separate
island. Duplicating those conditions and persisted width reads in the window
manager would create a second source of truth.

Each mounted inline accessory instead reserves a tokenized width lease from the
window-owned viewport model. Its current border-box CSS width adds to that pane's
base minimum. Zero visible columns remove the contribution; hiding or hoisting a
panel disposes its lease. A disposed token cannot update again or remove its
replacement, even if a pane ID is reused. The reservation function is a stable
mount input; callers changing that ownership must remount the accessory. Global
Sidebar and hoisted islands do not contribute, because their space has already
been subtracted from the measured workspace viewport. Contributions never enter
saved tab layouts or settings.

A gesture also holds a window-wide resize-activity lease. Automatic workspace
reveal pauses while any such lease is active, then reconciles after retirement.
This covers inline accessories and the global Sidebar/hoisted Miller surfaces:
both can change workspace geometry. Without this coordination, the first width
update can cause reveal to scroll the workspace and cancel its own captured drag.
Actual user scroll still cancels the gesture. Activity ownership is separate from
width contribution, because a global panel changes the available viewport without
adding to any leaf minimum.

The panel-width domain normalizes persisted input and converts visual pointer
delta through a captured CSS scale. Options are trusted finite constants with
0 < min <= default <= max. The state owner accepts the latest pointer position
once per animation frame and invalidates queued frames by gesture identity.
Release flushes the final accepted pointer position; cancellation discards pending
movement but retains and persists the last published width. Keyboard arrows move
by 10 CSS pixels, Home/End choose bounds, and a left-side handle reverses arrow
and pointer growth direction.

The DOM adapter captures the pointer and the sized parent rectangle when the
gesture begins. Callers place the handle inside its explicitly sized, nonshrinking
panel or column, or supply the controlled element explicitly. Window blur/resize/scroll and root style
changes retire the gesture; root zoom therefore cannot reuse an old coordinate
scale. Capture failure rolls back ownership. Global listeners and the root style
observer exist only during the gesture. No body cursor or user-selection styles
are overwritten. A shared focusable separator renders the Sidebar/SCM/Miller
controls; Git author/date handles retain their compact column styling and consume
the same input owner. Unhandled modified shortcuts retain window routing.

Keyboard/range behavior follows the [WAI window-splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/),
and pointer lifetime uses [Pointer capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture).
This is targeted keyboard/browser acceptance, not assistive-technology certification.
The graph gutter now uses this owner with a live automatic-width source and an
explicit controlled element. With no finite stored preference, its width follows
lane topology within 28–800px. A gesture captures the current automatic width.
No-op movement and cancellation before a published manual adjustment keep
automatic mode, while an effective pointer or keyboard adjustment establishes a
persisted manual preference. The source can change during a drag without changing
its captured origin. Author/date and ordinary panels keep
their fixed default widths. Other custom resize surfaces remain separate audit work.
