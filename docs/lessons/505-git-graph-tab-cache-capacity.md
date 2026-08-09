# Git graph tab cache capacity

`PaneContainer` remounts a git graph when its tab becomes active. The snapshot
cache must therefore cover the supported graph-tab fan-out: a smaller cache
turns ordinary tab switches into fresh `git_log` requests for evicted graphs.

A valid cached remount must also skip its automatic initial reload. Repository
watcher events already evict stale snapshots, while explicit actions reload the
mounted graph, so an unconditional remount reload only recreates tab-switch
work without improving freshness.
