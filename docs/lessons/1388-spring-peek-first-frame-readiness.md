# Rows hit-test before the first frame measures the List

`e2e/folder-peek-spring-load.spec.ts` failed on WebKit CI in the List and
Tiles drop/crossing/nesting tests (#1388): a point below a card row hit a root
row (`row:/folder-peek-spring/drag-me.txt`), a nested folder never sprang
open, a Tiles row or bridge was missing. Reproduced locally by pinning the
WebKit run to one core (`taskset -c 0`, `PW_WORKERS=2`): 37 of 50 failed.

A ResizeObserver delivers only during a rendering update, but rows exist and
hit-test (`toBeVisible`, `elementFromPoint`) as soon as the DOM is built.
Under CPU load the first frame after navigation lagged by over a second. Until
then `use-list-columns` has `height = 0`, so the List lays out at its 4-row
floor (`listRows`): a spring card that does not fit starts the next column and
moves its folder header, with bridges. The first frame's measurement (19 rows)
then re-lays the List out mid-test. A user never sees the floor layout, because
the first painted frame already carries the measurement, so this is test
readiness, not a product race.

Tiles has the same lag: its rAF-driven panel motion sits on its first frame
(a zero-height panel) until frames run, and the List-only motion selector from
#1292 did not cover it.

The spec's `settled` helper waits until no peek is loading, no List or Tiles
motion artifact remains, and the row, card, panel and bridge rects are
unchanged across two rendered frames. The second frame follows the first
frame's ResizeObserver delivery. `open()` and `opened()` call it before any
hit-testing. Under the paused clock, use `springIs` (state only), because
frames do not run there.
