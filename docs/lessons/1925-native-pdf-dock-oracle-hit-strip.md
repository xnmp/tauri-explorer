# #1925 — macOS Native UI failed after the unified resize handle

**Symptom.** Every macOS Native UI run from a86d38f3 on failed with "Right dock
does not share a vertical boundary after the listing".

**Cause.** `nativePdfDockError` (`e2e-tauri/macos-pdf-preview.ts`) located the
listing/preview boundary from the native "Resize preview" splitter and assumed
the old 6px handle inside the dock: the PDF had to start within 2px of the
splitter's leading edge. #1925 made the handle a 10px hit strip on the dock that
reaches 3px past the edge (`--resize-outward`), so the splitter now starts 3px
before the PDF. The product layout was correct; the oracle encoded the old
handle box.

**Fix.** The oracle checks that the preview's near edge lies within the strip
(±2px) for Right/Top docks; a Bottom preview may still start below the strip
(its toolbar sits between). `tests/native/pdf-dock.test.ts` adds #1925-shaped
fixtures beside the recorded pre-#1925 ones.

**Rule.** A native geometry oracle that reads a resize handle's accessibility
frame is reading its hit area. When a handle's hit area changes, grep
`e2e-tauri/` for its label (`Resize preview`) as well as the browser specs.
