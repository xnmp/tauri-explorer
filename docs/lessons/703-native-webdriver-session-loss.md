# #703 — A lost native session leaves no evidence unless it was recorded first

Linux native qualification intermittently failed `directory-watch-lifetime.spec.ts`
on the first `findElement(.file-list)` in a freshly opened child window. From the
attempt-1 job log (run 34422867761, job 102701875097):

```
00:52:16.699  executeScript -> "explorer-07c90c35-…"   (fresh child label read)
00:52:16.700  POST /session/…/element  {"using":"css selector","value":".file-list"}
00:52:17.348  [Perf] dir scan '…/main': 1 entries        (last output of any kind)
00:52:36.640  WARN  WebDriverError: Could not parse element info
00:52:37.143  WARN  WebDriverError: session deleted because of page crash or hang.
00:52:37.145  ERROR WebDriverError: invalid session id
```

Everything after that is an invalid-session cascade, including the remaining test
and the `after` hook. The unchanged-source retry passed the same suite.

Two facts constrain any explanation. Handle selection was correct: the helper read
the requested label out of a handle absent from the pre-launch snapshot, one
millisecond before the lookup. And the failing command hung for ~19.9 s — a driver
timeout, not an application timeout — before WebKitWebDriver itself reported a page
crash or hang. WebKitWebDriver deletes the automation session when a renderer dies
(the same property `git-watch-renderer-crash.spec.ts` already documents), so the
cascade is expected once the renderer is gone; what the log cannot say is *whether*
it was gone.

The log could not distinguish:

1. the child's `WebKitWebProcess` crashed or wedged (CI runs WebKitGTK on llvmpipe
   under Xvfb — `libEGL warning: DRI3 error: Could not get DRI3 device`),
2. the driver lost the session while the renderer stayed alive, or
3. the page navigated/reloaded and never rendered a file list.

Nothing was recorded between the last successful command and the first failing one,
and by the time the failure surfaces the session is invalid — no further
`browser.execute` can answer anything.

So the recording has to happen *before* the lookup, and the failure path has to
observe processes only:

- `switchToFreshWindow` takes one atomic renderer sample at successful selection
  (label, hook readiness, `.file-list` count, entry count, status path, URL,
  `readyState`, visibility) plus one `/proc` scan, always on. It reads DOM state
  only, because WebKitWebDriver may evaluate injected scripts in an isolated world.
- `waitForFreshWindowElement` replays that record with the lookup error and a second
  `/proc` scan when the element never appears. Comparing the two scans is the
  discriminator: a `WebKitWebProcess` present at selection and absent afterwards is
  hypothesis 1; both scans intact points at 2; a selection sample with
  `fileListCount: 0` or an unexpected `statusPath`/`url` points at 3.
- `tauri-driver` (whose stdio `WebKitWebDriver` inherits) is now teed to
  `e2e-tauri/logs/tauri-driver.log`, which CI already uploads with the WDIO logs.

Diagnostics must never change the outcome they document: every capture is wrapped,
a failed capture is stored as `{ error }`, and an unwritable artifact directory
returns `null` rather than throwing. Per ADR 0021 the window label is digested into
the artifact file name and kept verbatim inside the JSON body.

Not reproduced locally: `tauri-driver` refuses to start without `WebKitWebDriver`,
which on Arch ships only in `webkitgtk-6.0`, and the machine has no Xvfb — so the
suite cannot run there at all. The failure remains an open native qualification
limitation; the next Linux occurrence should arrive with the evidence attached.

Do not respond to a recurrence with focus changes, sleeps, larger timeouts or
blanket retries: none of them are supported by the sequence above.
