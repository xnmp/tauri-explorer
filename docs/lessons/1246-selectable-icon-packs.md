# Selectable file icon packs

The original TypeScript path cut its letters out of a blue square. On a dark
tile, the letters therefore became dark too. The regression rasterizes the
actual rendered SVG and requires opaque white lettering; it failed before the
fix with zero white pixels. Both TS and JS now have rounded badge corners.

Pixel assertions must normalize screenshots with `scale: 'css'` before using
CSS bounding boxes or coordinates. Desktop Safari uses a Retina scale factor;
indexing its device pixels with CSS coordinates reports painted symbols as
missing. Measure category tint at tile size so thin glyphs retain solid pixels
after normalization. Split the pack matrix by color theme and view instead of
spending one test's timeout on every view.

Keep identity and paint-category resolution together in `resolveFileIcon`.
Resolving a new alias through one map and its color category through the old
extension map made `.mts`, `.jsonc` and `.bz2` inherit document tint instead of
their code/archive tint. Domain tests compare alias descriptors; browser tests
assert the painted colors with conflicting category overrides.

Icon preview belongs in `state/icon-theme.svelte.ts`, separately from persisted
settings. The shared picker cancels preview on every close path and commits
only on selection. Color themes publish an applied CSS revision: an ID alone
does not change when that theme's CSS is reloaded in place. Explicit icon-pack
choices override color-theme suggestions; Follow Color Theme resolves them.

Large folder previews bypass the plain file icon when photos arrive. They
must retain the selected pack's filled/outlined treatment and share the same
`FolderDecoration` with plain icons, or photo folders lose link/repository
identity. Cover both photo and imageless folders at large and extra-large
sizes, in addition to the compact/tile scaling contracts. Keep decorations in
the existing front SVG layer. Folder color remains `--icon-folder` even for
Minimal; using the file foreground can erase Git-badge contrast in Hacker.

Catppuccin artwork is vendored from a pinned official revision with its MIT
license, embedded in the generated sprite metadata so it also ships in the
production build. Define every CSS variable used by the selected assets; incomplete
palette wiring can leave individual icons blank while the common TS sample
still looks correct. Keep artwork/paint data in renderer modules and all
filename/extension policy in the framework-free domain layer.
