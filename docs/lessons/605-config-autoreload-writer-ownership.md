# #605: config autoreload needs end-to-end ownership and watcher coverage

Config autoreload has two separate seams: the Rust filesystem watcher must
emit the config-relative filename after a real external write, and the
frontend store must decide whether the bytes belong to an external editor or
to one of its own writers.

Write activity is keyed by both filename and writer. A queued write from the
same writer must remain active while ownership hands from the first disk write
to the second; otherwise a delayed watcher read can re-adopt the first blob
and revert newer in-memory state.

Regression coverage should include a temporary-directory `notify` watcher
test for every newly reloadable filename, plus a store test that forces a
same-writer queued-write interleaving. Browser mocks alone cannot establish
that the OS watcher receives an external filesystem edit.
