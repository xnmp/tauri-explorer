# ADR 0001: Native launcher process lifecycle

Status: Accepted

Governs: `src-tauri/src/system.rs`

## Context

Some system commands open an operating-system surface by spawning a short-lived
external launcher. Returning immediately keeps Tauri IPC responsive, but dropping
an unwaited child can leave a zombie on Unix and silent failures are otherwise
indistinguishable from a successful user action.

## Decision

The blocking backend command constructs and spawns the platform launcher. It logs
launch intent before the external-process boundary. A spawn failure is logged and
returned to IPC as an `AppError`; a successful spawn is logged with its process ID
and transfers ownership of the child to a background reaper, which waits exactly
once without blocking the Tauri command.

Because the IPC response cannot wait for a detached launcher's eventual exit, a
non-zero exit or wait failure is recorded as a warning rather than retroactively
changing the command result. Successful exit is debug-level lifecycle detail.

Launcher construction remains a side-effect-free seam so each target's executable
and arguments can be tested without opening a native surface.

## Consequences

- Callers receive immediate, synchronous spawn errors.
- Production logs identify launch attempts, successful process ownership transfer,
  and asynchronous launcher failures.
- Every successful child has one owner responsible for reaping it.
- New launcher commands governed by this module must follow the same policy.
