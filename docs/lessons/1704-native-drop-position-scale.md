# #1704: native drag targets resolved at cursor ÷ scale on HiDPI displays

On a 4K monitor at Hyprland scale 1.25 (GTK3 rounds to scale 2), dragging a
file highlighted, spring-opened and dropped into a folder up and to the left of the
cursor, at about half its window coordinates. The ultrawide at scale 1 was
fine at any app zoom.

## Cause

`wry::DragDropEvent` positions are not in one space:

| Platform | Wry source | Unit |
| --- | --- | --- |
| Linux | GTK `drag-motion` / `drag-drop` widget coords | logical (CSS viewport) px |
| macOS | `draggingLocation` in view points | logical px |
| Windows | WebView2 client point | physical px |

Wry, Tauri and `native_file_drag::capture_at` all labelled them
`PhysicalPosition`, and the renderer (`adjustForHitTest`) divided every
platform by `devicePixelRatio` before `elementFromPoint`. That is right only
on Windows. The division dated from May (e8d90c61); it was not a #1656
regression.

## Fix

`native_file_drag` captures Wry's `NativePoint` and converts it to a
`ViewportPoint` once at emission (`native_pixels_per_css`: the window scale on
Windows, 1 elsewhere). The renderer hit-tests that position directly. Root CSS
zoom is not part of the conversion: all three engines hit-test viewport
coordinates under `documentElement.style.zoom`.

## Why nothing caught it

- Every native DnD run (CI `test:e2e:tauri:dnd`, the #1656 XTest check) used
  Xvfb at GTK scale 1, where dividing by DPR changes nothing.
- The native spec fed CSS pixels straight to XTest, so it could not have driven a
  scaled display correctly even if one had been configured.
- Three unit tests (`native-drop-target`, `file-drop-targets`,
  `plugin-file-drop`) asserted the division itself (`300,450` → `150,225` at
  DPR 2). They restated the implementation's assumption instead of the
  contract with the native layer.

`bun run test:e2e:tauri:dnd --scale=2` now runs the DnD contracts at GTK scale
2; the spec converts CSS to X pixels by `devicePixelRatio` and fails if the app
did not actually start at the requested scale. CI runs it after the scale-1
acceptance.

## Reproducing

Mirror the CI step (private Xvfb, `GDK_BACKEND=x11`, `dbus-run-session`,
`with-window-manager.sh`, private `XDG_*`) and add `--scale=2`. Before the fix
a `listing-move-details` hover logged `raw [306,155] dpr 2 adj [153,77.5]`,
which hit a sidebar bookmark instead of the Inbox row. App zoom (100% or 140%)
did not change the factor.
