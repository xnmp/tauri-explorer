# Application icon

`icon.png` is the canonical full-resolution artwork: the jade folder with an
enclosed, **filled** pale-jade Greek tau (#1553). Its SHA-256 is
`79284d557d20e18dfc7a2044e34065e15b66cd97b0e3f0dd674d10983de9d605`.

It is derived by `fill_tau.py` from `icon-aperture.png`, the exact
user-approved imagegen preview from issue #1231 (SHA-256
`7cc37847b569050f2a065f5309caee557b817a4f1828d8d3105d69399464ac89`), in which
the tau is a transparent aperture. That artwork refined the #1000 design by
filling the diagonal opening to the right of the tau with the folder surface.
#1553 asked for the tau itself to be filled: as an aperture it showed whatever
lay behind the icon (black on dark taskbars). The script floods the enclosed
transparent region with a solid fill and composites the folder's antialiased
edge over it, so no halo remains. `icon.svg` and `material-style.png` are
historical artwork, not generator inputs.

From the repository root, after installing the locked Bun dependencies, run:

```sh
uv run src-tauri/icons/fill_tau.py   # only when icon-aperture.png or the fill changes
uv run src-tauri/icons/gen_icons.py
```

`gen_icons.py` regenerates the desktop PNG sizes, Windows Store logos, Android
and iOS assets, ICO, ICNS, and the application/showcase browser favicons.
Tauri's generated `icon.png` is intentionally discarded so the canonical
artwork remains intact.

The Windows ICO no longer enlarges the glyph (`ICO_CONTENT_SCALE = 1.0`, was
1.11): the zoom stretched the folder to ~96% of each frame, so it read
oversized on Windows (#1553). The folder now spans ~86% of the frame, close to
the Windows 28/32 icon keyline. The macOS alpha-bounds ICNS framing is
unchanged. Desktop assets keep alpha transparency outside the folder; mobile
backgrounds follow [Tauri's platform conventions](https://v2.tauri.app/develop/icons/).
iOS AppIcon PNGs use RGB encoding without an alpha channel.
`tests/app-icon.test.ts` checks the filled tau, this SHA-256, and the ICO
scale bounds.
