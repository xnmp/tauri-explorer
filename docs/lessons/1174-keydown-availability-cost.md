# Keydown routing must match keys before evaluating availability (#1174)

Every window keydown asks `keybindingsStore.matchesAnyChordPrefix` whether the
key starts a chord. Since #955 it evaluated each chord command's availability
(`admitsCommandDestination` plus its `when` guard) *before* checking whether the
key matched that chord's prefix. Several `when` guards read the active
Explorer's selection through `getSelectedEntries()`, which filters the whole
listing, so in a 5000-entry folder every ArrowDown and Ctrl+Tab paid dozens of
O(n) scans. The sweep measured ArrowDown navigation at about twice v1.10.0's
main-thread time and Ctrl+Tab about 20–40% slower.

Availability guards are arbitrary command code: treat them as expensive and
evaluate them only for commands whose binding the event already matches.
`findMatchingCommand` and `matchesAnyBinding` already did; keep new routing
helpers in the same order.

## Measuring against an older release

`bun run perf:sweep` (`e2e-sweep/`, `playwright.sweep.config.ts`) imports
nothing app-specific beyond the e2e fixtures, so the directory and config can be
copied into a `git archive` of an older tag (with its own `bun install`) and run
with a different `PORT` to record a baseline on the same machine. Compare
CDP `TaskDuration` (renderer main-thread time), not wall time, and run the base
and head sweeps concurrently: on a shared build host, load swung absolute
timings 3x within minutes, so even alternating sequential runs disagreed.
