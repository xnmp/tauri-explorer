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

- its row, from `springRowOf` (`domain/spring-rows.ts`): an entry row, a Details
  row wrapper `[data-row-path]`, a Details `[data-peek-state]` row, or a
  `[data-spring-bridge]` named by its folder;
- the nearest `[data-path]`;
- the nearest `[data-panel-owner]`;
- the List slot's `data-motion-key`.

The drop redirect resolves its row through the same `springRowOf`. When the two
had their own selectors, the hover counted a Details row wrapper as the row but
the drop did not, so a drop on a row's pixel-snapped edge went to the pane folder.

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

The general rule: a spring open must never move the hovered element out from
under the pointer. Where it has to (a List card that must wrap), a bridge
keeps the place it left inside the peek.

- **A List card holding a temporary peek** (a folder springing open inside a
  user card) keeps the column it had without the peek (`springCardFits`): its
  `columnFlow` `fit` is the slots it took before the spring, so it wraps
  exactly when it wrapped, and in place it shrinks to the rows left in its
  column. Two wrong fits each oscillated: none (the grown card wrapped, the
  hovered row left the pointer, the peek closed, the card came back and sprang
  again, forever), and `fit` 1 (a card that had already started the next
  column jumped back into the previous column's tail).
- **A temporary List card** keeps its place when its header and two rows fit
  there (`fit` 3). Otherwise it starts the next column as a user card would,
  and is revealed. The choice does not depend on the listing: a header-only
  Loading card that fitted would jump once its rows arrived. Its bridges
  (`springWrapBridges`) cover the folder's vacated rows across both columns
  and the gap channel up to the card, so a reveal scroll (at most up to the
  card column's far edge) leaves the pointer on a bridge or the card. The
  card ends its column (`SlotSpec.alone`), so the bridges cover empty space
  only. While the items it displaced still followed it in its column, a bridge
  lay over them: hovering one never sprang it, and a drop on it went into the
  bridged folder.
- **A stacked temporary Tiles panel** is reached along its ribbon. Its 14px
  hit stroke alone was too narrow to follow, so the ribbon and a 64px-wide
  channel stroke around it are bridges. The outline SVG sits behind tiles and
  panels, so the channel only claims the empty space between them. That makes
  up to 64px of empty band space a drop target for the spring folder, which is
  accepted as designed: the channel is how the panel is reached.

## Close a macrotask late

Browsers run microtasks between event listeners. If the peek closed
synchronously in a capture listener, the close would re-render before the
drop's own target handler read its row. Every apply therefore waits one
`setTimeout(0)`, and three cases extend that rule:

- **A DOM drop deferred behind a pending native start** holds the peeks
  (`springHold`) until the start settles or the drag session ends, whichever
  comes first. Its replay does not depend on the hold: a drop into a temporary
  peek is replayed by its captured folder, checked against the same
  unnavigated pane (`captureDropDestination`), because the row unmounts with
  the peek once the session ends. Replaying through the row element made a
  slow start cancel the drop as "the destination changed".
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

The window capture phase accepts the DOM drags, using `preventDefault` and
`dropEffect`. It does this on `dragenter` too, because WebKit delivers a drop
only to a target whose dragenter was accepted. It then routes the drop through
`dropIntoDirectory(…, "folder")`, and only the drop is taken exclusively.

Hover events must keep bubbling. When the capture listener stopped them, the
card or panel surface under a row never saw the pointer move onto that row, so
its own folder feedback (`useDropTarget`) stayed lit after the drop: two
highlighted folders. The capture listener now marks the event as claimed
(`claimSpringEvent`, a WeakSet) so the FileList background ignores it, and the
surface's bubbling `dragover` retargets. Every drop, dragend and leave also
calls `retireDropFeedback()`, an epoch that ends all folder feedback at once,
including a surface that unmounted before its own leave arrived.

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
drag start, until mouseup, Escape or blur. This is an intentional cross-cutting
fix that holds with Folder Peek off as well: a scroll moves the source row out
of the virtual window just as a spring does.

A source that is genuinely gone (deleted or renamed elsewhere, or its pane
navigated, so it left the listing) cancels the drag instead of attempting a
failing move. The check runs at release and after the unmount. It must wait
for the update (`tick()`): in the row's own teardown the explorer still listed
the deleted entry, so a synchronous check let the drag survive. Miller columns
list ancestors outside the pane's listing and pass their own `isListed`. The HTML5 path already handled
this: the row's owner retires its source as `owner-disposed` (Linux keeps an
active native handoff alive), and the drop recovers the session from
unexpired shared drag history (#1095). The browser spec covers both backends
with a 40-file folder that springs open above the source.

## Bounds and authority

- **Holds end with the gesture.** A hold is released when its start settles,
  and every hold when the drag session ends (`springEnd`: a drop, dragend,
  cancel, Escape, a native Drop or Leave). A start that never settles then
  freezes the peeks only until the gesture ends. A 2s limit was tried first:
  it closed the spring under a legitimately slow start. Holds are tokens, so a
  release left over from an ended session cannot release a later hold.
- **Navigation resets the driver.** A pane that navigates during a drag drops
  its temporary peeks itself. The driver compares each pane's `springRequest`
  (by identity) with what it applied, and resets that pane in the controller,
  so the folder can spring again instead of counting as open but invisible.
- **One hover authority on Linux.** The webview's DOM drag events and the
  native receiver report the same gesture and can disagree by a fraction of a
  pixel at a row's edge. While the receiver reports the drag, its position is
  the only hover input, because the native Drop resolves its target from it.
  That report belongs to its gesture: a lost Leave left it in place, so the
  next drag's DOM events never moved the spring and its dragend never closed
  it. A native Enter or a DOM dragstart (a new drag session) clears it.

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
- Drop tests cross a surface gap and a row edge before dropping, and then
  check that exactly one folder had feedback and none keeps it.
- WebKit fires `dragleave` with a null `relatedTarget` inside the window; the
  spec replays that sequence, so the `enteredThisTask` fallback is exercised.
- "Stays open" is sampled (`holdsOpen`): a re-layout that moves the hovered
  row closes and re-springs the peek, which a single check can miss.
- Wait for a List card's opening motion to settle before hit-testing inside
  it: mid-motion its rows are clipped and the point hits the card surface.

## Native coverage

`e2e-tauri/helpers/native-drag.py` hovers about a second over an adjacent
destination, so with Folder Peek on the `file-drag.spec.ts` listing gestures
spring Inbox open in Details, List and Tiles. `drag()` installs a
MutationObserver that records the destination's peek appearing during the
hover in a DOM attribute (WebKitWebDriver may inject into an isolated world,
so the probe shares only the DOM with the app). The listing and cancel/retry
tests assert it, then require the peek to be gone after the drop or Escape and
the moved entries to be absent until Inbox is opened: a peek left open would
show them and make its navigation check vacuous. The Miller tests check only
the close, because their source sits in another column and the hover time
over the destination is not known to exceed 600ms.

A dedicated spring spec (a drop inside the peek) is still deferred. It needs a
second waypoint into the peek after the hover, which `native-drag.py` lacks. In
Details the first child row sits at the folder row + 32px, so a `--then X Y`
option would be enough. Such a spec joins `test:e2e:tauri:dnd --full`, and a failing case
there fails the required native DnD qualification, so it should land only after
a local run against a `build:native:qualification` binary.

## Known pre-existing issue

After a drop onto a folder, the FileList background's `.content.drop-target`
class can linger until the next drag. It predates spring-loaded peeks (it is
the listing background's own feedback, not a spring surface) and is left for
a separate fix.
