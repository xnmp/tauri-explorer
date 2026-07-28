# Preview and navigation diagnostics

Preview loading and directory navigation cross separate frontend and native IPC
boundaries. Log failures at both sides with the requested path, operation,
error, and elapsed time: frontend asset decoding failures only exist in the
webview, while filesystem and streaming failures need the native rolling log.
For streamed directories, record the listing ID and whether a stream ended by
cancellation so an expected supersession is distinguishable from a dropped
navigation.
