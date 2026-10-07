# Application icon

`icon.png` is the canonical full-resolution artwork: the selected jade folder
with a connected, transparent Greek tau aperture from issue #1000. The source
is the approved `02-tau-aperture-v2.png`, before the subsequent colour variations.
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
