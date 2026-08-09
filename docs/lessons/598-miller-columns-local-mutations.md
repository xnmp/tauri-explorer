# Miller columns and local file mutations

Miller columns keep a separate ancestor-directory cache. File operations that
act on an entry outside the active pane (for example, a Miller-column context
menu action) must publish the affected parent directory so that cache refreshes
immediately; waiting for a filesystem watcher leaves the source column stale.
