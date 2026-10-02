# #681 crop acceptance evidence

These are unedited screenshots of the real Tauri application on Linux/WebKitGTK,
captured on a private Xvfb display with Openbox and isolated D-Bus/XDG profiles.
The window is 1400 × 1000 at 100% app zoom. `provenance.json` records the exact
production source, native binary and image hashes. No host clipboard or desktop
interaction was used.

For PNG, JPEG, GIF, WebP, BMP, SVG and AVIF, each `native/<format>-selected-region.png`
shows the four independently adjustable boundaries of a 512 × 384 recognizable
fixture. The selected rectangle is left 32 / top 24 / right 480 / bottom 360: 448 × 336.
The corresponding `<format>-saved-copy.png` shows the actual saved copy selected
in the listing and open in Preview. Native tests decode filesystem bytes and
compare the result with the selected source pixels; lossless outputs are exact,
JPEG uses meaningful quadrant-transition geometry plus compression tolerance,
and SVG remains a vector document. Original source bytes remain unchanged.

`native/icns-selected-region.png` shows the selected 224 × 224 region and the
explicit retained 256 × 256 largest canvas explanation. `icns-saved-copy.png`
shows that actual icon file in Preview. Native decoding verifies its original
128 / 256 icon representations, centered 16-pixel transparent padding on the
largest canvas and unchanged source bytes. Preview's white background alone
cannot prove alpha; alpha is verified from saved pixels.

The three `<view>-confirm-replacement.png` images show explicit confirmation
before replacing an original in Details, List and Tiles. The paired
`<view>-replaced-original.png` images show the cropped preview and settled
1.4 KB size from the actual saved file (original 3.2 KB). Native tests verify
cancellation/Keep editing preserve source bytes and confirmed replacement
matches the exact selected 448 × 336 PNG pixels.

`native/changed-source-refused.png` shows a useful refusal after another writer
changes the captured source. Native tests verify no stale copy was published
and the other writer's bytes remain intact.

Verification: 12 real native UI/filesystem cases; 40 browser cases in Chromium
and WebKit across Details/List/Tiles, pane/fullscreen previews, 100 / 150% zoom,
fit/zoom/scroll/pointer geometry, numeric typing, accepted-save modal ownership
and keyboard access after resizing an open editor to 640 × 480. Separate native
save tests decode animated GIF/WebP/APNG/AVIF filesystem results and verify
frames/timing/looping. Static images do not demonstrate animated playback.
Windows/macOS codec CI and native platform UI are separate qualification.
