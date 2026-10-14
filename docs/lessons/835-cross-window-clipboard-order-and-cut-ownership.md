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

## Completion after the originating window closes

The ordered worker landed before this issue's final acceptance pass; platform
follow-ups also added native Cut proof on Windows, macOS and Wayland. The
remaining publication hole was that only the originating renderer broadcast
a successful Copy/Cut. Its accepted native job survives cancellation, but its
renderer continuation does not. The job now emits the revision invalidation
before replying, so other windows reconcile even if the caller closes.

`test_support/clipboard_order.rs` holds real worker writes at the backend seam,
releases permits in both orders, and repeats all Copy/Cut pairs across 128
selections, then drains a 256-write backlog with all newer permits released
first. A reversed completion order is prevented by the FIFO worker;
releasing B's permit before A's cannot make B overtake A. Paste snapshots from
both callers see B, obsolete Cut claims fail, and external changes after
settlement win. The cancelled-caller notification assertion failed before the
native publication change. The original OS-ordering repair already exists on
the integration base; these tests retain it rather than replace its design.

`e2e-tauri/specs/clipboard-cross-window.spec.ts` runs two actual webviews with
bounded native write gates. It reads the platform clipboard independently,
asserts both renderer stores without triggering reconciliation, pastes into
both windows and verifies file bytes on disk, checks Cut movement, and closes
a publishing window during its native write. PR smoke checks remain Linux-only.
Windows qualification runs after merge on dev pushes: `NATIVE_SCOPE=all` calls
`bun run test:e2e:tauri`, whose `./specs/**/*.spec.ts` glob includes this spec.
A full-scope Windows dispatch includes it too; the narrower `clipboard`
dispatch selects only `context-clipboard.spec.ts`. No workflow changes are
needed to discover the new spec. The existing Linux evidence was captured on
a private Xvfb display and carries forward because this CI-policy correction
does not change clipboard behavior.

The original failure was also reproduced against the actual renderer module
from the parent of the #844 integration (loaded temporarily, without changing
branches). Two isolated imports used controlled deferred OS writes; B's write
and broadcast finished before A was released. Both real historical stores
contained `/B`, but `readOsFiles()` returned `[/A]`, failing the expected
`[/B]` assertion. Only the OS adapter and event transport were mocked. The
historical module and one-off runner were removed after this diagnostic;
maintained regressions exercise today's production Rust worker and native
windows rather than retaining a duplicate obsolete implementation.
