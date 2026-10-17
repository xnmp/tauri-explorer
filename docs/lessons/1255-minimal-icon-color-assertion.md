# Assert glyph colors through the file-icon slot

A video tile can replace its placeholder SVG when thumbnail loading fails.
An asynchronous locator evaluation can then read an empty computed color from
the old node, although the attached placeholder and replacement are both gray.
The same tile also contains a separately colored video marker.

Assert both glyph sizes through their owned slots: `.icon svg` in Details and
the tile icon's SVGs excluding `.video-thumbnail-marker` descendants in Tiles.
These selectors exclude folder carets and media overlays. Retry the observable
nonempty, shared file foreground and distinct folder color together so a
placeholder replacement cannot produce a false failure.
