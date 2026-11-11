# ADR 0031: Wire paths for file names that are not valid UTF-8

Status: Accepted

Governs: `src-tauri/src/wire_path.rs`, `src-tauri/clippy.toml`,
`src/lib/domain/wire-name.ts`

## Context

Linux and macOS file names are byte strings; Windows names are UTF-16 that may
contain unpaired surrogates. Every IPC field that names a file is a JSON
string. Before #1592 the backend converted names with `to_string_lossy`, so
`bad\xff.txt` was listed as `bad\u{FFFD}.txt`. Sending that string back opened,
renamed or deleted a different file — or, when a real `bad\u{FFFD}.txt`
existed, that innocent look-alike. Two native names could also list as the
same string, merging their badges, selection and history.

## Decision

**One canonical text spelling ("wire path") for every native path.**

- Valid UTF-8 that contains no character in U+EF80–U+EFFF is unchanged and
  borrowed: ordinary names cost nothing.
- Each byte of an invalid UTF-8 sequence, and each byte of a genuine
  U+EF80–U+EFFF character, becomes `char(0xEF00 + byte)`. Escapes stand only
  for bytes ≥ 0x80, so ASCII separators, dots and prefixes are untouched and
  `Path` operations on a wire string equal the wire form of the same operation
  on the native path (`parent`, `file_name`, `join`).
- Decoding requires `encode(decode(wire)) == wire`; anything else is
  `InvalidPath("non-canonical path encoding")`. Encoding is therefore a
  bijection between native byte strings and canonical wire strings.
- Windows (phase 1): encode escapes genuine reserved characters; ill-formed
  UTF-16 stays lossy (listed as U+FFFD, so the look-alike hazard remains
  there until phase 2 encodes WTF-8 bytes). Decode accepts escapes only when
  they spell valid UTF-8.

**Invariants.**

- I1 — every IPC and backend `String` that names a file is a canonical wire
  path (display labels, such as a conflict prompt's `fileName`, are text).
- I2 — `wire_path` is the only module that converts between text and
  `OsStr`/`Path`. The ratchet is mechanical only for the lossy direction:
  `clippy.toml` disallows `Path::to_string_lossy` and `OsStr::to_string_lossy`;
  unmigrated modules carry
  `#![allow(clippy::disallowed_methods)] // Retire-when: #1638 closed`, and
  `jsc_workaround.rs` / `webkit_renderer.rs` keep a permanent allow (they read
  environment values and device names, never file names). `display()` and
  `to_str()` stay allowed for messages and UTF-8-only checks, and the
  text-to-path direction (`Path::new(&wire)`) is enforced by review: a wire
  string reaches the filesystem only through `wire_path::decode`.
- I3 — every mutating command decodes its paths before any side effect, or —
  where a surface can only carry text in phase 1 — takes
  `wire_path::native_text`, which decodes and refuses only names whose native
  bytes are not UTF-8 ("This action does not support names with invalid text
  encoding yet"). Callers use the returned text, never the wire string. The
  literal git index-path validator (`literal_repo_path`, stage/unstage/
  discard/gitignore) still refuses every escape, including genuine
  U+EF80–U+EFFF names (`refuse_escaped`; #1638). Order: decode, structural
  validation on the native value, then admission.

**Frontend.** `entry.name`/`entry.path` stay identities; `entry.path` is
`parent + "/" + name` exactly as before, and the binary listing format is
unchanged. `displayName` turns each run of escapes back into bytes and decodes
them lossily for display; `toWireText` escapes genuine reserved characters in
typed names. Inline rename edits display text, and unchanged display text is a
no-op. Text clipboard ("Copy Path") carries display text; `file://` URI
formats carry the exact bytes (`%FF`). AI rename suggestions are accepted into
the rename box as display text. Terminal "sync to folder" types the exact text
of every name that is text and skips the sync (rather than cd to a look-alike)
when the native bytes are not text; dropped paths are inserted as display
text and never run without Enter. Image previews skip the asset protocol for
escaped paths and read through the backend.

## Consequences

- Names that were unreachable become exact for listing, watching, rename,
  create, delete, copy/move, history, open, search, clipboard URIs, native
  drag and git status (phase 1, verified on Linux).
- Surfaces that cannot yet carry native bytes refuse escaped paths instead of
  guessing; #1638 lists them and the remaining lossy surfaces.
- Text that legitimately contains U+EF80–U+EFFF still works: it is escaped as
  its own UTF-8 bytes and decodes back to the same name (except for literal
  git index paths, above). Paths persisted before #1592 that contain such a
  character (bookmarks, history) are now non-canonical and are refused rather
  than reinterpreted; no migration is provided.
- Editing part of a name whose bytes are not text (for example only its
  extension) sends the display text, so the invalid bytes become U+FFFD in
  the new name. Mapping an edit back onto the untouched escape runs is phase 2
  (#1638).
- Launch paths come from `args_os` and are encoded once; the Linux
  single-instance hand-off still receives lossy arguments from its plugin.
- Tests share `tests/fixtures/wire-path.json` between the Rust encoder and the
  TypeScript display helpers.
