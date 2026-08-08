# ADR 0001: Reap native launcher processes

Governs: `src-tauri/src/system.rs`

## Context

Opening operating-system surfaces such as Recycle Bin requires spawning a
platform launcher. On Unix, dropping an exited child without waiting can leave
a zombie process. Waiting on the IPC worker would unnecessarily delay the
caller and make the UI appear blocked.

## Decision

Launchers log their program and arguments before spawning. A successful spawn
is handed to a background reaper thread, which waits for the child without
blocking the Tauri command. Spawn failures are logged with the error and
returned to the IPC caller unchanged.

## Consequences

The UI can remain responsive while the operating system opens its own surface,
and production logs retain both launch intent and failure context. Launcher
commands must keep their command construction in a unit-testable seam so their
platform contract can be checked without opening a desktop UI during tests.
