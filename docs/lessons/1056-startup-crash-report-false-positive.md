# 1056: "crashed last time" on every launch

- The backend emitted `config-file-changed` with a bare string payload after the
  image-connection migration; the listener reads `payload.filename`, so it threw
  `undefined.startsWith` on every launch. Every `config-file-changed` payload now
  goes through `config_watch::config_changed_payload`.
- That throw was an unhandled rejection, and rejections were recorded as crash
  files, so the next launch claimed a crash. The app never stopped. Rejections are
  now only logged (`log_frontend_error`); crash files are for Rust panics and
  uncaught `error` events.
- Diagnosing: `<app log dir>/crashes/*.seen` keeps consumed reports. Map the
  `file:line:col` frames onto a local `bun run build` of the same version — the
  chunk hash matches, so the columns land on the exact expression.
