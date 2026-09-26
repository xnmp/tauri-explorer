# 779 — Concurrent terminal spawns deleted the shared zsh shim

`install_zsh_shim` removed `~/.cache/tauri-explorer/zsh-shim` and rebuilt it
on every zsh spawn, "so a stale shim can't linger". Spawns overlap: several
panels, restored sessions, a second window, or `cargo test` beside the
installed app, since the tests spawn zsh through the same function and the
real cache. A zsh starting during another spawn's install found an empty
`$ZDOTDIR`. It then showed `zsh-newuser-install` and never registered the
OSC 7 hook, so the explorer stopped following the shell's directory.

- **Never delete a directory another process may be reading.** Replace files
  by renaming a complete staged file over them. A reader then holds the old
  inode or opens the new one, never a missing or truncated file.
- **Name shared generated files after their content.** The shim directory is
  `zsh-shim-<digest>`, so two builds with different shims never rewrite each
  other's files. An edited file is still repaired on the next spawn.
- **Test with overlapping installers and a reader**, as
  `concurrent_shim_installs_never_hide_a_startup_file` does. An editor thread
  forces the concurrent repair path. With an in-place `fs::write` the test
  fails with truncated reads; the old remove-and-rebuild logic failed 5,341
  of 8,000 reads.
