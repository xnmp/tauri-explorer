# 835 — Cross-window clipboard order and Cut ownership

Each renderer previously serialized only its own OS writes. Two windows could
accept Copy in order A then B while A's slower native write completed last.
Unversioned cross-window events could also restore stale Cut state. Comparing
file paths did not prove Cut ownership: an external file manager could replace
our Cut with a Copy of the same paths and the app would still move the files.

File clipboard commands now enter one process-wide, non-cancellable Rust worker
before the IPC future waits. It orders publish, snapshot, clear, and rename;
revisions guard clear and rename, while window events carry only invalidation
hints. Paste waits for the ordered native snapshot, including pending Copy writes from
other windows. Cut requires a settled native ownership token.

On X11, `clipboard-rs` owns the clipboard with `text/uri-list`,
`x-special/gnome-copied-files`, and an app-private token in one write. A Cut is
admitted only when its token reads back. A replacement owner with identical
paths lacks that token, so paste copies. Wayland, Windows, and macOS continue
to admit Copy and external file Copy, but Cut fails closed until those backends
can prove native ownership. This boundary prevents a stale Cut from moving
someone else's selection. After a failed Copy mirror, the app retains its Copy
while OS observation still matches the pre-write list; X11 also requires the
same selection owner. A changed list or owner makes the external Copy win.
Other platforms have no owner identity in this implementation, so an external
replacement with identical file paths during a failed mirror is observationally
ambiguous there; all such selections still have Copy semantics.

The focused frontend tests cover cross-window convergence, CAS clear, paste
outcomes, and identical-path replacement. The ignored native test
`x11_cut_identity_and_external_file_formats` ran on a private Xvfb display with
`WAYLAND_DISPLAY` unset; it verified both external file formats, the token,
identical-path replacement, CAS rename and clear, and completion of a
worker job after its IPC reply was dropped.

The real Tauri WebDriver scenario under a private Xvfb display cuts a file in
Explorer, replaces the clipboard from `xclip` with an external Copy of the
same URI, then pastes into that directory. The original remains on disk and a
new file with identical contents appears in the native listing. Its screenshot
is in `screenshots/fix/clipboard-cross-window-order/`.
