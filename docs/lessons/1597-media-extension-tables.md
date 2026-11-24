# Media extension tables disagreed (#1597)

`domain/file-types.ts` had separate tables for type labels, icon colours, icon
categories and media thumbnails. `.webm`, `.m4v`, `.m4a`, `.opus` and other
extensions got an ffmpeg thumbnail but showed the generic grey icon and an
"EXT File" label. The thumbnail sets (`VIDEO_THUMBNAIL_EXTENSIONS`,
`AUDIO_THUMBNAIL_EXTENSIONS`) are now the fallback for all three lookups. Add
a new media extension to those sets, not only to one lookup table.
`tests/domain/file-types.test.ts` checks that the tables agree.
