# #927 — Wayland Cut needs per-write identity, not matching bytes

#877 proved a Wayland Cut by reading `x-special/gnome-copied-files` back while
the `wl-copy --foreground` owner ran. That proves content, not source. Suppose
an owner stays alive but never publishes, and another client offers the
identical list during the 2 s wait. That client could be the user copying the
same file in a file manager, or a clipboard manager restoring the list after
`stop_owner`. The offer was then credited to our owner, and the Cut survived
with nothing to demote it. A later Paste would move a file the user had last
copied elsewhere.

## What proves a write now

- The owner is the app's own executable in a private early mode
  (`--te-wayland-clipboard-owner-v1`, dispatched from `main.rs` before any
  other initialization, like the process supervisor). It is a data-control
  client (`ext-data-control-v1`, else `zwlr-data-control-unstable-v1`). It
  offers the unchanged file-list bytes first and, as
  `application/x-io.github.xnmp.tauri-explorer.file-clipboard-token`, the
  coordinator's random per-write token.
- A write is proven when `wl-paste` reads that token back while the owner
  still runs. No other client can offer the token before our owner
  published it. A client that copies it afterwards took the selection, which
  ends our owner. An older write's token, restored by a clipboard manager,
  never matches.
- No baseline read is needed on this path. An identical external list
  offered before or during the wait no longer blocks Cut, because our owner
  publishes over it and proves itself by its token.
- It is a separate process, not a thread, for the same reasons `wl-copy`
  was. A kill stops it, an exit means the selection was lost, and the last
  owner keeps serving Copy after the app quits.
- Send each paste on its own thread. A reader that stalls must not keep the
  owner from handling `cancelled`. While the owner runs, the backend counts
  the selection as ours.

## Without data-control

- No unprivileged client can set the selection there without keyboard focus.
  `wl-copy` uses a focus trick that an extra private type cannot be added
  to, so per-write identity is impossible. The owner exits with code 3. The
  backend remembers this for the process, serves Copy through `wl-copy`
  (still waiting until a changed list is visible) and refuses Cut through
  `cut_unavailable_reason`. Without data-control, then, Cut is no longer
  available on Wayland. The README and alpha-testing notes say so.
- If the owner cannot start at all (for example, the executable was replaced
  by an upgrade), the backend falls back the same way for that write
  without remembering it.

## Verification

- Simulated compositor (`wayland.rs` tests): a `NeverPublishes` owner with
  an identical external offer at a chosen poll pause, a restoring manager
  re-offering an earlier write's token, the no-data-control fallback, and the
  normal publish/replacement lifecycle. Schedule the offers relative to the
  current pause count. Absolute pause numbers had already passed by the
  second write, and one race test then passed for the wrong reason.
- Real wire protocol: `test_support/wayland_data_control_compositor.rs` is a
  `wayland-server` compositor with a seat and both protocols. It runs in
  ordinary `cargo test`. It must send `selection(null)` to a new device when
  nothing is selected; `wl-paste` blocks waiting for that event otherwise.
- End to end: the ignored `wayland_owner_process` test runs the built binary
  plus real `wl-paste`/`wl-copy`. Run it against that compositor on a socket
  (`PRIVATE_WAYLAND_TEST_COMPOSITOR=1`, absolute `WAYLAND_DISPLAY`), or
  inside headless `cage`, which has no data-control and so proves the
  fallback. Hyprland cannot start headless in the agent sandbox (it needs a
  GPU allocator), and `cage` lacks data-control, hence the test compositor.
