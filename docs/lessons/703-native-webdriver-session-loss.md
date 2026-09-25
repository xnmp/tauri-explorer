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
- `waitForFreshWindowElement` replays that record with the lookup error and a
  bounded 500 ms `/proc` timeline while the element command is pending. It
  identifies the newest selection-time `WebKitWebProcess` by PID and start time,
  then reports the first trustworthy sample where that identity is absent. A
  capture error is retained and skipped for disappearance classification.
- `tauri-driver` (whose stdio `WebKitWebDriver` inherits) is now teed to
  `e2e-tauri/logs/tauri-driver.log`, which CI already uploads with the WDIO logs.

Diagnostics must never change the outcome they document: every capture is wrapped,
a failed capture is stored as `{ error }`, and an unwritable artifact directory
returns `null` rather than throwing. Per ADR 0021 the window label is digested into
the artifact file name and kept verbatim inside the JSON body.

## Linux reproduction after the first diagnostic landed

The failure reproduced on Ubuntu at dev revision
`d21479ef22ebee6ba4963639b39d7e6e4208234b`, Actions run `34546220599`, in
cycle 3 of `directory-watch-lifetime.spec.ts`. At selection the child page was
complete, visible, hook-ready, and already contained its file list and expected
path. The fresh child renderer (PID 21084, the newest `WebKitWebProcess`) was
present beside the application, network process, main renderer, and a stale
renderer from the previously destroyed child. At the post-timeout sample PID
21084 was gone while every other listed process survived.

That two-point capture rules out page readiness but does not establish ordering:
the renderer may have died before the driver timeout, or session deletion may
have killed the page at the timeout. The pending-command timeline added here is
the bounded discriminator for the next occurrence. This remains diagnosis, not
a product fix; watcher receipt, native ownership, destruction, reload, and
recovery assertions are unchanged.

The original investigation could not reproduce locally: `tauri-driver` refuses
to start without `WebKitWebDriver`, which on Arch ships only in `webkitgtk-6.0`,
and that machine had no Xvfb. The real Ubuntu capture above is therefore the
native evidence, while deterministic unit coverage verifies the new artifact
contract without pretending to reproduce WebKitGTK process loss.

Do not respond to a recurrence with focus changes, sleeps, larger timeouts or
blanket retries: none of them are supported by the sequence above.
