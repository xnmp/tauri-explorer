# Windows native contract regression

The first failing Tauri binary E2E smoke run after PR #1561 failed in the
Windows Rust contracts, before GUI execution. Its new
`trash_unavailable_failures_are_listed_separately_from_other_failures` test
passed `/drive/a`, `/drive/b`, and `/drive/c` into `BatchPlan::new`.
On Windows these are root-relative paths, not absolute paths, so the fixture
panicked during admission rather than exercising batch settlement.

The preceding dev smoke run passed. PR #1561 was the only intervening merge,
and no later commits changed its files. Revert that PR to restore the known
passing implementation, following the CI repair policy. This also withdraws
its no-usable-trash permanent-delete fallback and newly-created trash-directory
cleanup; those product changes need a corrected, cross-platform reintroduction.

For that reintroduction, derive fixtures from `tempfile::tempdir()` and compare
against their native path strings. Preserve the outcome and serialization
assertions. Run the Windows `files::batch::` contracts, not only Linux tests:
the Linux result cannot expose Windows path-admission failures.

The revert restores the preceding ADR 0017 batch outcome and ADR 0019 exact
trash behavior; it does not weaken absolute-path admission or private-trash
permission checks.
