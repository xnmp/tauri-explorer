# #877 — Native Cut ownership on Wayland, Windows and macOS

Cut used to fail closed everywhere except X11. Each backend now proves that
its own write still owns the clipboard, through the `owner_token` seam from
#876; the coordinator is unchanged.

## Wayland: a held `wl-copy --foreground` owner

- `wl-copy` exits when another client takes the selection, so the selection
  is ours exactly while the child runs. `owner_token` is "child alive".
- A write must not return until the selection offers the new payload.
  Otherwise the coordinator's next snapshot reads the previous list and
  adopts it as an external replacement, destroying the new Cut. The backend
  polls `wl-paste` for the exact payload bytes while the child is alive.
- Stop (kill and reap) the previous owner *before* starting the next. If the
  old owner still served an identical list (Copy then Cut of the same file),
  the read-back could not show whether the new owner had published.
- One `wl-copy` process offers one payload. The backend offers only
  `x-special/gnome-copied-files` (GTK file managers), as the Wayland Copy
  already did; `text/uri-list` would also be offered as `text/plain`.
- At exit the last owner is left running on purpose: the mirror always has
  Copy semantics, and other programs keep the pre-#877 ability to paste the
  last Copy after the app quits. The worker is a never-dropped static, so no
  destructor would run anyway; the child starts in `/` so it cannot keep a
  removable volume busy. Exited owners are reaped by the next ownership
  check, so at most one zombie can exist between clipboard operations.
- A clipboard manager that re-offers every selection itself (for example
  `wl-clip-persist`) ends our ownership at once, so Cut fails closed there.

## Windows and macOS: a change counter around a token read-back

`change_counter.rs` holds the shared, platform-free rule: observe the counter
(`GetClipboardSequenceNumber`, `NSPasteboard.changeCount`), read the private
token back, observe the counter again. Equal counters around a matching token
prove that the counter value names our write. Ownership lasts while the
counter keeps that value, so any later change, including an identical file
list, ends it.

- Windows writes `CF_HDROP` and the token format in one WinForms
  `DataObject`. A `MemoryStream` is stored as raw bytes, and
  `SetDataObject(data, $true)` renders every format before PowerShell exits.
  The token read-back tolerates trailing NULs, because `GlobalSize` may exceed
  the requested size. A process that re-renders every clipboard change
  (remote-desktop redirection) makes Cut fail closed.
- macOS: `clipboard-rs`'s `set([Files, Other])` cannot carry a token. Its
  `Other` arm calls `declareTypes`, which clears the files written just
  before. The backend declares `NSFilenamesPboardType` and the token type in
  one `declareTypes` call through `objc2-app-kit`. The legacy type is
  deprecated, but it is what `clipboard-rs` wrote and reads, and Finder
  pastes it.

## Verification

- Pure rules: `change_counter` tests; Wayland lifecycle tests against a
  simulated compositor (publish wait, replacement, crash, republish reaping,
  exit-before-publish, timeout).
- Real `wl-copy`: the ignored `wayland_owner_process` test, run inside a
  private headless `cage` session. `cage` has no data-control, so `wl-copy`
  needs keyboard focus: hold a virtual keyboard with `wtype -s 600000 x &`.
  Keep `XDG_RUNTIME_DIR` short; a Wayland socket path must be under 108
  bytes. The command is in `linux/wayland.rs`.
- The native `context-clipboard` spec (Cut + Paste moves; an external Copy
  of the same path demotes Cut) passes under Xvfb and under headless `cage`,
  where `GDK_BACKEND=wayland` and `dbus-run-session` isolate the app. The
  Windows CI smoke runs the same spec.
- Windows and macOS real-clipboard tests are `#[ignore]`d, because they
  replace the clipboard. rust-platforms.yml runs them with
  `cargo test --lib native_clipboard_ownership -- --ignored` and requires
  exactly one pass. Off-platform, type-check both modules with a scratch
  crate that symlinks them in, using
  `cargo clippy --target aarch64-apple-darwin` or
  `--target x86_64-pc-windows-gnu`. The full crate cannot build for those
  targets here, because its C dependencies need target toolchains.
