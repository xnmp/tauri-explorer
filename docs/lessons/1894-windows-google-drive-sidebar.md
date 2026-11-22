# #1894: Google Drive missing from the Windows sidebar

#731 asked to remove an unwanted Google Drive row on Linux (a GVfs/rclone
shortcut). The fix filtered every `provider: "googledrive"` drive out of
`sidebarCloudDrives`, but the Windows backend (`files/drives.rs`) reports
Google Drive for desktop's drive letter with that same provider in the Cloud
kind. Cloud drives render only in the Cloud & Remote section, so on Windows
Google Drive disappeared from the sidebar altogether.

A presentation filter keyed on a cross-platform provider applies to every
platform that emits it. Scope such omissions to the platform the request came
from: `sidebarCloudDrives(drives, windowsHost)` keeps Google Drive on Windows
and still omits it on Linux. `tests/domain/drives.test.ts` and
`tests/state/drives-windows-google.test.ts` (platform mocked to Windows) fail
with the unscoped filter.
