# Fullscreen preview in vertical docks (#592)

The preview pane's top and bottom dock modes supply their persisted size through
an inline `height`. Fullscreen styling must override that inline value with
`!important`, as it already does for the right dock's inline `width`; otherwise
the fixed fullscreen surface remains constrained to the docked height.

The browser regression test should assert the rendered fullscreen bounding box
against the viewport for both vertical dock positions and verify that leaving
fullscreen restores the original docked height.
