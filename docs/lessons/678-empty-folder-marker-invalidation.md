# Empty-folder marker invalidation

The empty-folder cue comes from a bounded lazy probe, independently of directory
listings. Refreshing the listing alone leaves the cached cue stale. Invalidate
affected source parents and destinations through local/cross-window operation
broadcasts and the existing native directory-event subscription. Native events
also cover external changes and Undo/Redo.

An invalidation must also supersede an in-flight probe. Otherwise a probe that
started before a move can complete afterward and put the old empty result back
in the cache. Compare the exact live work identity before publishing a probe;
replacement and reset retire old work without an unbounded version ledger.

Unknown outcomes and lost IPC replies can follow a real filesystem effect.
Conservatively recheck local affected paths after settlement, while publishing
cross-window mutation claims only for known successful receipts. Backend
`is_empty` metadata has neither visibility context nor an observation revision,
so it cannot replace the hidden-aware probe.

Cache comparison keys and native probe paths are separate: Windows aliases may
share a key, but POSIX names can contain literal backslashes. Keep the original
path for IPC, and preserve POSIX spelling in `nativeDirectoryKey`.

Regression evidence includes adversarial unit contracts for stale probes,
uncertain/lost replies, aliases, cancellation, hidden-only folders, and bounded
concurrency. The native test moves real files in Details/List/Tiles and checks
their bytes plus the rendered cue. It fails on the old binary after the file
lands, then passes on the corrected binary; mocked moves cannot prove this.
