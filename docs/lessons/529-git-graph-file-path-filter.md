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
