# ADR 0030: Frontend crash recording and the config-change event contract

Status: Accepted

Governs: `src/lib/api/crash.ts`, `src/lib/state/config-watch.ts`

## Context

The next-launch notice ("Tauri Explorer crashed last time") offers the newest
unseen crash file. Both Rust panics and webview failures write those files. In
#1056, every launch showed the notice, although nothing had stopped. After the
startup image-connection migration, the backend emitted `config-file-changed`
with a bare string payload. The listener read `payload.filename`, threw
`undefined.startsWith` inside an async handler, and the global
`unhandledrejection` handler recorded that as a crash.

Two policies were implicit and both failed. First, nothing defined what counts
as a crash. Second, nothing defined what shape an event payload crossing IPC
must have, or what a listener does when the payload is wrong.

## Decision

**Crash files are for failures that stop or corrupt the app.** A Rust panic
(panic hook) and an uncaught webview `error` event are recorded as crash files
and offered on the next launch. An unhandled promise rejection is mirrored into
the rotating backend logs (`log_frontend_error`) and is never recorded as a
crash: the app keeps running, so the notice would be false. Rejections remain
diagnosable from the logs.

**`config-file-changed` carries `{ filename: string }`.** The `filename` is
config-dir-relative and forward-slashed (`settings.json`,
`themes/<name>.css`). Every backend emitter goes through
`config_watch::emit_config_file_changed`, which serialises the typed
`ConfigChangedPayload` and logs emit failures instead of dropping them. No call
site writes the event name or builds the payload by hand. The watcher's own
lifecycle stays under ADR 0004.

**Listeners validate IPC payloads before use.** A payload without a string
`filename` is ignored with a `console.warn`. It never reaches
`handleConfigFileChanged`, so a contract violation cannot become an exception
or a rejection. A malformed event can no longer be a crash (see above), so
without this guard it would leave only a log line.

## Consequences

- A rejection-only bug no longer produces a user-visible crash notice. It is
  found from the logs or from tests, not from user reports.
- Adding a new `config-file-changed` emitter means calling the typed helper;
  a hand-built payload is a review defect.
- Tests: `tests/api/crash-handlers.test.ts` (rejection logged, not recorded;
  `error` still recorded), `tests/state/config-watch-payload.test.ts` (bare
  string ignored, object payload reloads), the `config_watch` Rust test (the
  helper emits `{"filename": …}`), and `e2e/crash-notice-rejection.spec.ts`
  (the next launch after a rejection shows no notice).
