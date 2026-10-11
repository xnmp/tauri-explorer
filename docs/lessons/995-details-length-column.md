# #995 — Details Length column

- Video durations are lazy per-row metadata, not listing fields. `FileItem`
  requests them from `state/media-durations.svelte.ts` while the Length column
  is visible; the resolver batches same-tick requests into one
  `get_media_durations` call and caches per path + size/mtime revision, so a
  rewritten file is re-probed and an unchanged one never is.
- `mediaTime` renders invalid input as `0:00`; never use it directly for a cell
  that must be empty when the duration is unknown — use `formatMediaDuration`.
- MP4 encoders without faststart put `moov` after `mdat`; the native parser
  seeks box-to-box rather than reading the file. Fragmented MP4 can carry a zero
  `mvhd` duration, which falls back to ffmpeg.
- `FileList` treats every non-entry right-click as a background click. Any
  in-list surface with its own context menu (the Details column headers) must
  `stopPropagation`, or the folder menu opens on top of it.
- Mock fixture names in `/home/user/Videos` affect other specs: the first sorted
  entry is auto-selected and previewed, so new fixtures must sort after
  `recording.mp4`.
