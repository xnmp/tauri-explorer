# Video reports and relay deployment (#1170)

The reported v1.11.6 screenshot shows the optimistic submission-failure toast,
not file-picker admission. The application already gained MP4/WebM/MOV support
in PR #1074. On investigation, the production relay still rejected a valid MP4
container signature with `malformed_input: Attachment type is invalid`. The
checked-in relay accepts that video. Updating the app alone cannot fix the
independently deployed image-only relay.

The native HTTP boundary preserves the relay message, but the dialog used only
its error kind and replaced the reason with “One of your attached images or
videos is not valid.” Pass the message through to the existing plain-text toast
while retaining draft/retry guidance. Keep relay size failures explicit too:
2 MiB maximum, with a suggestion to shorten or reduce recording quality.

## Probe without creating an issue or uploading anything

Send a valid video signature followed by an invalid attachment name. Validation
of the whole request precedes rate limits, uploads and issue creation. Both old
and current relays must reject the request, so it cannot create a test issue or
publish media. Do not remove the deliberately invalid second attachment.

```sh
curl --silent --show-error --max-time 30 \
  -H 'Content-Type: application/json' \
  --data '{"title":"Validation only, never create","body":"Invalid second attachment must prevent all publication","kind":"bug","attachments":[{"name":"clip.mp4","mediaType":"video/mp4","data":"AAAAGGZ0eXBpc29tAAAAAGlzb21tcDQy"},{"name":"","mediaType":"image/png","data":"iVBORw0KGgo="}]}' \
  https://tauri-explorer.vercel.app/api/report
```

An image-only deployment returns `Attachment type is invalid` for the first
attachment. A video-aware deployment reaches the second attachment and returns
`attachment name is invalid`. A GET returning 405 proves route availability
only; a honeypot request bypasses validation and cannot prove video admission.

## Rollout and remaining production verification

Redeploy `website/` to the existing production Vercel project with its existing
Blob, GitHub and shared KV configuration. Run the probe again, then exercise a
controlled real short clip and inspect its public issue link. Unit/browser tests
with injected upload/GitHub adapters do not prove production deployment, hosting
configuration or live playback. Deployment credentials were unavailable during
this investigation, so production recovery remains an external prerequisite.

[ADR 0029](../adr/0029-report-attachment-admission-and-hosting.md) still governs
admission, public hosting, bounded sizes and uncertain submission handling.
