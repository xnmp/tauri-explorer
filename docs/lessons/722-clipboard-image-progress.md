# Clipboard-image paste must own its progress lifetime (#722)

Normal Paste and Paste Image previously awaited clipboard inspection/read and
the image write without visible pending feedback. Both now capture the target
directory and enter the same image-paste lifecycle before inspection. Pending
entries live until their operation settles; unrelated toasts and overlapping
pastes cannot dismiss them. The existing progress chrome appears immediately,
with an indeterminate bar because clipboard IPC does not report byte progress.

Keep clipboard inspection failures distinct from an empty clipboard. The
checked platform methods propagate probe, read and encode errors; the report
attachment's optional clipboard read remains best effort. Completion refreshes
the captured destination without navigating a pane that has moved elsewhere.

A timestamp plus an existence check was not enough to avoid overwriting a third
same-clock paste. Validate PNG data before writing, stage in the destination,
and publish with no-clobber semantics while trying bounded distinct names.
Malformed data and write failures leave no published image or temporary file.

Regression controls failed before the fix for missing progress, a same-clock
overwrite and publication of corrupt PNG data. Final Linux native verification
uses a separate Xvfb/Openbox display, D-Bus session and XDG profile. An external
clipboard owner supplies a 2048×1536 PNG; both shortcuts in all three views
produce the expected decoded pixels and dimensions, replace an earlier copied
file, and show progress before the file appears. Navigation and a permission
refusal verify captured destinations and cleanup. The hook-only two-second
hold makes progress observable and is not a throughput measurement.

All fourteen Linux screenshots were inspected independently. Actual Windows
clipboard execution remains unverified; portable native tests include decoded
pixel assertions, but Linux and browser mocks cannot satisfy that criterion.
