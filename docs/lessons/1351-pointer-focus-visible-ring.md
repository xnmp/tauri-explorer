# #1351 — clicked rows drew the keyboard ring on macOS/Windows

Selected rows show an accent edge only; the full 2px ring is FileList's
`:focus-visible` keyboard indicator. #1338 mistook the macOS ring for intended
selection chrome and gave every selected row a full accent border; #1351
reverted that.

Root cause of the platform difference: macOS/Windows use the pointer-drag
backend, whose mousedown handler calls `preventDefault()`, so the engine does
not focus the clicked row and `FileList.handleClick` focuses it from script.
Script focus inherits `:focus-visible` when the previously focused element
matched it (any keyboard navigation earlier), so clicks drew the keyboard ring.
Linux (HTML5 drag) lets mousedown focus the row natively, which never matches.

Pointer-driven script focus passes `focusVisible: false`. E2E coverage opts a
spec into the pointer-drag path with a `MacIntel` `navigator.platform` init
script (the shared fixture's Linux pin is configurable for this); Windows would
also rewrite paths to backslashes, which the mock filesystem does not serve.
Playwright WebKit does not reproduce the inheritance, Chromium does.
