# Non-UTF-8 file names (#1592)

A file named `bad\xff.txt` was listed as `bad\u{FFFD}.txt`. Every action on the
listed path then missed the file — or hit a real `bad\u{FFFD}.txt` sitting
beside it: deleting the raw entry deleted the innocent look-alike. The root
cause was `to_string_lossy` at every native→text boundary, not any one
command. ADR 0031 replaces it with canonical wire paths (`wire_path.rs`).

Gotchas that bit during the fix:

- **Double encoding.** `Path::new(wire)` followed by `encode_path` re-escapes
  the escapes. Decode wire text to a native path before any filesystem call,
  and encode exactly once when a native value becomes text.
- **Lossy look-alikes are distinct files.** Regression fixtures must always
  create the U+FFFD spelling beside the raw name and assert it is untouched;
  a test with only the raw file passes when the code silently misses it.
- **Copy targets were renamed lossily.** Copy/move composed destination names
  from `to_string_lossy` source names, creating a different (look-alike) name.
  Keep names as `OsStr` until the final `join`.
- **History stores wire names.** Rename undo joined a wire name onto a native
  parent; compose on wire strings (`wire_path::join`) or decode first.
- **libgit2 `entry.path()` is `None` for non-UTF-8 paths.** Use
  `path_bytes()`; `git status --porcelain -z` output is bytes too.
- **`BufReader::lines` aborts on the first non-UTF-8 line** (WSL `find`); read
  with `read_until` and skip what cannot be named.
- **Untracked directories collapse.** `git status` reports a wholly untracked
  directory as one entry, so a status test inside a non-UTF-8 directory needs a
  tracked file in it first.
- **git pathspecs are bytes.** `DiffOptions::pathspec(&wire)` matches nothing
  for an escaped name, so its diff renders as "no changes"; pass
  `wire_path::decode_bytes(path)?` (SCM diff, commit diffs, file history).
- **Refusals must decode, not grep for escapes.** A genuine U+EF80–U+EFFF
  name is escaped too; `native_text` decodes and refuses only non-UTF-8, and
  its caller must use the returned text, never the wire string.
- **Two text domains in the frontend.** The rename box holds display text, AI
  providers and stores hold wire text; convert at the boundary (an accepted
  suggestion was escaped twice). Strings typed into a shell, sent to the
  asset protocol or shown in a toast are not identities either.
- **`std::env::args()` panics on a non-UTF-8 argument.** Use `args_os` and
  encode each path once.
- **Startup bundle.** A new shared domain module imported from a lazy dialog
  becomes its own startup chunk (~220 bytes gzip). The conflict prompt
  therefore receives display text from the backend instead of importing
  `displayName`.

Proof: `src-tauri/test_support/wire_path_fs_test.rs` plus the per-module tests
in `search.rs`, `content_search.rs`, `clipboard/file_uri.rs`,
`files/git_status.rs`, `git.rs` and `fs_watcher_changes.rs` all fail when
`encode`/`decode` are stubbed to the pre-#1592 lossy conversion. Refused
surfaces fail when the refusal is stubbed to accept. The git diff tests fail
with the pathspec decode reverted; `tests/domain/terminal-command.test.ts`
and the AI-suggestion case in `e2e/non-utf8-names.spec.ts` fail with their
frontend fixes reverted. Remaining degraded
surfaces are tracked in #1638.

- **Unix APIs do not imply a byte-permissive filesystem.** APFS accepts only
  valid UTF-8 names ([Apple APFS FAQ](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html)).
  Real invalid-byte fixtures are Linux-only, matching the mutation/watcher
  integration suite. Canonicality/property/URI tests remain portable; a real
  reserved-Unicode listing/rename test runs on Linux, macOS and Windows and
  keeps an actual wire-spelling look-alike beside the selected file.
