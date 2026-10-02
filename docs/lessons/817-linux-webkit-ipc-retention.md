# #817: Linux child-window churn retained WebKit views

The four-hour native qualification repeatedly failed near the 399th child
window close. In a WebDriver-free X11 replay, 399 distinct child XIDs were
destroyed, but the main view became blank and unresponsive while the Rust
process stayed alive. The app held 401 `WebKitSharedMemory` descriptors; the
count had grown by one after nearly every child close. This was a native
renderer lifetime failure, not just a WebDriver session failure.

Wry 0.55.1's GTK IPC setup connected a signal handler to the WebView's
`UserContentManager` and captured that same WebView strongly. That makes a
GObject ownership cycle: WebView → manager → signal closure → WebView. A
minimal custom-scheme GTK control released each child's shared-memory
descriptor over 450 open/destroy cycles. Adding the same strong callback
capture to a matched control reproduced the app's +1-descriptor-per-close
signature; omitting it kept the count flat.

The local Wry patch changes the IPC callback capture to `WeakRef<WebView>`.
The handler upgrades it when an IPC message arrives, preserving live requests
while allowing a destroyed view and its manager to be reclaimed. With that
patch, a native app replay destroyed 450 child XIDs, held two shared-memory
descriptors through cycle 450, and completed a new backend listing via Ctrl+T
afterward (listing completions 901→902). The 450-cycle replay is diagnostic;
it does not replace the required four-hour, four-scenario qualification.

The Linux soak now records the app root's shared-memory descriptor count and
checks settled early/late medians, with samples spanning the run. A sustained
increase beyond 16 fails qualification before the old failure boundary. Keep
the weak capture until upstream Wry ships an equivalent fix, then remove the
vendor patch only after repeating native churn and the full soak.

The long-running WebdriverIO worker has a separate memory risk. In installed
`@wdio/logger` 9.18.0, unique messages accumulate in an in-memory `Set`
until file logging is enabled. The soak emits many WebDriver messages, and its
config originally had no `outputDir`. A 10,000-message probe retained about
6 MiB of heap without a log path and about 0.1 MiB with one. Give each seeded
soak a worker-log directory under `qualification-results/`, and include that
directory in a failed report's artifacts. This is harness memory hygiene; it
does not establish the cause of the earlier WebKit renderer abort.
