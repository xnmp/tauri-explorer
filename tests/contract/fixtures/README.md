# Contract fixtures

Golden expectations shared by two mirrored test suites that must never drift:

- **Mock side** — `tests/contract/*.contract.test.ts` (vitest) drives
  `src/lib/api/mock-invoke.ts` through each scenario and asserts against these
  fixtures.
- **Real side** — `#[test]`s in `src-tauri/src/git.rs` (`mod contract`),
  `src-tauri/src/files/dir_listing.rs` (`contract_listing_order_matches_fixture`),
  and `src-tauri/src/files/file_ops.rs` (`contract_rename_matches_fixture`,
  `contract_delete_matches_fixture`) drive the real `git2`/filesystem commands
  through the *same* scenario (real temp repos / temp dirs) and assert against
  the *same* fixtures (embedded via `include_str!`).

If the mock ever disagrees with the real backend on a scenario encoded here, one
of the two suites fails. This class of drift has shipped before (the mock
`git_commit` once "committed" an unresolved merge conflict).

The fixtures are intentionally normalized so both languages can reach them from
different concrete inputs:

- `git_status.json` — per bucket, a `{ statusCode: count }` histogram plus
  `op_state`. Paths are deliberately omitted (the real repo and the mock use
  different file names); only the *classification* is contractual.
- `git_commit.json` / `git_discard.json` — the guard-error contract: whether the
  command rejects and a substring the message must contain.
- `fs_ops.json` — `list_directory` ordering (dirs first, then case-insensitive
  by name, dotfiles included) plus rename/delete shape+semantics.
