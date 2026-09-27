# #710 — Keep native transfer observation off the synchronous driver loop

The Windows native window-transfer smoke failed intermittently in two apparently
different places: a large tear-off returned `moved: false`, and a destination
listing failed to show a file that its native watcher had already observed.
The repair preserves the ownership contract and the outcome assertions.

In the retained run, `operation()` repeatedly sent synchronous `executeScript`
commands while reading a stale operation token. Individual calls slowed from
milliseconds to seconds before the matching response returned `moved: false`.
In the listing failure, native logs recorded the write promptly, but the
renderer did not expose the new entry within the assertion deadline. These
observations support reducing driver contention; they do not by themselves
prove that polling caused the delay. In particular, the runtime message
"is the messages queue full?" carried `0x80070578` (invalid window handle),
which is not evidence that a queue was full.

The original reported failure is retained in Actions run `34483410658`, revision
`dc05bf33de0588bd4d5084bd45672ab796c82cb9`. The inspected Windows traces show
WebView2 `152.0.4191.66` returning false for the large layout, and
`151.0.4129.101` missing `after-transfer.txt` despite a native watcher receipt.

The fix is one asynchronous WebDriver evaluation per observable. The operation
wait installs a `MutationObserver` for `data-e2e-window-result` before dispatch,
ignores stale tokens, and completes only for its request token. The listing wait
similarly observes entry mutations inside the renderer. The strict `moved` and
watcher assertions and the production ownership timeout stay unchanged.

Failure evidence also has to survive the runner. Writing screenshots to `/tmp`
did not place them in the Windows workflow artifact. Transfer failures now write
runtime/commit/window JSON and a screenshot under `e2e-tauri/logs/`, the path the
native workflow already uploads. Capture the failing window before enumerating
other windows: taking the screenshot at the end captured an unrelated child.
Operation timeouts must enter this same diagnostic path as `moved: false` and
listing timeouts. Call-site regression tests import the native spec and verify
both paths, in addition to testing the renderer observers themselves.

For native WebView tests, a short polling interval is not necessarily passive:
every `browser.execute` is transport work competing with application processing.
Prefer a single `executeAsync` call whose renderer-side observer waits for the
actual DOM or correlated protocol change.
