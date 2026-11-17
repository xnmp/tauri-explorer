# #1732 — macOS 26 put the standalone folder icon on a grey tile

**Symptom (#1640):** on macOS 26 the Dock and Finder showed the app icon as a
shrunken folder on a grey squircle, while Linux/Windows showed the intended
standalone folder.

**Cause:** macOS 26 wraps legacy ICNS art that does not fill Apple's squircle
in a system tile. A transparent-cornered folder is exactly that.

**Fix:** `gen_icons.py` draws only `icon.icns` as an opaque "raised folder
squircle" (1024 canvas, 824 superellipse tile, n = 5, rim shaded from a height
field). Every other platform keeps the standalone folder. The tau is also
engraved (gradient + inner shadow) in `fill_tau.py` for all platforms.

**Gotchas:**

- Scale the folder by the *shorter* side of its alpha box. Fitting the width
  left the tab's top a few pixels inside the tile, and that sliver joined the
  notch and the top-left gap into one region.
- Find the notch as the largest uncovered component a few pixels *inside* the
  tile edge; labelling up to the edge lets antialiased folder pixels connect
  separate gaps.
- Continue faces into the chamfered corners from pixels eroded a few px inside
  the silhouette. Sampling the silhouette itself smears the art's darker
  outline into streaks, and the folder's own edge must be replaced there, or
  the chamfer stays visible as a seam.
- Drop the folder's soft drop shadow before compositing onto an opaque tile;
  it only smudges the gaps.
- Do not shrink the folder into a translucent margin: macOS ignores it when
  sizing. Icon Composer needs Xcode 26 `actool`, rejected as too heavy.
- `NSWorkspace.shared.icon(forFile:)` returns the generic icon for a relative
  path; verify with an absolute path on a throwaway `lsregister`ed app copy
  (see `src-tauri/icons/README.md`).
- Nothing on Linux can show what the Dock actually renders; the tests pin the
  geometry, not macOS's decision to skip the backing tile.
