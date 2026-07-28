# Preview and navigation diagnostics

Preview loading and directory navigation cross separate frontend and native IPC
boundaries. Log failures at both sides with the requested path, operation,
error, and elapsed time. Frontend-only failures must also be forwarded through
`log_frontend_error` so they reach the native rolling log instead of being
limited to webview devtools. Navigation request/outcome events use `info!`,
the default application log level, while high-volume detail remains `debug!`.
For streamed directories, record the listing ID and whether a stream ended by
cancellation so an expected supersession is distinguishable from a dropped
navigation.
