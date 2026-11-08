# Queued plugin installs wait for ownership, not for startup

`~/.config/tauri-explorer/pending-plugins/*.teplugin` requests are applied by
one `plugin-install-queue` worker. Before #1528 `installed_plugins::initialize`
spawned it only at startup and only when its own `bootstrap_services()` call
succeeded. When the previous instance still held the profile lease
(`.plugin-runtime.lock`), startup bootstrap was refused; the process later
acquired ownership through `ensure_services` (an explicit service action) or
`retry_services` (the opportunistic read-path retry), but neither path looked
at the queue. The requests sat there until the *next* launch, which may again
start while an older instance is still exiting.

Rule: work that requires profile ownership is attached to the ownership
**transition**, not to a particular entry point. `bootstrap_services()` is the
single place every path reaches ownership (under the mutation gate); it records
whether the process was already ready and, on the first not-ready → ready
transition, calls `start_pending_queue()`. Startup, explicit actions and
retries therefore all apply the queue, and only once.

`queue::publish_worker` is the single-worker guard. It now refuses to publish
while a previously published worker is still running (two workers would race
on the same queue entries and on the `failed/` quarantine), and reaps a
finished worker before replacing it so its handle is never dropped unjoined.
Shutdown still joins the slot outside the mutation gate.

The worker needs an `AppHandle` to emit `plugins:changed` when it is started
from a retry, so it reads the handle `backend::initialize` already stores
(`backend::app()`), rather than capturing the one passed to `initialize`.

Evidence: `startup_native_tests::native_queued_installs_apply_when_ownership_is_acquired_after_startup`
holds the lease, initializes (no worker, queue untouched), releases it, runs
`retry_services`, and asserts the queued package is installed, serves, and is
removed from the queue, with exactly one worker started across later
`ensure_services`/`bootstrap_services` calls. It fails on the pre-fix commit
(the request is never consumed). `queue::tests::a_running_worker_is_never_joined_by_a_second_one`
covers the guard without a display.
