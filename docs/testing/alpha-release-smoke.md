# Alpha release-asset smoke

Run this on the actual OS, desktop environment, and display scale admitted for
each tester cohort. A debug binary, a local package, or a virtual display does
not replace this check. Use a fresh app profile and only disposable files.
Keep the completed record with the release decision.

## Identify the exact asset

1. Record the release tag, target commit, asset filename, GitHub-reported
   SHA-256 digest, local `sha256sum`/`shasum -a 256`, OS, CPU architecture,
   distro/version, desktop environment, session protocol, display scale, and
   installer type. Require the two digests to match. Download from the public
   release page, not a CI artifact or local build directory.
2. Install the downloaded asset by its documented route. Launch it from the
   installed entry point with a fresh app profile. Record the version displayed
   by the app and confirm the file list becomes usable without a development
   server. For AppImage, launch the downloaded file itself. Do not count an
   extracted `.AppDir` or the bare compiled binary.

Before sharing an install link, check the public website separately. Download
its `/` and `/app.js` responses and compare their bytes with `website/index.html`
and `website/app.js` from the release commit. A successful redeploy must not
serve the old `b21a59cf` snapshot. A read-only GET to `/api/report` must reach
the function and return 405 with `Allow: POST` and a `method_not_allowed` JSON
body; Vercel's plain-text `NOT_FOUND` 404 means the report path is absent.
Exercise the deployed download control with a failed GitHub API lookup and
confirm it opens the releases page. Record the deployment URL or identifier,
response status, and source commit alongside the installer hash.

## Exercise outcomes on disk

Prepare two disposable folders with distinct text files and note each file's
bytes. In the installed app:

- Navigate to each folder by the address bar and by a normal file-list action;
  Enter on a complete path must enter that path, not its first child (#711).
- Create and rename a file/folder. Copy a file, paste it, and compare both the
  displayed listing and all resulting on-disk bytes. Move a file between the
  folders and confirm its original path is gone and the destination bytes match.
- On a cohort where Cut is enabled, Cut a disposable file, replace the system
  clipboard with an external **Copy of that same path**, then Paste. The source
  must remain and a new copy must appear (#835). Also verify an ordinary Cut
  moves exactly the selected file. On a platform where Cut is unavailable,
  verify it refuses the action visibly and Copy still works.
- Move a disposable file to Trash, verify it leaves the source, open the
  sidebar's Recycle Bin/Trash action, and restore that exact file. Check its
  original path and bytes. On Linux, the sidebar action must open the file
  manager's native `trash:///` view with Restore available, not a terminal or
  an ordinary `Trash/files` directory (#723/#733/#757).
- If terminal is included in the cohort, paste a known command from the
  desktop clipboard, press Enter immediately, and verify the command's actual
  output. Repeat with a second paste or typed suffix to catch input reordering
  (#732). On macOS, restart an embedded zsh session and verify history reaches
  the configured `HISTFILE` (#784).
- If scaled displays are included, repeat marquee selection in Details, List,
  and Tiles at every admitted monitor scale. The highlighted rectangle and
  final selected filenames must match the dragged rows (#756).

For any wrong-target mutation, uncertain copy/move result, or data loss, stop
mutating files and fail the cohort gate. Preserve the disposable folder and
diagnostics without exposing personal data.

## Verify feedback and exit

Submit a controlled text report and one synthetic image from the installed
app, without `gh` or `gh-image` configured. Inspect the created public GitHub
issue and hosted image for expected content and unintended personal data. Test
a definite rejection and an ambiguous response in separate runs using a
controlled local relay URL (`TAURI_EXPLORER_REPORT_URL`; loopback `http://` or
`https://` only, see SECURITY.md), not by sending
duplicate reports to production: the text draft must survive, and ambiguity
must not prompt a duplicate issue. Record the live issue URL, then close the
controlled test issue. Do not use a real user's data.

Follow the [tester guide](../alpha-testing.md) to update and uninstall the
asset, confirming that the disposable managed files remain. Document any
installer warning and the exact rollback route. A passing application smoke
does not qualify a stale website download link or undeployed report relay;
check those public routes separately.

## Record template

| Field | Result |
| --- | --- |
| Release tag / commit / asset | |
| GitHub digest / local digest | |
| OS / architecture / distro / desktop / X11 or Wayland / scale | |
| Fresh-profile install and launch | pass/fail + evidence |
| Navigate / create / rename / copy / move / Cut ownership | pass/fail + evidence |
| Trash open and exact restore | pass/fail + evidence |
| Terminal paste / zsh history / scaled marquee, if admitted | pass/fail + evidence |
| Controlled report issue and image URL | pass/fail + evidence |
| Update / uninstall / rollback | pass/fail + evidence |
| Known limits disclosed / tester guide published | pass/fail + links |
| Decision and reviewer | admit / hold + date |
