# git_log cursor: stale or malformed is an error, not an empty page (#1596)

A cursor (last-seen OID) that was malformed was treated as "no cursor" (page one
returned again, duplicating rows); a well-formed one missing from the walk (after
a rebase, gc or branch delete) ended the walk with an empty page and
`has_more=false`, which looked like the end of history.

`build_log` now fails with `AppError::Service { code: "stale_cursor" }` in both
cases (serialised as `{ kind: "stale_cursor", message }`; constants
`STALE_CURSOR_CODE` / `STALE_CURSOR_KIND` must match). `appendPage` in
`git-graph-query.svelte.ts` recognises it via `isStaleCursorError` and reloads
from the top. Tauri rejections are plain objects, not `Error`, so check `kind`.
The mock backend throws the same shape for an unknown cursor.
