# #1597: Windows address-bar autocomplete and remote-branch suffix matching

- `parsePathInput` split only on `/`, so a Windows path typed with
  backslashes (`C:\Users\fo`) listed `/` and filtered by the whole input:
  autocomplete never showed suggestions. Backslash is a separator only for
  drive (`C:`) and UNC paths; in a POSIX path it is a legal name character,
  so do not split on it there.
- `baseUpdateMergeOids` resolved a PR base through any remote branch whose
  name *ended with* `/<branch>`, so base `main` could resolve to
  `origin/release/main`. A remote-tracking ref is `<remote>/<branch>` with the
  remote as the first segment; compare the remainder exactly.
