# Spring-loaded peeks (#1242, folder peek phase 5)

Holding a drag over a closed folder for 600ms opens a temporary peek (a Details
subtree, a List card, a Tiles panel). A drop inside it targets that folder. It
closes when the drag leaves the folder and its peek, or ends.

- `domain/spring-load.ts`: a pure controller with an injected timer.
- `composables/spring-load-driver.ts`: the lazy driver, which turns the element
  under the drag into an observation and applies the open peeks to panes.
- `composables/spring-load.ts`: the eager facade that every drag backend calls.

## Temporary peeks are not expanded peeks

Temporary peeks are a separate per-pane list in the lazy peek session.
`withTemporaryPeeks` projects them into the same map the tree, resources and
watch cap read. Each one gets ordinal 0, so it can never evict a user peek's
watch. They never reach `expanded`, `expandedPaths`, card rows or panel
heights, and navigation clears them.

A "temporary" flag on expanded entries was rejected. Toggles, Collapse All,
height memory and every reader of the expanded set would each have had to
filter it out.

## "Inside" is identity, not geometry

The observation lists the identities that contain the hit element within its
pane's `.file-list .content`:

- the nearest `[data-path]`;
- a Details `[data-peek-state]` row;
- the Details row wrapper `[data-row-path]`;
- the nearest `[data-panel-owner]`;
- the List slot's `data-motion-key`.

A temporary peek stays open while any of those is its folder or lies below it.
Rect tests were rejected because zoom coordinate spaces differ by engine (#493).

Two holes showed up in the browser spec:

1. **Details row edges.** Rows sit at .5px offsets. Chromium pixel-snaps the
   row cell and its `role="row"` wrapper differently, so a 1px band at each
   row edge hit-tests as the wrapper, which had no identity. Before
   `data-row-path` was added, that band closed the peek.
2. **The Tiles band gap.** The 12px gap between a tile and its panel belongs
   to no element. A transparent `[data-spring-bridge]` rect now sits in the
   outline group's `[data-panel-owner]`. It is rendered only for temporary
   panels, so ordinary hover emphasis and marquee are unchanged.

A List card would normally wrap to the next column when it does not fit, which
moves its header out from under the pointer. A temporary card instead shrinks
to the rows left in its column (`columnFlow` `min` slots), down to header-only
in the last row. It animates, but is never revealed, because a reveal scroll
would move it away from the pointer.

## Close a macrotask late

Browsers run microtasks between event listeners. If the peek closed
synchronously in a capture listener, the close would re-render before the
drop's own target handler read its row. Every apply therefore waits one
`setTimeout(0)`, and three cases extend that rule:

- **A DOM drop deferred behind a pending native start** holds the peeks
  (`springHold`) until its replay has dispatched. Without the hold, its
  `captureDropDestination` would see a removed row and cancel.
- **A DOM `dragend` while a native gesture is live** does not end spring. On
  Linux it can arrive before the native Drop, which resolves its target by
  position. Closing first would drop onto whatever row moved under the point.
  The native Drop or Leave ends it instead.
- **A DOM drop the native receiver owns** leaves the peeks to that native Drop.

Fake timers defer a 0ms timeout that is scheduled inside a timer callback by
1ms. Advance by `delay + 1` in tests, not by `delay` followed by
`advanceTimersByTime(0)`.

## Drop targets inside a temporary peek

No component owns these rows as drop targets:

- file rows;
- Details peek-state rows;
- the Tiles bridge.

`resolveDropTargetFromElement` resolves them to the peek's folder
(`{ type: "folder", spring: true }`) through `explorer.springDropFolder`. That
lets native and pointer drops use the existing folder path and copy intent.

The window capture phase accepts the DOM drags, using `preventDefault`,
`dropEffect` and `stopImmediatePropagation`. It does this on `dragenter` too,
because WebKit delivers a drop only to a target whose dragenter was accepted.
It then routes the drop through `dropIntoDirectory(…, "folder")`.

File rows in an ordinary peek stay non-targets, as Phase 3 decided.

The redirect highlights the folder's card or panel surface, or its row. That
row's own `class:drop-target` directive can remove the class when its state
flips, so the capture listener re-adds it on the next `dragover`, which repeats
while a drag rests.

## A spring can unmount the drag's source row

Virtualized views mount only the visible rows plus a small buffer. A big folder
springing open above the source row pushes that row out of the window and
unmounts it. The macOS/Windows pointer drag ran its cleanup in the row's
`onDestroy`, so the gesture was silently cancelled mid-drag and the release
dropped nothing.

An unmount now releases only a press that has not crossed the drag threshold.
An active drag keeps its window listeners, and keeps the explorer captured at
drag start, until mouseup, Escape or blur. The HTML5 path already handled
this: the row's owner retires its source as `owner-disposed` (Linux keeps an
active native handoff alive), and the drop recovers the session from
unexpired shared drag history (#1095). The browser spec covers both backends
with a 40-file folder that springs open above the source.

## Keep the driver's imports out of the startup graph

The first lazy driver imported window tabs, drag state and the drop-target
resolver. The bundler then split their shared startup chunk so the lazy chunk
could import them: startup went from 67 to 70 chunks and +2.4 KB gzip. The
facade now injects those dependencies, and the lazy chunk imports only the
pure controller. The remaining startup cost is +1.2 KB gzip:

- the facade;
- the backend hooks;
- the redirect;
- the explorer's spring API.

## Testing

- Synthetic browser drags must hit-test (`document.elementFromPoint`) and
  dispatch at the element found, as an engine does. Dispatching straight on a
  selector's element hides gaps such as the row-edge band above.
- `page.clock.install()` after a warm-up spring (which loads the driver and
  peek session in real time), then `pauseAt` and `runFor(599)` / `runFor(2)`,
  gives an exact 600ms boundary.
- The pointer-drag backend runs in a separate context whose init script sets
  `navigator.platform` to `MacIntel`. The shared fixture's `defineProperty` is
  not configurable, so it cannot be overridden on that page.

## Native coverage (deferred)

The native receiver path (Linux GTK, `handleNativeOver` → `elementAtNativePosition`)
is covered only by unit tests and the browser tier, not by a tauri-driver run. A
spring spec needs input that `e2e-tauri/helpers/native-drag.py` lacks: a hold
over the folder and a second waypoint into the peek. In Details the first child
row sits at the folder row + 32px, so `--hold-ms` and `--then X Y` options would
be enough. Such a spec joins `test:e2e:tauri:dnd --full`, and a failing case
there fails the required native DnD qualification, so it should land only after
a local run against a `build:native:qualification` binary.
