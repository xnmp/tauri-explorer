# Repository Git badge polish

Repository roots are represented by `FileIcon.svelte` rather than a per-view
decoration, so a compact badge treatment applies consistently to Details, List,
and Tiles. Keep the badge and glyph on their existing theme CSS variables when
refining its SVG; hardcoded shading would break theme overrides.

The browser mock exposes `/home/user/my-project` as a repository root, making
it the appropriate rendered seam for regression coverage of this decoration.

Capture tiny SVG evidence with the browser context's `deviceScaleFactor` and
element screenshot `scale: "device"`. Temporarily changing root CSS zoom resizes
the pane and virtualizer: resetting zoom immediately before the next view switch
let the test calculate an empty-space click from stale row geometry, then deliver
it onto a file after layout settled. Keep layout unchanged across captures; use
`scale: "css"` for whole-page evidence that should retain its original dimensions.
