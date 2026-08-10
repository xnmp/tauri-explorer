# Video preview frame (#607)

The preview pane does not use tile thumbnail components. To show a video in the
large pane, call `getVideoThumbnailData` directly and pass its extracted frame
through the pane's existing image decode, fullscreen, and stale-result flow.

When a file watcher refreshes a selected video in place, its path is unchanged.
Guard asynchronous frame results with the path, modification time, and size
preview key rather than the path alone.
