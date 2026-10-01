# HTML web-document icons

HTML and HTM aliases must share a glyph, including uppercase extensions. The
HTML5 shield looks like an isolated numeral at file-list sizes; an outlined
document with code brackets remains recognizable in compact and tile layouts.

Render this glyph once in FileIcon before the icon-theme branches so material
fonts cannot reintroduce the shield and minimal icons retain the active code
colour. Keep neighboring file categories on their existing theme paths.

The browser contract uses actual file-list entries in Details/List/Tiles,
checks aliases, icon containment and neighboring type separation, and captures
selection/hover at light 100% and dark 150% zoom for all three icon themes. The
same test fails against the original component after fixtures are visible.
