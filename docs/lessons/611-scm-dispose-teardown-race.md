# Teardown must own pane initial loads

`createWindowTabsManager` starts explorer directory loads without blocking pane
creation. Tests that dispose the manager must await those loads; otherwise their
diagnostic console output can reach Vitest after the worker RPC has closed.
Track the load promises at the manager boundary and await them from `dispose()`.
When multiple explorer cleanups run, settle every cleanup and every initial load
before rethrowing a cleanup failure; `Promise.all()` can otherwise let another
cleanup continue after teardown has already returned.
