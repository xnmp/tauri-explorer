# Plain text must not guess a syntax language (#1244)

`classifyPreview` correctly identified LICENSE and text/log files as text, but the content loader then passed every short text file to highlight.js auto-detection. Ordinary license words became keywords and numbers, creating arbitrary syntax colours.

Only filenames with an explicitly supported grammar now use syntax highlighting. Other text remains literal text in the theme's existing secondary text colour. This retains shell/config highlighting even when the file icon category is not code. Malformed CSV likewise falls back to readable literal text.

The pre-fix loader regression failed for LICENSE, notes.txt and output.log; the browser regression observed four highlight descendants in LICENSE. It now asserts literal text, no syntax spans and the computed theme colour.
