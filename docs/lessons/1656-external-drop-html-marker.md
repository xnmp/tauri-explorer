# #1656: external apps pasted the drag session URN

Dragging a picture from the file list into Obsidian inserted
`urn:tauri-explorer:drag:<session>` instead of the image.

## Cause

Every HTML5 file drag sets `text/html` to a session marker
(`html5DragHtml`, `domain/file-drop.ts`). WebKitGTK owns the GTK drag source
and offers that flavour to every receiver. Obsidian's editor drop converts
`text/html` to Markdown *before* looking at `dataTransfer.files`, so it pasted
the marker. A Chromium receiver saw `types: [text/html, Files]`, with the
WebKit-serialized `<span style=…>urn:…</span>`.

## Fix

`linux_html5::source_data` already reads the marker in its AFTER
`drag-data-get` handler to bind the GTK context to the session. It now replaces
the `text/html` payload with an empty fragment once the session has been read
(`consume_source_html`). Chromium/Obsidian treat empty HTML as absent and
import the files.

## Constraints that ruled out alternatives

- Removing the marker in JS does not work: WebKit then synthesizes
  `<a href="file://…">file://…</a>` (Obsidian makes a Markdown link, not an
  attachment), and Linux in-app moves stop working because the native source
  never binds its session.
- An empty element carrying the marker in an attribute is discarded by
  WebKit's markup sanitizer, with the same result. The marker must stay
  visible text inside WebKit.
- The app's own drop targets are unaffected: the receiving WebKit reads its
  same-origin `org.webkitgtk.WebKit.custom-pasteboard-data` target, and native
  routing uses the bound session.

## Reproducing without touching the desktop

Run Xvfb, the app (`GDK_BACKEND=x11`, private `XDG_*` dirs, under
`dbus-run-session` so single-instance does not forward to a running copy),
and Obsidian (`--user-data-dir=<tmp> --ozone-platform=x11`, with an
`obsidian.json` that opens a throwaway vault). Drive the drag with XTest
(`python-xlib`: press, ~40 motion steps, release) and read the note file. A
Chrome page that writes `dataTransfer` types/data/files into `document.title`,
read through `--remote-debugging-port`, shows exactly which flavours a
Chromium receiver sees.

macOS (WKWebView) and Windows (WebView2) also export `text/html`, but nothing
there has been checked against an external receiver.
