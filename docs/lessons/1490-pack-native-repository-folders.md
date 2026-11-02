# Repository folders follow each icon pack's special-folder idiom (#1490)

#1477 moved the Git decoration off the peek-caret corner as a diamond plate
centred on the folder body. Every pack drew the same plate, so on Material's
flat folders (and Catppuccin's/Minimal's outlines) it read as a foreign
sticker rather than part of the icon set.

Repository folders now look like the pack's own special folders:

- the **whole folder** takes `--icon-git-badge` (FolderIcon `color`,
  Catppuccin `--folder-tint`, photo-folder `--icon-folder` override);
- `repositoryFolderStyle(pack)` in `domain/file-icon-identity.ts` picks the
  glyph treatment: `filled` (Material, Classic) knocks an original branch
  glyph out of the solid folder in the window background
  (`--icon-git-badge-glyph`, falling back to `--background-solid`), so it
  contrasts with pastel accents on dark themes and dark accents on light
  themes without per-theme tuning; `outline` (Minimal, Catppuccin) strokes
  the glyph in the folder tint at the pack's stroke weight, with open ring
  nodes where the size allows;
- `repositoryEmblem(surface, size, style)` holds all geometry, and
  `repositoryEmblemBounds` its painted extent. Photo-folder flaps are only
  ~7 units tall, so the thumbnail glyph lies on its side (`rotate: -90`).

The theme tokens keep their names. The class `.git-repo-emblem` is now the
glyph group (one line path plus three node circles, unclassed to stay inside
the startup bundle budget); the `.git-repo-emblem-plate` rect is gone.

Bundle budget: this change landed with ~16 bytes of startup gzip headroom
(`bun run check:bundle`: 280,496 / 280,512). Gzip size moves non-monotonically
— inlining FolderIcon's tint derived *grew* the bundle by 42 bytes — so measure
each trim rather than assuming. Moving the node radius (`r = dot / unit`) into
the domain object and dropping per-node classes/data attributes is what fit.

Testing gotcha: Chromium's `getBoundingClientRect` for the stroked `<g>` is
noticeably larger than its painted glyph, which made the Tiles caret
disjointness check fail by a fraction of a pixel. The browser spec measures
the union of the node circles instead; the unit test checks every Tiles
preset against `TILE_CARET_INSET` through `repositoryEmblemBounds`.
