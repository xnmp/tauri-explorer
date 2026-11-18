# CI recovery: Floating Islands re-land

PR #1772 was the sole merge after the preceding successful dev CI run. Its
first dev run failed WebKit shard 4: all three new-tab-button slide cases in
`tab-overflow.spec.ts` timed out on every attempt inside `steppedFrames`'s
`page.evaluate`. The shard then exhausted its 40-minute suite budget. The
navigation Back smoke case also failed once and passed on retry.

The re-land qualified title-pixel sampling, but the shared frame helper also
serves default-layout tab-overflow tests. Fixing one sampling caller did not
qualify the other callers in WebKit. Restore the entire preceding application
and test tree with a revert of #1772; do not remove assertions, increase the
suite deadline, or retry until green. A future re-land must qualify the shared
helper's complete caller set in both engines under CI-like conditions.
