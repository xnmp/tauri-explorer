# ADR 0028: Report attachment admission and public hosting

Status: Accepted

Governs: `src-tauri/src/user_report.rs`, `src-tauri/src/clipboard/mod.rs`, `src-tauri/src/clipboard/content.rs`, `src/lib/domain/user-report.ts`, `src/lib/state/user-report-draft.svelte.ts`, `src/lib/components/UserReportDialog.svelte`, `website/api/_report-core.js`, `website/api/report.js`

## Context

Report Issue accepts images and short videos from a file picker or the
clipboard. Copied videos cross a local-file read boundary; submission crosses
a separate public-hosting boundary before the relay creates a GitHub issue.
Clipboard contents, filenames, declared media types and submitted bytes are
untrusted. A supported extension or signature does not establish that a file
is safe or even fully decodable.

## Decision

### Copied-file authority and bounded reads

- The user's Attach from clipboard action reads the current native ordered
  file snapshot. The report clipboard command accepts no caller-supplied path.
  Merely opening the dialog or detecting a video does not attach or upload it;
  availability checks do not read the copied video's file bytes.
- Read exactly one copied MP4, WebM or MOV file. Reject multiple copied paths
  with the copy-one-file message and reject directories/non-regular paths.
  Use only the selected path, without directory traversal or discovery of
  neighboring files. Normal filesystem resolution can follow a copied symlink
  to a regular file; this is not a symlink-denying filesystem sandbox.
- A supported copied-video extension takes precedence over image data from
  that clipboard owner. Otherwise use its PNG/JPEG image data, including when
  file-list discovery fails. Non-video paths without image data do not enable
  attachment. Keep the routing and availability decisions shared and tested.
- The file metadata rejects a video over 2 MiB before reading. The stream
  consumes at most 2 MiB plus one byte and rejects that extra byte, so growth
  after the metadata check cannot admit an oversized attachment. The report
  accepts at most three attachments, 2 MiB each and 3 MiB in total. These raw
  limits leave room for base64 JSON under the relay's 4.5 MB request ceiling.

### Admission and signature-validation limits

- Accept PNG/JPEG/GIF images and MP4/WebM/MOV videos. Frontend draft admission,
  native submission and the public relay independently enforce the media
  allowlist, nonempty canonical base64 data and count/byte bounds,
  and agreement between the declared type and the byte signature. The relay
  must not trust validation performed by the application.
- Native submission and the relay additionally validate attachment names,
  including nonempty trimmed names and a 120 UTF-16-unit limit. Frontend draft
  admission does not validate filenames; those checks happen at the native
  submission and relay boundaries.
- PNG/JPEG/GIF admission checks their prefixes. WebM admission checks the EBML
  prefix; it does not parse the document type or prove that the payload is
  WebM. MP4/MOV admission requires a leading `ftyp` box whose declared length
  is at least 16 bytes and fits the payload, with an allowed MP4 major brand
  or the QuickTime `qt  ` brand respectively. These checks filter container
  signatures, not codecs, duration, complete media structure or malicious
  content. They are not decoding, transcoding or malware scanning.
- Keep the three validators aligned through the shared media-signature cases
  in `tests/contract/fixtures/report_relay.json`. Videos show a filename and
  placeholder in the report dialog rather than being decoded there.

### Public-upload disclosure and publication

- Before Submit, the dialog states that the issue, report text/contact details,
  app/OS information and attachments will be public, and that attachments use
  public hosting. Attaching media only changes the local draft; submission is
  the action that sends it to the relay. Binary attachments stay in window
  memory rather than persisted report text storage.
- The relay validates and applies spam limits before uploading. Its Blob
  adapter uses public access, a sanitized filename with a random suffix, and
  an extension/content type derived from the validated media type. The native
  clipboard attachment carries a basename, not its local absolute path.
- Upload all attachments before attempting issue creation. The issue embeds
  images and links videos under Attachments; filenames are escaped for their
  Markdown label. `BLOB_READ_WRITE_TOKEN` authorizes Blob operations and
  `GITHUB_ISSUE_TOKEN` authorizes issue creation; neither is supplied by the
  reporting application. Deploy the relay's video support with the app.

### Failure, uncertainty and cleanup

- Missing hosting configuration fails the attachment submission. An upload
  failure or definite issue rejection triggers best-effort deletion of the
  Blob URLs already returned for that request. Cleanup failure is logged and
  must not replace the original submission error. Cleanup cannot guarantee
  removal of an upload for which no URL was returned.
- After the GitHub POST may have started, a lost response, server timeout/error
  or malformed success response cannot prove that no issue was created.
  Report `submission_uncertain` and retain the hosted URLs so a possibly
  created issue keeps working links. Do not automatically retry or open the
  fallback issue composer for that result; tell the user to check recent issues.
- Other submission failures preserve the attachment draft for retry until
  the window closes. A GitHub fallback carries report text and asks the user
  to add attachments manually; it does not transfer local binary attachments.
  Successful submission clears only the still-current draft, preserving edits
  made while an earlier submission was in flight.

## Consequences and verification

This remains a small-attachment report channel, not a general video upload
service. Public disclosure and best-effort cleanup do not make uploads private,
and signature admission must never be described as proof of media safety.
Changes to governed paths must preserve these boundaries and cite this ADR.

Verify the real native bounded-file reader and mixed file/image clipboard
routing with temporary-file and injected-reader tests. Exercise all three
validators against the shared fixtures, including mismatched signatures and
limits. Relay tests must assert upload MIME/extension, image embeds/video links,
partial-upload and definite-rejection cleanup, retention on uncertain issue
creation, and preservation of the original error if cleanup fails. Browser
tests verify the attachment state, disclosure, retry and fallback UI; they do
not substitute for native file-read or relay contract tests.
