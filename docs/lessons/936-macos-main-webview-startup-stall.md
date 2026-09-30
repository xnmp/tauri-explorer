# #936 — A macOS startup timeout hid two different failures

`launch-smoke` failed intermittently with `sample N: startup markers missing
after 30000ms` on PRs that could not affect startup. Re-parsing all 7,480
retained CI sample logs with the production parser showed that two unrelated
failures produced that one message.

## Parser rejection reported as missing markers

The qualifier polls the shared attributed parser (#696) and swallowed every
rejection until the 30 s bound. On 2026-09-26, a 12.3 s cold sample had all its
markers but a correlation residual of -6.18 ms. The fixed -5 ms bound rejected
it, and the timeout called that missing markers.

In the residual data, the median stayed near 0 but the most negative residual
grew by about 0.5 ms per second of launch:

| Launch length | Most negative residual |
|---|---|
| under 3 s | -1.5 ms |
| 3–4 s | -2.0 ms |
| 4–6 s | -3.0 ms |
| 6–8 s | -3.8 ms |
| 8.1 s | -4.06 ms |
| 12.3 s | -6.18 ms |

That is the 500 ppm limit on how fast the kernel's NTP discipline can slew the
wall clock. The bound is now 5 ms + 500 ppm × launch total. A timeout also
reports the parser's last rejection, so this failure can no longer pass as a
stall.

## Main webview stall (root cause still open)

Six failures, 2026-09-28 to 2026-09-30, had the same anatomy:

- The process launched and `Startup(native-window)` timings were normal.
- The main page requested its first `list_directory_fresh` about 3 s later, as
  healthy samples do, and Rust completed it in a few milliseconds.
- After that the main window sent nothing for the rest of the 30 s: no
  `Startup(webview)`, no `native-ready`, no git status request, no refresh.
  More than 99% of healthy samples show a git status request.
- In the two warm-probe failures, the warm window in the same process finished
  normally. The Rust event loop and IPC were healthy; one webview stopped.

The git status fetch comes from a microtask-scheduled Svelte effect as soon as
the listing is committed. Its absence therefore points to the page never
processing the listing response (or settings), not to animation-frame
throttling. No healthy sample fell between 10.5 s and 30 s, so it is a hang,
and a longer timeout would not help.

The rate changed around 2026-09-28: 0 in about 9,200 samples before, 6 in about
4,300 after. No merge in that window touches the macOS startup path, and the
runner image did not change. The rate change is not attributed to any commit.

## Instrumentation added (read these on the next failure)

- `Renderer(web-content-terminated)` warns with the window label and both
  clocks when a WebContent process dies. WebKit does not reload the page and
  Wry does not log it, so this renderer loss was silent before.
- `Startup(webview-progress)` lines mirror each main-window mark as it happens,
  with a heartbeat each second until ready (heartbeat: `Retire-when: #936
  closed`). How to read them:
  - Heartbeats continue after the last mark: the page is alive but waiting,
    most likely on an IPC response.
  - Heartbeats stop: the page hung or died.
  - `app-ready` arrived but `ui-ready` did not: frame scheduling stalled.
- A timed-out sample leaves `sample-NN-stall/` next to its log. It holds
  `processes.txt`, a 3 s `sample` (or `sudo -n spindump` fallback) of the app
  and this sample's WebContent processes, 60 s of WebKit unified log, new
  DiagnosticReports, and `evidence.json` recording each capture's outcome.

Keep evidence capture bounded, and keep the timeout first in the message. A
capture that fails or hangs adds a clause; it never replaces the reason the
sample failed (ADR 0021).
