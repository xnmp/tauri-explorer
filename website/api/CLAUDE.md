# Report relay rules

The relay is deployed independently of the app; deploy it alongside app changes that depend on it.
The attachment rules below span the app too: `UserReportDialog.svelte`,
`state/user-report-draft.svelte.ts`, `src-tauri/src/user_report*.rs` and
`src-tauri/src/clipboard/content.rs`.

## Attachments (ADR 0029)

User-report images and videos are hosted as public Vercel Blobs before the relay creates
the GitHub issue. Production therefore needs `BLOB_READ_WRITE_TOKEN` as well
as `GITHUB_ISSUE_TOKEN`. Keep the raw attachment total at or below 3 MiB so
its base64 JSON request stays below Vercel's 4.5 MB function-body limit.
Video reports support MP4/WebM/MOV within the existing 2 MiB/file cap. Clipboard
attachments use the ordered file snapshot and require one copied video file;
retain image-data fallback for non-video paths and failed file-list discovery,
preserving image validation/read errors. Clipboard routing and availability
share `clipboard/content.rs`; test mixed image/file clipboard owners. Check container
signatures in frontend draft admission, native submission and the relay, and
deploy the relay alongside the app. ADR 0029 governs copied-file authority,
bounded reads, signature limits, public disclosure and upload cleanup/uncertainty.
See `docs/lessons/1059-report-video-attachments.md`.
A deployed image-only relay can still reject videos accepted by the app (#1170).
Preserve the native/relay error message in attachment-failure feedback; the
error kind alone hides deployment and size-limit failures. A GET/405 health
check does not prove video support: use the deliberately invalid second
attachment probe in `docs/lessons/1170-report-relay-video-deployment.md`.

## Tokens and spam counters

The public report relay under `website/api/` uses `GITHUB_ISSUE_TOKEN` only for issue creation. Production spam counters must use the shared REST KV variables `KV_REST_API_URL` and `KV_REST_API_TOKEN`; when Vercel is detected without them the endpoint fails closed. The in-memory counter is intentionally limited to local development and unit tests.

## Root test harness

The root Vitest suite imports the report relay from `website/`; keep its
`@vercel/blob` runtime and compatible Undici major in the root test-harness
dev dependencies as well as the independently deployed website package.
