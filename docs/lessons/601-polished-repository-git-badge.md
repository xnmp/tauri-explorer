# Repository Git badge polish

Repository roots are represented by `FileIcon.svelte` rather than a per-view
decoration, so a compact badge treatment applies consistently to Details, List,
and Tiles. Keep the badge and glyph on their existing theme CSS variables when
refining its SVG; hardcoded shading would break theme overrides.

The browser mock exposes `/home/user/my-project` as a repository root, making
it the appropriate rendered seam for regression coverage of this decoration.
