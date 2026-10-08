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
- Seeing the payload proves nothing when the selection already offered those
  bytes. Nautilus, Nemo, Caja and a previous app instance write the same
  `copy\nfile:///…` list. Adversarial review found that a child that never
  published was credited with the external offer. Its Cut then survived the
  user's later external Copy of the same file, so Paste moved a file the user
  had last copied (the #835 class). The write therefore reads the offer as a
  baseline after stopping the previous owner. If the baseline already equals
  the payload, the child serves the list for Copy, but its write is never
  proven, so Cut is refused. Otherwise the offer must change to the payload
  while the child is alive; the child must still be alive *after* that read.
  Do not make the payload unique with a `#` comment line: whether GTK file
  managers accept one is unknown.
- A failed read is not an empty selection. `read_mime(...).ok().flatten()`
  collapsed a spawn error, a lost compositor and "nothing copied" into one
  `None`, so a failed baseline read hid an identical external offer and the
  next read credited it to the new owner. Reads are now tri-state (`Offer`:
  empty, bytes, unreadable). Only wl-paste's own exit-1 reports count as
  empty, matched exactly: `Nothing is copied` and `Clipboard content is not
  available as requested type "<type>"` (2.2+), and `No selection` and `No
  suitable type of content copied` (1.0–2.1). Other exits, signals and a 1 s
  read timeout are unreadable. An unreadable baseline or read-back serves the
  list for Copy but leaves the write unproven, so Cut is refused.
- Remaining windows, accepted and fail-open only within them:
  - An identical external Copy can land between the baseline read and our
    publish. Our child then publishes over it, and we own the selection.
  - An identical external Copy can land after we publish but before `wl-copy`
    handles `cancelled`. Until the child exits, `owner_token` still vouches
    for it.
  - Known residual (found in review, not fixed): the read-back proves
    publication by content, not by source. It needs a `wl-copy` that stays
    alive but never publishes (wedged), and byte-identical data that another
    client offers after the baseline read and within the 2 s poll window.
    Examples: a clipboard manager restoring the list after `stop_owner`, or
    the user copying the same files within 2 s. That offer is then credited
    to our child. The full fix needs per-write identity: a unique payload,
    or the source identity that only the data-control protocol exposes.
    Whether GTK file managers accept a unique payload is unverified.
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
- The first real-clipboard CI run proved ownership and exposed an older bug:
  `read_files` printed paths on PowerShell's redirected stdout, which uses the
  console code page, so `é` came back as `?`. File lists now travel as
  base64 UTF-8, as `read_text` already did. Any PowerShell output that can
  hold user text needs this.
- macOS: before the 0.3 upgrade, `clipboard-rs`'s `set([Files, Other])`
  could not carry a token. Its `Other` arm called `declareTypes`, which
  cleared the files written just before. The original backend declared `NSFilenamesPboardType` and the token
  type in one `declareTypes` call through `objc2-app-kit`. That legacy type
  matched `clipboard-rs` before its 0.3 NSURL migration; #846 replaced the
  representation with file-URL items, as described below.
  - `changeCount` moves only on an ownership change (`clearContents`,
    `declareTypes`). Another process calling `addTypes` or `setData` on the
    types we declared alters the content without moving the count, so that
    edit keeps our ownership.

## Where Cut degrades (fails closed or slows Copy)

- A clipboard manager that re-owns every selection (`wl-clip-persist`,
  Windows remote-desktop redirection, some Windows managers) ends ownership
  at once, so Cut is refused.
- Windows: if another process holds the clipboard open for more than about
  1 s (100 retries at 10 ms; #912), the token read-back fails and that write is
  unproven.
- Wayland: a `wl-copy` that stays alive but never publishes blocks each
  Copy/Cut for the 2 s publish timeout before failing. That happens when the
  compositor has no data-control protocol and `wl-copy` gets no keyboard
  focus.
- Wayland: when `wl-paste` fails or prints a message this backend does not
  recognise (a future wl-clipboard wording), every read is unreadable, so
  Copy still works and Cut is refused.

## Verification

- Pure rules: `change_counter` tests; Wayland lifecycle tests against a
  simulated compositor (publish wait, replacement, crash, republish reaping,
  exit-before-publish, timeout, identical or unreadable baseline); wl-paste
  exit classification and the bounded read (spawn failure, timeout).
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
  `--target x86_64-pc-windows-gnu`. The full crate also passes
  `cargo clippy --target aarch64-apple-darwin --all-targets -- -D warnings`
  with `CC=true AR=true` and `turbojpeg-sys` pointed at empty directories
  (`TURBOJPEG_SOURCE=explicit`, `TURBOJPEG_LIB_DIR`,
  `TURBOJPEG_INCLUDE_DIR`); clippy never links, so stub C tools suffice.

The #846 dependency upgrade replaced the macOS legacy filename representation
with ordered `public.file-url` items and a private nonce on the first item,
published together through `writeObjects`, because `clipboard-rs` 0.3 reads
`NSURL` objects. The stable file/token/change-count proof remains unchanged;
see [the compatibility lesson](846-tauri-dependency-api-compatibility.md).
