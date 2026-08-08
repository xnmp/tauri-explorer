# Copy path context-menu action

The existing **Copy** action writes file-list formats for paste operations; it
does not write a text value to the system clipboard. Use the browser clipboard
boundary for a path-string action and cover it with a browser test that reads
back the clipboard value.
