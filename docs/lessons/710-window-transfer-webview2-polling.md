# #710 — Synchronous WebDriver polling can starve the event it observes

The Windows native window-transfer smoke failed intermittently in two apparently
different places: a large tear-off returned `moved: false`, and a destination
listing failed to show a file that its native watcher had already observed.
Neither failure was fixed by changing the ownership contract or the assertions.

In the retained run, `operation()` repeatedly sent synchronous `executeScript`
commands while reading a stale operation token. Individual calls slowed from
milliseconds to seconds. The child did not begin normal renderer startup until
after the launcher's intentional ten-second adoption deadline returned false;
the late native window was then correctly retired. In the listing failure,
native logs recorded the write promptly, but the renderer refresh was delayed
while the same WebDriver command queue was saturated. WebView2 later reported a
full message queue during diagnostic collection.

The fix is one asynchronous WebDriver evaluation per observable. The operation
wait installs a `MutationObserver` for `data-e2e-window-result` before dispatch,
ignores stale tokens, and completes only for its request token. The listing wait
similarly observes entry mutations inside the renderer. The strict `moved` and
watcher assertions and the production ownership timeout stay unchanged.

Failure evidence also has to survive the runner. Writing screenshots to `/tmp`
did not place them in the Windows workflow artifact. Transfer failures now write
runtime/commit/window JSON and a screenshot under `e2e-tauri/logs/`, the path the
native workflow already uploads.

For native WebView tests, a short polling interval is not necessarily passive:
every `browser.execute` is transport work competing with application processing.
Prefer a single `executeAsync` call whose renderer-side observer waits for the
actual DOM or correlated protocol change.
