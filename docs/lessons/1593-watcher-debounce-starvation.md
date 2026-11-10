# Watcher debounce needs a maximum wait (#1593)

A trailing-only debounce resets on every event, so a directory written
continuously (build output, download) never emitted `directory-changed` and its
listing went stale for the whole write. `PendingChange` now remembers its first
pending event and `ready()` also fires once `MAX_WAIT` (1.5 s) has elapsed since
it. A lone burst still coalesces after the 300 ms quiet period; `MAX_WAIT >=
DEBOUNCE` is a compile-time assertion. `observed_at_ms` stays the newest event's
time. The flush removes the batch, so the next event starts a fresh one and is
debounced again.

The flush thread's queue and flush steps are the seams `record_change` and
`take_ready_changes` (the thread itself needs an app handle). Unit tests use
injected instants; one real-time test drives both seams from a feeder thread
and a poller and waits, generously bounded, for a flush whose newest event is
younger than DEBOUNCE — the quiet rule cannot explain that flush, so host load
that stalls the feeder only delays the test rather than failing it.
