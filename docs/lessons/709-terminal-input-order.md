# #709 — Terminal input reached the PTY out of order

**Symptom.** The native `terminal-key-ownership` smoke failed intermittently on
ubuntu CI. The typed probe command arrived with adjacent characters swapped
(`rpint`, `flsuh=True`, `)p;`), Python raised a syntax error, and the spec
timed out waiting for the Ctrl+Q byte. It was blamed on WebDriver key delivery.
`terminal.spec.ts` had already been changed to type one character per
WebDriver command for the same reason, attributed to msedgedriver.

**Cause.** The app reordered the input itself. Every xterm `onData` chunk
issued its own `invoke("terminal_write")`, and the Rust command ran each call
on the blocking pool. Two keystrokes in flight at once could be written to the
PTY in either order. Fast typing, key repeat, or a loaded machine was enough to
overlap them.

**Fix.** `domain/ordered-writer.ts` keeps at most one write in flight for each
PTY and coalesces input that arrives meanwhile into the next write.
`state/terminal-session.ts` owns one writer for each running PTY. Its `write`
method is the only input path (keystrokes, shortcut sequences, `cd` injection
and path insertion), and it closes the writer when the PTY stops, so unsent
input never reaches a restarted shell. A stalled PTY now buffers in the page
instead of occupying one backend thread per keystroke.

**Evidence.**
- `e2e-tauri/specs/terminal-input-order.spec.ts` types a 40×72 burst into
  `cat` and compares the written file exactly. Each line is the 36-symbol
  alphabet at a different rotation, so any adjacent transposition shows. Its
  single-task case dispatches every xterm input event before the first write
  can finish. Before the fix it failed 3 of 3 runs with adjacent transpositions
  (`bacdefgh`, `acb`). The WebDriver-paced case showed one clear local transposition (`0123` → `0132`) in 13 runs; CI load makes it common.
- The spec waits for `cat` to own a cooked-mode tty before typing. Input typed
  ahead while zsh's line editor holds the tty in raw mode skips CR→NL
  translation, which corrupts the file for a reason unrelated to ordering.

**Rule.** Separate Tauri invocations are unordered. Any stream whose order
matters (PTY input, appends, sequenced commands) needs one owner that
serializes it. Don't rely on call order, and don't slow the test driver down
until the race stops showing.
