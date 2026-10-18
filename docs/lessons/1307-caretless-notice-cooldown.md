# #1307 — Avoid repeated caret-less Folder Peek advice

FileList emitted an info toast for every refused folder double-click, renewing its lifetime and replacing unrelated advice. The window-scoped Folder Peek state now admits this notice once per minute; suppressed gestures do not extend the cooldown. Keeping the timestamp outside mounted views preserves the limit across pane switches and retained-tab eviction. The notice still reads the current Open binding when it appears.

The browser regression failed before the fix because the second gesture created another toast. A direct count assertion matters here: retrying a zero-count assertion can wait until the unwanted toast expires and pass incorrectly. Fake-time state coverage checks the exact boundary and updated binding.
