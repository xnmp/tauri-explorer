# List peek refactor exceeded the startup budget

The first failing dev CI run reported 281,985 bytes gzip for the full static
startup graph, one byte above the unchanged 281,984-byte cap. The only merge
since the last successful run was PR #1346, the List peek presentation-stage
admission consolidation.

`bun run check:bundle` with frozen dependencies reproduces those exact values.
Reverting PR #1346 restores the previous List stage APIs and startup graph;
the budget guard itself remains unchanged. Its real production build is the
regression oracle, because unit tests of the admission policy cannot detect
compressed output growth.

This is an internal refactor rollback, with no intended visual change. Directory
observation and keyboard focus ownership remain as defined by ADR 0014 and
ADR 0015.
