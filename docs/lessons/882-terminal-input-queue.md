# #882 — One terminal input queue, ordered by the backend

**Symptom.** Keys typed while the shell was starting were silently dropped, while
path insertions typed in the same window were queued. The two behaviours came
from different layers. One PTY input stream crossed three stacked queues: a
component-local `pendingInsertions` array, a paste-capture queue in `state/`,
and the session's ordered writer. Cold insertions were also quoted with the
platform's default shell dialect rather than the dialect of the shell that
actually spawned, which is wrong for a WSL pane on Windows (#409).

**Cause.** Ordering was a frontend-only invariant. `terminal_write` accepted
concurrent writes and ran each one on the blocking pool. Tauri spawns every
async command onto a multi-threaded runtime, so a backend channel alone does not
restore call order: two invocations issued in order can reach the command
bodies in either order.

**Fix.**
- `src-tauri/src/terminal/input.rs`: each write carries the caller's sequence
  number. The backend admits writes in that order, holds early arrivals, and
  ignores a repeated number. One writer thread per PTY drains a channel, so a
  blocked PTY never blocks the command or the registry. The input stream exists
  from reservation. Typeahead is held (64 KiB) and delivered before any later
  write. Once one chunk does not fit, the rest of the pre-start input is
  discarded, so an Enter after a hole cannot run a partial command. The receipt
  reports the discarded bytes, and the panel warns about them.
- `domain/terminal-input-queue.ts`: the one frontend queue. `write` takes a
  string or a promise, so a clipboard read or a dialect-dependent insertion
  keeps its key position. It holds input until reservation returns the id, and
  it keeps one coalescing send in flight. A sequence number is spent only by a
  send that succeeded, so a failed send never leaves the backend waiting for a
  gap.
- `state/terminal-session.ts`: opens the queue at start, and at `restart`
  before the old shell is killed, so keys typed during a restart go to the
  replacement shell. It closes the queue on stop or exit. The old stream's
  unsent input never reaches a successor (#709).
- `domain/terminal-paste.ts`: per-platform paste source order with the readers
  injected, and the bytes xterm's `paste()` emits. This replaces capturing
  `onData` during a synchronous `term.paste()`.

**Evidence.** Rust hermetic `/bin/sh` tests (`terminal.rs`) cover typeahead
written in the Reserved and Starting phases, 38 writes (mostly single
characters) released together from separate threads, a retried write that runs once,
and a closed terminal that refuses input while its successor starts clean. The
concurrent test fails when the sequencer is bypassed. Unit tests in
`terminal/input.rs`, `tests/domain/terminal-input-queue.test.ts`,
`tests/domain/terminal-paste.test.ts` and `tests/state/terminal-session.test.ts`
cover the protocol, the paste source order on each platform, and the session
lifecycle.

**Rule.** When a stream crosses Tauri IPC and its order matters, number it
at the source and enforce the order where it is consumed. Keep one owner for
the stream on each side. A component-local buffer beside that owner is a
second queue.
