# Git graph file-path filtering (#529)

- Filter at the history producer, not over the browser's loaded page. A
  client-side filter silently misses matching commits beyond the current page
  and makes `has_more` describe a different result set from the rows on screen.
- Numeric pagination counts matching commits only. The backend therefore checks
  a commit's first-parent tree diff before applying `skip` and `limit`, and
  `has_more` is set only after finding one extra matching commit.
- Treat the entered repository-relative path literally. Disabling git2
  pathspec matching prevents characters such as `*` or `[` in a real filename
  from becoming an unintended wildcard expression.
- Synthetic stash rows need their own path check. Filtering the walked base
  commit is insufficient because `weave_stashes` can otherwise reinsert a
  stash whose first-parent diff changed only an unrelated file.
- A debounced query can change while `loadMore` is in flight. Capture every
  query axis plus the reload generation and discard the page before mutating
  rows or cache if any captured value is stale.
