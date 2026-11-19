# Clipboard rules

File clipboard writes are accepted by the process-wide Rust worker. Publish
its revision invalidation from the accepted native job too: the originating
renderer can close before its IPC response and otherwise leave surviving
windows with stale clipboard state. Controlled ordering tests belong around
`spawn_worker`'s backend, not only a serialized frontend mock. Native hook builds
can hold a write with a hidden `.<filename>.clipboard-hold` sidecar (30-second
failure guard); `.queued` and `.started` sidecars acknowledge native progress.

Clipboard routing and availability share `clipboard/content.rs`; test mixed
image/file clipboard owners. Report attachments read copied files through it
(ordered file snapshot, one copied video file, image-data fallback): see
`website/api/CLAUDE.md`. Native Windows clipboard probes: `e2e-tauri/CLAUDE.md`.
