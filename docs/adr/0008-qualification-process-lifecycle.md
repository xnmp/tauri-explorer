# ADR 0008: Qualification process lifecycle and artifact boundary

Status: Accepted

Governs: `e2e-tauri/native-qualification.ts`, `e2e-tauri/wdio.conf.ts`, `e2e-tauri/wdio.soak.conf.ts`, `e2e-tauri/soak/native-soak.spec.ts`, `scripts/run-native-soak.ts`, `scripts/qualify-macos-startup.ts`

## Context

Native qualification owns long-running application and WebDriver processes.
Unlike a detached operating-system launcher, a qualifier can only accept a
sample after observing the child through a bounded scenario and must prevent
one sample from contaminating the next. Node records signal termination in
`signalCode` while leaving `exitCode` null, so checking only the exit code can
misclassify a crashed or unreaped process as successful.

Qualification runs also turn a caller-provided replay seed into report, log,
and screenshot locations. The raw seed is evidence and must remain unchanged in
the JSON report, but it is not a safe filesystem component.

## Decision

The qualification runner owns every application or WebDriver child it starts
until the child emits its terminal event. It observes both process errors and
exit signals, clears polling and timeout work on every terminal path, and does
not accept a startup sample until all required markers are present and the
bounded survival interval completes.

Cleanup first requests graceful termination and waits for a bounded interval.
If the child remains alive, cleanup sends `SIGKILL` and waits for a second
bounded interval. A rejected force-kill or a child that remains alive after the
force timeout is a qualification failure; it propagates into the run's failed
JSON report and prevents later samples from starting. Process output is retained
even when cleanup fails. A successful `kill()` call alone never proves cleanup:
the terminal child event does.

WebdriverIO awaits `afterSession` hooks but does not make an ordinary hook
rejection determine the command exit status. The worker therefore records any
cleanup rejection in run-scoped temporary state created by `onPrepare`, and the
launcher consumes that state in `onComplete`. Launcher completion fails when a
marker exists and removes the temporary state afterward. The outer qualification
runner treats that nonzero or signalled subprocess outcome as authoritative: it
changes any previously emitted report to `passed: false`, appends the exit code
and signal to `runErrors`, and retains the scenarios and process log.

The runner tees child stdout and stderr into a run-specific log and references
that log from every failed report, including failures before a WebDriver session
exists. Scenario failures additionally retain their screenshot and available
driver artifacts.

Raw replay seeds remain in report configuration and scenario ordering. Any seed
used in a filename is converted to a bounded readable prefix plus a SHA-256
suffix. All resulting report, log, and screenshot directories are resolved
through a helper that rejects paths at or outside the configured qualification
root before removal or writing.

## Consequences

- A qualification report cannot pass while its owned application child is
  known or presumed to still be alive.
- Cleanup rejection, force-timeout, spawn, signal, and scenario failures remain
  reproducible through a failed report and process log.
- Replay input remains exact in JSON while hostile or unusual seed text cannot
  escape `qualification-results/` or collide through simple sanitization.
- Qualification-process changes to the governed files must preserve bounded
  ownership, reaping, evidence finalization, and artifact-root containment.
