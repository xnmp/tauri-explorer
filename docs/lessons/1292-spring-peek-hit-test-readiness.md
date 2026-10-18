# Spring peek state is earlier than hit-test readiness

The dev CI failure was the List crossing test in
`e2e/folder-peek-spring-load.spec.ts`, reproduced locally in WebKit twice in
three runs. The triggering merge only added a domain regression test; reverting
it would not repair the browser race.

`explorer.springPeeks` reports controller membership before the rendered List
card's opening motion ends. The synthetic drag helper reads a row's bounding
box and then uses `elementFromPoint`. During motion an edge of that box can
still be clipped: the drag hits outside the peek, closes it and removes the
next row the test tries to query.

The crossing probe now waits for all child rows to be visible and the live
List motion styles/ghost layer to clear before traversing their centers and
edges. It retains the checks for staying open, closing on departure, and not
opening when the drag leaves before the delay. This changes test readiness
only; application animation and drag behavior remain unchanged.
