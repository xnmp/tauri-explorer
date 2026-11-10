# PR CLI fixtures must not execute freshly written files

CI failed in the opt-in Rust suite because the lost-acknowledgement fixture
returned an I/O error before the fake GitHub command recorded acceptance.
The log recorded only the error kind, so it did not retain the OS error.

The fixture wrote a shell script and executed that same inode. On Linux,
`exec` rejects a file with any writable descriptor still open (`ETXTBSY`).
A concurrent fork can briefly retain such a descriptor until its own exec,
even after the writing thread closes it. Rewriting the fixture executable
therefore adds a pre-spawn race unrelated to the mutation contract.

The regression holds the response file open for writing throughout the actual
`execute_pr_action` call. It fails with the former executable fixture and
passes with a checked-in launcher that reads the response as `/bin/sh` input.
Both PR-action test modules use that launcher; mutable response files stay
private to each temporary repository. No subprocess retry is introduced.

Keep the real lost-ack assertions: one acceptance marker, uncertain IPC error,
warning text and badge-cache eviction. The missing-executable and competing
worktree tests still cover pre-spawn refusal and admission through child reap
(ADR 0005 and ADR 0006). This is test infrastructure only, with no UI change.
