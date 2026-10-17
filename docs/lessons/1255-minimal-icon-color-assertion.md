# Assert glyph colors through the file-icon slot

A video tile can replace its placeholder SVG when thumbnail loading fails.
An asynchronous locator evaluation can then read an empty computed color from
the old node, although the attached placeholder and replacement are both gray.
The same tile also contains a separately colored video marker.

Assert the Minimal FileIcon color contract in Details view through `.icon svg`;
that slot excludes media overlays and folder carets. Retry the observable
nonempty, shared file foreground and distinct folder color together. Keep
thumbnail loading/failure and all-view coverage in their dedicated cases.
