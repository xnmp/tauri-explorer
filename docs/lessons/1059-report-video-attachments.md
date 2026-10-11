Report Issue supports PNG/JPEG/GIF images and MP4/WebM/MOV videos. The raw
attachment caps remain 3 files, 2 MiB per file, and 3 MiB total; base64 JSON
must still fit Vercel's 4.5 MB request ceiling. This deliberately supports
short clips rather than a new recording upload service.

Clipboard video reads use the existing ordered file-clipboard snapshot, then
read one regular file with a bounded `take(MAX_ATTACHMENT_BYTES + 1)`. Copying
multiple files produces an explicit copy-one-file message. A copied video file
takes precedence over a thumbnail image offered by the same clipboard owner.
Non-video paths fall back to offered image data, so a PNG URI does not hide a
screenshot. Unsupported paths without image data do not enable attachment.
File-list discovery failures also fall back to images and preserve the image
read error. Keep routing and availability in the shared `clipboard/content.rs`
seam; test both rather than only testing the copied-file reader.

Frontend draft admission, Rust submission and the relay all check signatures:
PNG/JPEG/GIF prefixes, the WebM EBML prefix, and a bounded leading `ftyp` box
with MP4 or QuickTime brands. These are container signature checks, not a full
media decode. The `mediaCases` in `tests/contract/fixtures/report_relay.json`
are asserted by frontend, native and relay tests to keep all three in sync. Video previews deliberately use a
placeholder so they do not decode untrusted attachments in the dialog.

The relay retains image embeds and renders videos as Markdown links. Blob
uploads use the declared validated content type and an extension matching it.
Deploy the website relay along with the app; an older image-only relay rejects
videos, and the app retains attachments for retry/fallback until the window
closes. Attachments remain memory-only; only report text survives app restart.

[ADR 0028](../adr/0028-report-attachment-admission-and-hosting.md) governs the
copied-file and public-hosting boundaries, including signature-check limits,
disclosure, submission uncertainty and best-effort cleanup.
