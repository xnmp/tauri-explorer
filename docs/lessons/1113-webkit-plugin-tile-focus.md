# #1113: a plugin grid must accept the keys it owns

The single-file-tile E2E fixture mounted a standalone grid over the full app,
recorded ArrowDown and Enter, and asserted that focus stayed on the cell. It
never accepted those keys with `preventDefault()`. The SDK intentionally forwards
keyboard events unchanged; unhandled grid keys remain eligible for window
commands.

Enter therefore invoked `file.openSelected` for the underlying Explorer's
selected `Pictures/vacation` directory. Navigation later returned focus to
`vacation/beach.jpg`. Headless WebKit diagnostics showed both key events targeting
the plugin cell, the document retaining focus, and the later focus call coming
from FileList. The final focus assertion raced navigation completion; Chromium's
passing assertion did not establish that navigation had been avoided.

Make the fixture's grid accept ArrowDown and Enter, as the production FileTiles
collection does. Assert that the cell callback and grid receive uncancelled
events, retain the DOM focus assertion, and verify the visible breadcrumb stays
at Pictures. Do not change product focus routing or suppress unhandled grid keys:
`tests/state/window-keyboard.test.ts` deliberately covers their window fallback.
