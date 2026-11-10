# #1553 — Windows app icon read oversized; tau was see-through

**Symptom (Windows, v1.23.0):** the app icon looked too large next to other
apps, and the tau showed whatever was behind it (black on a dark taskbar).

**Causes:**

- `gen_icons.py` zoomed every ICO frame by `ICO_CONTENT_SCALE = 1.11`, which
  stretched the folder to ~96% of each frame and clipped its edges at 256px.
- The #1231 artwork draws the tau as a transparent aperture, so it never had a
  colour of its own on any platform.

**Fix:** `ICO_CONTENT_SCALE = 1.0` (folder spans ~86% of the frame, near the
Windows 28/32 keyline). `src-tauri/icons/fill_tau.py` derives `icon.png` from
the preserved `icon-aperture.png` by filling the enclosed transparent component
(alpha < 128, not touching the border) with pale jade, compositing the folder's
antialiased rim over the fill and replacing the deep interior outright so
background-removal specks inside the aperture disappear.

**Gotchas:**

- Fill an image hole by compositing the source *over* the fill colour on a
  grown rim, not by replacing alpha < threshold pixels: the latter leaves a
  dark/transparent halo from the partially transparent edge pixels.
- Check any icon zoom at 256px: a scaled-and-cropped frame silently clips the
  folder silhouette.
- `tests/app-icon.test.ts` decodes the PNGs with `node:zlib` (no image
  dependency) and asserts no enclosed transparent region, the README SHA-256,
  and the ICO scale / 256px margin. Regenerate assets and update the README
  SHA together.
- Vitest's dependency optimizer fails with "Could not resolve 'node:module' …
  Tsconfig not found" when the checkout lives under a hidden directory such as
  `.claude/worktrees/`; run the suite from a copy at a non-hidden path.
