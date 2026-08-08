# Quick Open recursive-search debounce

Quick Open renders active-pane, recent, and frecency matches locally on every
keystroke. Its recursive filesystem search is a separate expensive boundary:
keep it behind `createQuickOpenSearchScheduler` so a rapid query sends only the
completed text to the backend. New input must invalidate the active stream
immediately; otherwise a deferred `target` or `node_modules` walk can continue
consuming CPU while the user types.
