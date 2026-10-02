# 732 — Linux terminal paste denied by WebKit's Clipboard API

The terminal's Ctrl+V handler reached xterm, but its only source was
`navigator.clipboard.readText()`. In a packaged WebKitGTK session that call
rejected with `NotAllowedError`, even though the X11 clipboard contained the
command. The handler swallowed the rejection, so Paste appeared to do nothing.

Linux terminal paste now reads text through the Tauri clipboard command first
(`xclip` on X11, `wl-paste` on Wayland), with the browser API as a fallback if
the native tool is unavailable. Windows/macOS keep the browser path first and
use native text reads after a permission failure. Errors surface as a toast if
both paths fail.

An asynchronous read also reserves its position in the terminal input stream.
Later Enter/typing waits until xterm emits the paste bytes, including any
bracketed-paste markers. Restart/disposal drops unresolved paste requests.
The Linux DEB/RPM and Arch package recipes include the X11 and Wayland
clipboard utilities; AppImage users need the relevant host utility installed.

The native regression sets the clipboard from outside the app, presses Ctrl+V
in the real terminal, and asserts that the pasted shell command executes. It
failed before the fix and passed afterward; the full Linux terminal spec passed
7/7 under an isolated Xvfb display and fresh settings profile. The screenshot
shows the echoed command and its output. When reproducing from a Wayland
desktop, unset `WAYLAND_DISPLAY` for the Xvfb child; otherwise the app may read
the host clipboard while the test writes to X11, producing misleading results.
