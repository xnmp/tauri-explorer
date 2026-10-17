# Application icon

`icon.png` is the canonical full-resolution artwork: the jade folder with an
enclosed, transparent Greek tau aperture approved in issue #1231. It refines the
#1000 artwork by filling the diagonal opening to the right of the tau with the
folder surface. The canonical PNG is the exact user-approved imagegen preview;
its SHA-256 is `7cc37847b569050f2a065f5309caee557b817a4f1828d8d3105d69399464ac89`.
`icon.svg` and `material-style.png` are historical artwork, not generator inputs.

From the repository root, after installing the locked Bun dependencies, run:

```sh
uv run src-tauri/icons/gen_icons.py
```

This regenerates the desktop PNG sizes, Windows Store logos, Android and iOS
assets, ICO, ICNS, and the application/showcase browser favicons. Tauri's generated
`icon.png` is intentionally discarded so the canonical artwork remains intact.

The existing Windows ICO enlargement and macOS alpha-bounds framing are retained.
Desktop assets preserve the aperture as alpha transparency; mobile backgrounds
follow [Tauri's platform conventions](https://v2.tauri.app/develop/icons/).
iOS AppIcon PNGs use RGB encoding without an alpha channel.
