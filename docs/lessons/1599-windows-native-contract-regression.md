# Windows native contract regression

The first failing Tauri binary E2E smoke run after PR #1561 failed in the
Windows Rust contracts. Its new
`trash_unavailable_failures_are_listed_separately_from_other_failures` test
passed `/drive/a`, `/drive/b`, and `/local/c` into `BatchPlan::new`.
On Windows these are root-relative paths, not absolute paths, so the fixture
panicked during admission rather than exercising batch settlement. A second
batch in the same test also used the invalid Windows path `/x`.

Derive all four fixture paths from `tempfile::tempdir()` and compare outcomes
against the resulting native path strings. Preserve the success, failure,
trash-unavailable subset and JSON assertions, including omission of the field
for ordinary failures. Linux alone cannot reproduce the Windows admission
failure; the first failing hosted Windows run provides the pre-fix evidence.

Keep this repair in the test fixture. Reverting the whole feature also changes
Linux delete behavior and requires separate running-app evidence. The final
repair preserves the permanent-delete confirmation fallback and private-trash
cleanup, with no production changes to the ADR 0017 batch outcome or ADR 0019
exact-trash behavior.
