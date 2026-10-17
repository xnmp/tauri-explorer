# Startup budget rollback (#1223)

The first failing CI run after #1218 reported 280,450 bytes of gzip startup
JavaScript against the unchanged 280,448-byte cap. Its browser and Rust suites
passed; frontend validation failed at `bun run check:bundle`. The preceding
green run measured 280,108 bytes.

The same failing source measured exactly 280,448 locally after a frozen-lockfile
install. A local pass with zero headroom therefore did not disprove CI's failure.
The guard sums gzip sizes across the entire static entry closure, so checking
only the main chunk (91,423 bytes in the failing CI run) misses the regression.

The CI repair reverts #1218 as the sole product PR since the last green run.
The restored production build measures 830,507 bytes raw / 280,112 bytes gzip
locally and passes the original guard without changing budgets or exclusions.
This also rolls back #1218's Trash actions, shortcut changes and Linux drag/drop
fix, including their tests. Those features need a subsequent change with startup
headroom before being reintroduced. Existing `check:bundle` CI evidence is the
producing-layer regression check; its original failure precedes the rollback.
