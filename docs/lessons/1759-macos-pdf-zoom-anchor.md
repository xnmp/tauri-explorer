# #1759 macOS Native UI lost its zoom anchor when #1756 hid window controls

The hosted-Mac PDF qualification measured application zoom from the tab
strip's `New tab` button. On macOS the tab strip shows a lone tab only while
the custom window controls hold the title row open; #1756 made those controls
never render on macOS, so with one tab the strip (and the anchor) disappeared
and `getLocation` failed on a missing element.

- Native qualification anchors must not depend on settings-gated chrome.
  Choose a control the fixture's own surface always renders.
- The PDF page buttons exist in every toolbar density with a fixed 28px CSS
  height; density changes only their width, so only the height ratio is a
  valid zoom measurement.
