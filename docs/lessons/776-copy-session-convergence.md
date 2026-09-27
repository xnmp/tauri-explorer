# 776 — One production copy path

Paste and drop copies already used the ordered native copy session, while a
legacy singleton `copy_entry` command remained reachable only through a dead
boolean branch in `performFileTransfer`. Keeping both paths split conflict,
cancellation, history and recovery ownership without serving a live product
flow.

`performFileTransfer` now expresses its remaining job directly: plugin-driven
single-entry moves. Copy acceptance invokes `copy_entries`, including the
forced-overwrite recovery probe, and reads the first positional receipt. The
standalone command, frontend wrapper and mock command are gone; copy-session
worker primitives remain shared with native recovery and contract tests.

When retiring a mutation route, search production, probes, mocks, latency
fixtures and command registration together. A test-only mock command can keep
an IPC name apparently alive after every product caller has moved elsewhere.
