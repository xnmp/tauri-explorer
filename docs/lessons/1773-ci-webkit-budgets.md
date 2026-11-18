# WebKit CI capacity after the Floating Islands re-land

The first dev run after #1772 exhausted two budgets. Three default-layout
new-tab-button slide tests timed out at Playwright's 30-second default while
sampling both opening and closing motion. Shard 4 later exhausted its
40-minute suite budget. The maintainer identified the slide cases as taking
21–26 seconds on an earlier WebKit CI run, leaving little host-load margin.

Keep the application and every assertion from #1772. Use a 90-second budget
for the three two-slide cases (matching the overflow-crossing case), and
60 seconds for the Fused active tab group. Individual tests with their own
explicit budgets retain them. These limits bound sampling cost, not animation
correctness: every intermediate-frame assertion still runs.

Six one-worker WebKit shards restore the workflow's 24-minute planning target;
the 40-minute global suite limit and aggregate required check stay unchanged.
The capacity regression test plans the actual discovered specs with recorded
timings and the actual workflow matrix. It fails at about 28.8 minutes with
five shards and passes below 24 minutes with six. Chromium's impact-map report
count does not include WebKit and must stay unchanged.

The earlier rollback in this PR was superseded after review of the maintainer's
fix-forward decision. The matching budget changes are also proposed in #1776.

Local verification also exposed a stale layout assertion: parsing the sidebar's
`borderRadius` shorthand reads the top-left value, which is intentionally zero
when the active tab squares that corner. Assert `borderBottomLeftRadius` for
the persistent rounded-island contract and keep the dedicated top-corner/seam
assertions. The default layout still has to reset that bottom radius to zero.
