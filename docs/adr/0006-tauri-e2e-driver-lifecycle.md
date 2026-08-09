# ADR 0006: Tauri E2E driver lifecycle

Status: Accepted

Governs: `e2e-tauri/wdio.conf.ts`, `.github/workflows/e2e-tauri.yml`

## Context

The real-binary smoke suite launches `tauri-driver`, which in turn owns the
native WebDriver process and the Tauri application. A session-start failure can
otherwise leave the runner with no durable record of the driver transcript, or
consume the job-level timeout before GitHub Actions can upload diagnostics.

## Decision

- The WDIO worker owns the `tauri-driver` child it spawns. It pipes both child
  streams to the worker console and to a per-worker log file; it records spawn
  errors and closes that log only after the child exit event.
- Session teardown requests child termination. The child exit event is the
  single reaping observation and records its exit code or signal.
- Normal runs execute every smoke spec. A diagnostic environment may stop after
  the first failed session so its transcript is preserved rather than repeating
  the same failed handshake through the job cap.
- The workflow bounds the Windows smoke step at 15 minutes but gives the job a
  larger outer budget for checkout, dependency installation, build work, and
  the `always()` artifact upload. Build output and WDIO/driver logs are saved
  under `e2e-tauri/logs/` and uploaded after either success or failure.

## Consequences

Changes to driver spawn ownership, termination, stream handling, log flushing,
or timeout/failure behavior must keep a single worker owner and retain an
observable transcript. CI timeout changes must reserve job time for artifact
upload; a job-level timeout alone is not diagnostic evidence.
