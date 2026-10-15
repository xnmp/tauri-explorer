# GNOME Wayland drag intent needs a fresh source snapshot

GTK's keymap cache and DOM key listeners both miss Ctrl changes consumed by
Mutter's native drag grab. A second application-side copy of that cache would
not fix the problem. Negotiated DnD actions also cannot serve as intent: they
are constrained by the Copy-only acknowledgement that protects external files.

The source now creates a separate `wl_keyboard` on GTK's existing connection
and seat, before handoff. Its own queue drains initial focus, then waits for
Leave followed by Enter and the matching focus-serial Modifiers event. If
WebKit already holds the grab when handoff IPC arrives, the initial keyboard
has no focus; its first restoration pair is used instead. Mutter
updates XKB state even while it consumes key events. At button release it sends
Drop, detaches the grab and restores keyboard focus synchronously; restoration
serializes current XKB modifiers before another key event can run. Thus the
first restoration snapshot represents Ctrl at drop, including late press or
release. Later queued key changes cannot overwrite it.

Use the compositor-provided keymap to interpret Control. Keymap file descriptors
have no promised seek offset: read at zero, without modifying the shared file
offset. A separate Wayland connection would not receive the source client's
focus; the observer must borrow GTK's connection and retain its owners. Its
queue must not dispatch or replace GTK's own keyboard listener.

The host applies the result only to a receiver whose complete native file set
matches its captured in-app source. Source completion releases the additional
keyboard but retains the immutable gesture-bound result for delayed delivery.
An interrupted grab with no restoration snapshot cancels the in-app drop; it
must not fall back to a cached destructive guess. Other compositors/platforms
retain their existing path. OS acknowledgements and non-file delivery are
unchanged.

Verification combines the native receiver's serialized payload assertions, a
real wire-protocol test compositor using a foreign display/private queue, and
the existing frontend drop-policy/callback regressions. The protocol test sends
no key events during the grab and queues an opposite modifier state after Drop
before the observer dispatches. No physical GNOME Wayland reproduction is
claimed; browser screenshots show downstream consumption of snapshot values.

Source references (Mutter 46; also checked against current upstream):

- [Drag grab and release ordering](https://github.com/GNOME/mutter/blob/gnome-46/src/wayland/meta-wayland-data-device.c)
- [Synchronous focus invalidation on grab detach](https://github.com/GNOME/mutter/blob/gnome-46/src/wayland/meta-wayland-input.c)
- [XKB updates and Enter/Modifiers serialization](https://github.com/GNOME/mutter/blob/gnome-46/src/wayland/meta-wayland-keyboard.c)
