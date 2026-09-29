# 711: Enter must confirm the typed address-bar path

Typing a complete directory path, waiting for the 150 ms autocomplete, then
pressing Enter used to replace the path with the first child suggestion and
leave the pane in its old directory. The existing browser test hid the dropdown
with Escape before Enter, so it missed the reported interaction.

`BreadcrumbAutocomplete` auto-selected suggestion index 0 whenever fetch
completed. Its Enter handler then called `applySuggestion` instead of
`confirm`. The failure depended on whether the debounce and directory listing
finished before the user's Enter, making it frequent under load.

Leave suggestions visible but unselected by default. Enter confirms the typed
path; Arrow keys or pointer movement select an item, and Tab still completes
the first suggestion. The browser regression waits for a visible dropdown,
presses Enter, and asserts the pane's resulting listing. It failed before the
fix and passes after it; a second case covers Tab completion followed by Enter.
