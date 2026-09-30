# Tauri Explorer alpha testing

Thanks for helping test Tauri Explorer. Use the exact release and platform
listed in your invitation; the [latest release page](https://github.com/xnmp/tauri-explorer/releases/latest)
is the supported download route. The first cohort is intentionally small, and
an invitation does not imply that every operating system or desktop environment
has been qualified.

## Before you start

Use a copied or disposable folder for your first sessions. Keep an independent
backup of files you care about. Try navigation, selection, copy, move, rename,
Trash and restore on those test files before using the app on everyday data.
Do not enable the optional Linux system file-picker integration during the
first session. Install on the OS, CPU architecture, desktop environment, and
display scale named in your invitation; tell us if yours differs.
For Linux AppImage, install `xclip` on X11 or `wl-clipboard` on Wayland so
file Copy/Paste and terminal Paste can use the desktop clipboard.
File Cut verifies native clipboard ownership on X11, Wayland, Windows, and
macOS. If another program changes the clipboard between Cut and Paste, Paste
copies instead of moving. When ownership cannot be proven, Cut refuses the
action; use Copy there.

The current downloadable builds are unsigned. Windows may show a SmartScreen
warning. The macOS DMG is Apple Silicon only and is not notarized; the
[README](../README.md#install) has the quarantine instruction and a source-build
route for Intel Macs. If you are uncomfortable bypassing an OS warning, wait
for signed builds. There is no automatic updater: check the release page for
new versions and install them manually.

## When something goes wrong

Use Command Palette → **Report Issue**, or [open a GitHub issue](https://github.com/xnmp/tauri-explorer/issues/new/choose).
Include the app version, OS/desktop environment, display scale, exact steps,
expected and actual result, and whether the test files on disk changed. The
in-app form includes version and OS information and accepts optional images.
Submitted text, contact details, and images become public. Remove private
paths, names, account details, and screenshots before submitting. Local logs
are not attached automatically. The report service uses a hashed source-IP
value for short-lived rate-limit counters, separate from the public issue.
For a suspected security vulnerability, use
the [private reporting route](../SECURITY.md) instead.
If submission fails, the text draft survives an app restart; attached images
remain available for retry only until that app window closes.

**Stop file-changing operations immediately** if a command affects a file
other than the one you selected, loses data, or leaves copy/move results
uncertain. Preserve the original test folder and any local logs, report the
steps, and wait for a fix before continuing with mutations. The maintainer
will state the review cadence in your invitation; data-loss and wrong-target
reports take priority over feature requests.

## Updating, leaving, or rolling back

Keep the installer or AppImage you used and note its version. To update, get
the next build from the release page and use the normal installer for your
platform. If an update regresses, stop mutating files and report it before
reinstalling an earlier build; back up both your files and app settings first,
because settings are not guaranteed to migrate backwards. You can uninstall
through Windows Installed apps, the Linux package manager, by deleting the
AppImage, or by removing the macOS app. Uninstalling the app does not delete
the files you managed with it.

Your invitation states the platform configuration qualified for your cohort.
Linux desktop environments and display scales outside that configuration,
Windows window transfer, and macOS shell integration require separate
qualification before invitations cover them.
