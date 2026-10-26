# Streaming-search completion timeout (#1215)

`issue_651_real_streaming_command_reuses_refreshes_and_cancels_listings`
intermittently panicked `completed streaming search event: Timeout` in the
loaded opt-in Rust suite. The search was not slow. Its `done` event was
emitted and then never delivered to the test.

Tauri 2's Rust-side listener dispatch (`Listeners::emit_filter`) takes the
handler table with `try_lock`. If any other thread is emitting on the same app
at that moment, the event is put in a pending queue. That queue is flushed
only by a later emit that actually calls a handler. The fixture's
`init_watcher` flush thread emits `directory-changed`, which has no Rust
listener. When the two emits collide, the search's `done` stays in the queue
indefinitely. CPU load widens the window. Webview (JS) delivery takes a
separate, blocking lock, so production Quick Open does not lose events.

Evidence:
- Isolated runs and 16,261 runs under heavy external CPU contention passed.
  The p99 for the whole test was 0.66 s and the maximum was 0.98 s. The 5 s
  deadline was never close.
- A thread repeatedly emitting an unlistened event on the observed app reproduced
  the exact CI panic within 205 searches. The worker trace showed
  `completion-emitted Ok(())` at +0.3 ms, but the listener never ran.
- With the lossless sink, 20,000 of 20,000 searches completed under the same
  concurrent emitter.

Fix: the command publishes through a `SearchResultsSink`. Production's sink is
the `AppHandle` (`search-results` event, payload covered by its own test).
Tests record into a channel. The 5 s wait remains as a hang guard. A timeout
now names the query, search ID, the worker's last phase (registration, walk,
publication) with timestamps, and the events received while waiting.

Rules:
- Don't use `app.listen`/`listen_any` as a completion oracle when any other
  thread can emit on the same app. Inject a sink, or prove that the app has a
  single emitter.
- Under the same feature set, a jwalk walk silently returns no entries if rayon's
  global pool is busy for more than 1 s (`ThreadpoolBusy`, a follow-up
  production finding). That looks like missing results, not a timeout.
