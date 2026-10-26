# Busy rayon pool emptied Quick Open (#1404)

jwalk's default `Parallelism::RayonDefaultPool { busy_timeout: 1s }` runs the
walk on rayon's *global* pool. If no global-pool thread starts the walk within
1 s, jwalk yields a single `Err(ThreadpoolBusy)` item and ends. Directory
listings fan their per-entry stats out on that same global pool
(`files/dir_listing.rs`), so a large listing could starve a concurrent search.
`walk_passes` dropped every `Err` item, so the streaming search reported
`done` with 0 results, and on a watched root it published that empty listing to
the search cache. Later queries then reused it until invalidation or TTL.

Reproduced by blocking every global-pool thread before starting a streaming
search: `done` arrived after about 1 s with `[]`.

Fix:
- Every recursive walk (fast and deferred passes) runs on one shared,
  dedicated pool (`walk_pool()` in `search.rs`, `available_parallelism`
  clamped to 2..=8 threads) through `RayonExistingPool` with a 5 s busy
  timeout. Unrelated rayon work can no longer refuse a search. If the pool
  cannot be built, walks run `Serial`, which cannot be refused.
- `walk_passes` returns `WalkCompleteness`. Any `Err` item, or a directory
  whose children failed to read for a reason other than `PermissionDenied` or
  `NotFound`, marks the walk incomplete. An incomplete walk is never cached,
  whether it was streaming or not (`get_or_load_listing`). The stream still ends
  with `done: true` and whatever it found, the same contract as the deferred
  scan cap, so the UI stops loading. A failed WSL deferred `find` is
  incomplete too.

Rules:
- Keep a busy timeout on the walk pool. jwalk never sees our cancel flag. A
  walk occupies every pool thread until it ends, and a `read_dir` that never
  returns (a dead NFS, SMB, sshfs or FUSE mount) wedges the pool for good.
  With `busy_timeout: None`, the adversarial review reproduced every later
  search spinning forever: it never sent `done` and ignored cancellation.
  With the timeout, such searches end incomplete and uncached after 5 s.
- Do not consume a walk on a `quick-open-walk-*` thread, for example by
  starting a walk from a `process_read_dir` callback.
- `PermissionDenied`/`NotFound` directories count as content, not failures.
  A deletion is a name change that the recursive watcher sees. A `chmod` is a
  metadata event the recursive watch ignores, so its staleness is bounded by
  the 5 s TTL. In practice, notify's recursive registration fails with EACCES
  on a tree that contains a mode-000 directory, so such roots are rarely
  cache-eligible anyway.
- A test that saturates rayon's global pool fails unrelated jwalk users in the
  same test process. `busy_global_rayon_pool_does_not_empty_quick_open`
  re-executes the test binary to run its body in its own process. Deterministic
  error coverage injects a refusing pool through
  `override_walk_parallelism_for_test` instead.
- `dir_listing.rs` still uses the global pool. A busy pool there surfaces as a
  listing error at depth 0 rather than as silently missing entries.
