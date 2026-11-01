# Repository Git emblem must stay clear of the peek caret (#1477)

The repository-folder Git badge used to be a round badge pinned to the folder
icon's bottom-right corner. Tiles draws its folder-peek caret in exactly that
corner (`TilePanelsView` `.tile-caret`: 20px, starting 14px left / 17px up
from the icon's bottom-right), so the two overlapped.

The decoration is now an emblem on the folder body: a themed diamond plate
(`--icon-git-badge`) carrying an original branch glyph
(`--icon-git-badge-glyph`), horizontally centred on the folder. Its geometry is
the importable `repositoryEmblem(surface, size)` in
`domain/file-icon-identity.ts`, with one surface per renderer:

- `folder` — FolderIcon's 18-unit (small) and 48-unit (large) silhouettes;
- `catppuccin` — the 48-unit overlay on the sprite's outline folder (its body
  sits left/up of FolderIcon's, so it needs its own centre; `size` there is the
  rendered size and only thickens the glyph stroke at 16px);
- `thumbnail` — the photo folder's front flap, below the photos.

`TILE_CARET_INSET` mirrors the caret's CSS offsets. If the caret moves or the
smallest Tiles preset shrinks, `tests/components/repository-folder-emblem.test.ts`
checks every `THUMBNAIL_SIZE_CONFIG` preset against it; update the constant
together with `.tile-caret`.

The theme tokens keep their old names; the Hacker theme's darker terminal green
and Aurora's amber still apply. The e2e class names changed from
`.git-repo-badge*` to `.git-repo-emblem*`.
