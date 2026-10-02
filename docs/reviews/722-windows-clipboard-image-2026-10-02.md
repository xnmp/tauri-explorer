# Windows clipboard-image acceptance (#722)

The real Windows native app passed seven clipboard-image cases in
[CI run 36940530617, Windows job 110630942870](https://github.com/xnmp/tauri-explorer/actions/runs/36940530617/job/110630942870).
The app ran on the disposable hosted `windows-latest` desktop through
WebView2 153.0.4234.48. The tested merge commit was
`8d80ab955197516cf7724a1e22a62e2c376dc663`, combining PR head
`c576d2eaee150e7268e73ac7b251a62cda8b2801` with dev
`b9b1da0952e6d4a4a60556c66803509a5bcc7194`.

An external PowerShell STA process loads a recognizable 2048×1536 PNG into
`System.Windows.Forms.Clipboard` as an image. Explorer reads that real OS
clipboard. The fixture does not replace clipboard IPC with a mock.

Normal Paste and explicit Paste Image passed in Details, List and Tiles.
Each case asserts visible indeterminate progress and the captured destination
before any output exists, waits for settlement, checks that the previous file
remains unchanged, decodes the saved PNG, and checks its dimensions and exact
RGBA values at four quadrant-centre sample points. The actual preview also
decodes at the expected dimensions. These checks do not compare every pixel.
The seventh case navigates while pending and verifies publication only in the
original directory, with the new directory still active and usable.

The hook-only two-second hold makes pending work observable; it is not a
throughput measurement. Thirteen screenshots cover the six pending/completed
pairs and navigation. The permission-refused-write case is Linux-only and was
explicitly skipped on Windows; its real filesystem/error proof remains the
existing Linux capture. Empty/non-image, read/encode/write errors and collision
contracts also have focused production tests.

The [receipt directory](722-windows-clipboard-image-2026-10-02/) contains the
native spec summary, exact commit provenance and SHA-256 hashes of all thirteen
Windows screenshots. Screenshots are in
`screenshots/fix/722-progress-bar-when-copying-images/*-win32.png`; three
representative images are also in `evidence/722/`.
